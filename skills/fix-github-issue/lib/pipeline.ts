/**
 * The fix pipeline: one issue in, one terminal outcome out.
 *
 * A worker in its own lane produces a draft pull request; a reviewer with no shared context judges
 * it; a serial pull master decides whether that judgement still describes what would land and
 * merges it. Revision repeats until the issue's review budget is spent.
 *
 * Everything here takes the context as its first parameter, so two pipelines can run in one process
 * against two configurations without sharing a queue, a seat, or a run directory.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmClose, validateConfirmation } from '../../appraise-github-issues/lib/appraise.ts';
import { claim, keepClaimed, LeaseLostError, leaseLost, liveGate, trackerIo } from '../../carve-github-issue/lib/claims.ts';
import { agentCapMs, children, killAgent, killAgentsOn, logTail, readResult, renderPrompt, runAgent, SETSID } from './agent.ts';
import type { Context } from './context.ts';
import { CONFIRMATION_FILE } from './control-files.ts';
import { assertDistinctEngines, type Seat } from './engines.ts';
import { followBase } from './follow-base.ts';
import { attemptCount, closeIssue, type DlqPhase, ensureLabel, parkIssue, recordAttempt, recordReview, reviewCount, sendToDlq } from './labels.ts';
import { dirtyPaths, inFlight, removeWorktree, resetLane, updateFromBase, worktreeAtPullRequest, worktreeFor } from './lane.ts';
import { finishDespiteStop, isFinishing, isStopping, mutate, RunStopping, sh, stoppableSleep, yieldToStop } from './shell.ts';
import { behindBase, fetchBase, MAX_BASE_REFRESHES, matchesPath, staleAgainstBase } from './staleness.ts';

/**
 * How the pipeline finished with an issue, and why.
 *
 * `closed` is a verdict that ended the issue without code (already fixed, obsolete); `handed-off`
 * is one that needs a person (a product decision, access an agent lacks, work outside the band);
 * `parked` means a pull request exists and a human owns the next call.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

export type FixOutcome = {
  /** `not-run` is a dry run that reached a seat it does not run: nothing was tried, so nothing failed. */
  /**
   * `lease-lost` is not `busy`: `busy` says another run's claim was seen, and the driver places the
   * card for it; here this run's own lease ran out, who holds the issue now is not known, and the
   * card is no longer this run's to place.
   */
  /** `stopped` is a lane the operator's stop unwound: nothing about it was settled, and the next run takes it up. */
  outcome: 'merged' | 'parked' | 'handed-off' | 'closed' | 'dlq' | 'failed' | 'left-alone' | 'busy' | 'not-run' | 'stopped' | 'lease-lost';
  reason: string;
};

/** What the worker prompt asks for when the caller states no ceiling of its own. */
const DEFAULT_MAX_POINTS = 2;

export type Verdict =
  | 'already-fixed'
  | 'obsolete'
  | 'needs-decision'
  | 'needs-human'
  | 'out-of-band'
  | 'fixed'
  | 'answered'
  | 'failed';

export type WorkerResult = {
  issue: number;
  /** `not-run` is never the worker's own word: it is the driver's, for a worker a dry run did not run. */
  verdict: Verdict | 'not-run';
  points?: number;
  reason: string;
  /** For already-fixed and obsolete: the comment to post before closing, receipt included. */
  closeComment?: string;
  /** For answered: the spike's answers with their evidence, Markdown. */
  answer?: string;
  pr?: number;
  branch?: string;
  /** What the change touches, which decides whether autoMerge: 'code-only' will merge it. */
  touches?: Array<'code' | 'data' | 'migration' | 'stored-string' | 'ci'>;
};

export type ReviewResult = {
  pr: number;
  decision: 'merge' | 'gather-more' | 'block';
  adequacy: string;
  confidence: string;
  blocking: string[];
  /** The reviewer's own classification of the diff, unioned with the worker's before merging. */
  touches?: WorkerResult['touches'];
};

export type Issue = {
  number: number;
  title: string;
  createdAt: string;
  labels: Array<{ name: string }>;
  /** The tree fields; optional until every listing requests them. */
  parent?: { number: number } | null;
  subIssuesSummary?: { total: number; completed: number };
  blockedBy?: { nodes: Array<{ number: number; state: string; stateReason: string | null }> };
};

/**
 * The lane each issue was last moved to in this process: where a throw happened, which names its
 * queue. Keyed by repository and issue, since one process can drive more than one repository and
 * issue numbers repeat across them.
 */
const lastLane = new Map<string, string>();
const laneKeyOf = (ctx: Context, issue: number) => `${ctx.project?.repo ?? ''}#${issue}`;

/** The dead-letter queue that owns a failure in `lane`: the queue of the lane's phase, Work's for a lane with none. */
export function phaseOfLane(lane: string | undefined): DlqPhase {
  const phases: Record<string, DlqPhase> = { A: 'appraisal', C: 'carve', E: 'review', F: 'landing' };
  return phases[lane?.[0] ?? ''] ?? 'work';
}

/**
 * A lane settles nothing about an issue whose lease it has lost: another run may hold it, so a
 * count, a dead letter, a park, or a return to draft would be written over that run's work. Asked
 * after every seat returns, since a lost lease kills the seat's agent and the agent's exit is then
 * no verdict, and again inside each settlement as the backstop.
 */
function holdLease(ctx: Context, issue: number, before: string): void {
  // The same question has a second half: a stopping run acts on nothing either, save the record of
  // a merge already confirmed. Git's merges and pushes do not pass through mutate, so this is
  // where they are refused.
  if (isStopping() && !isFinishing()) throw new RunStopping(`the run is stopping; not begun: ${before}`);
  if (leaseLost(ctx, issue)) throw new LeaseLostError(`this run lost its lease on #${issue} before: ${before}`);
}

/**
 * Moves the issue's card on the driver's board, when there is one. A board write must never fail
 * a lane: the lane's facts are on the tracker, and the card is a projection of them.
 */
export function move(ctx: Context, issue: Issue, lane: string, note?: string): void {
  // A card is a projection of an issue this run holds. Without the lease the card is another
  // run's to place, and the lane this one remembers stays the last it placed with the lease.
  if (leaseLost(ctx, issue.number)) return;
  lastLane.set(laneKeyOf(ctx, issue.number), lane);
  if (!ctx.onLane) return;
  try {
    ctx.onLane({ issue: issue.number, title: issue.title, lane, note });
  } catch (error) {
    ctx.log(`#${issue.number}  board: ${(error as Error).message}`);
  }
}

/**
 * The command the worker runs to move its own card: the seat that does the work moves the card,
 * and the board then says what the agent is doing rather than what the driver last knew. The
 * board pointer and repository are rendered in, since a worktree may not carry the config.
 */
function cardCommand(ctx: Context, issue: number, lane: string): string {
  const card = join(HERE, '..', '..', 'burn-down-github-issues', 'card.ts');
  const pointer = join(ctx.runDir, 'board.json');
  // Single-quoted for the agent's shell: a checkout under a path with a space, or a repository
  // name with anything a shell reads as syntax, must arrive as one literal argument.
  const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return `bun run ${q(card)} --board ${q(pointer)} --repo ${q(ctx.project.repo)} --issue ${issue} --lane ${lane}`;
}

async function runWorker(
  ctx: Context,
  issue: Issue,
  cwd: string,
  maxPoints: number,
  feedback?: ReviewResult,
  /** True when nothing was rejected: the base moved beneath the proof and only the proof is owed. */
  reproof = false,
): Promise<WorkerResult> {
  const prompt = renderPrompt(ctx, 'triage-and-fix.md', {
    ISSUE: String(issue.number),
    TITLE: issue.title,
    MAX_POINTS: String(maxPoints),
    CARD_PROVING: cardCommand(ctx, issue.number, 'D2'),
    CARD_DRAFTED: cardCommand(ctx, issue.number, 'D3'),
    FEEDBACK: reproof && feedback
      ? `Nobody rejected your work. The base branch moved beneath your proof after you captured it, and the ` +
        `branch has been caught up for you. Start at Step 3: confirm the fix still holds on the current head, ` +
        `reacquire the receipts the movement reached, update the proof on the same pull request, and mark it ` +
        `ready. Change code only if the base's movement requires it.\n\n${JSON.stringify(feedback, null, 2)}`
      : feedback
        ? `A reviewer has already seen your pull request and asked for more. Address every blocking item, ` +
          `push to the same branch, and update the proof comment.\n\n${JSON.stringify(feedback, null, 2)}`
        : 'This is the first attempt at this issue.',
  });

  // The closest lane that can correct the card: stale proof goes back to Proving, a rejection to
  // Sent back, and only a first attempt starts at Coding.
  move(ctx, issue, reproof ? 'D2' : feedback ? 'D4' : 'D1', reproof ? 'reacquiring proof after the base moved' : feedback ? 'revision after a review' : undefined);
  // A revision is the exception: its lane holds the branch and the pull request under review, so a
  // reset would throw away work the reviewer already read. Only a first attempt may be reset.
  const { logPath, exitCode, notRun, timedOut } = await runAgent(
    ctx,
    reproof ? 'worker-reprove' : feedback ? 'worker-revise' : 'worker',
    issue.number,
    cwd,
    ctx.seats.worker,
    prompt,
    feedback ? undefined : () => resetLane(ctx, issue.number, cwd),
  );
  holdLease(ctx, issue.number, 'settle the worker');
  if (notRun) return { issue: issue.number, verdict: 'not-run', reason: 'dry run: the worker was not run' };
  if (exitCode !== 0) {
    return {
      issue: issue.number,
      verdict: 'failed',
      reason: timedOut
        ? `worker timed out at ${agentCapMs(ctx, 'worker') / 60000} minutes and was killed, so nothing it left in its lane is trusted; anything it had already pushed survives, and a redrive continues from that head rather than starting again; log ends: ${logTail(logPath)}`
        : `worker exited ${exitCode}, so its verdict is not trusted; anything it had already pushed survives, and a redrive continues from that head; log ends: ${logTail(logPath)}`,
    };
  }

  const result = readResult<WorkerResult>(cwd, 'loop-verdict.json');
  const KNOWN: WorkerResult['verdict'][] = ['already-fixed', 'obsolete', 'needs-decision', 'needs-human', 'out-of-band', 'fixed', 'answered', 'failed'];
  if (!result || !KNOWN.includes(result.verdict)) {
    return {
      issue: issue.number,
      verdict: 'failed',
      reason: result
        ? `worker verdict '${result.verdict}' is not one the driver knows; log ends: ${logTail(logPath)}`
        : `no verdict from the worker; log ends: ${logTail(logPath)}`,
    };
  }
  if (Number(result.issue) !== issue.number || typeof result.reason !== 'string') {
    return { issue: issue.number, verdict: 'failed', reason: `worker verdict names issue ${JSON.stringify(result.issue)} or has no reason; log ends: ${logTail(logPath)}` };
  }
  // A malformed classification must read as no classification, which fails closed at the merge
  // boundary; a bare string would otherwise spread into characters that match no risky kind.
  result.touches = validTouches(result.touches);
  // Out of band means "larger than the ceiling, on the scale"; anything else is a failed verdict,
  // or the worker could re-size an issue into the band it just refused.
  if (result.verdict === 'out-of-band') {
    const points = Number(result.points);
    if (!ctx.knobs.pointScale.includes(points) || points <= maxPoints) {
      return { issue: issue.number, verdict: 'failed', reason: `out-of-band with points ${result.points ?? 'unstated'}, which is not on the scale above ${maxPoints}; log ends: ${logTail(logPath)}` };
    }
  }
  if (result.verdict === 'answered' && typeof result.answer !== 'string') {
    return { issue: issue.number, verdict: 'failed', reason: `answered without an answer; log ends: ${logTail(logPath)}` };
  }
  return result;
}

/** The second engine on a worker's close: the appraiser's confirmer for a close, its own prompt for a spike's answer. */
async function confirmWorkerClose(ctx: Context, issue: Issue, result: WorkerResult, say: (message: string) => void): Promise<{ agree: boolean; reason: string } | null> {
  const confirmer = ctx.seats.confirmer ?? ctx.seats.reviewer;
  move(ctx, issue, 'A3', `a second engine re-checks the worker's ${result.verdict}`);
  if (result.verdict !== 'answered') {
    return confirmClose(ctx, issue, { verdict: result.verdict as 'already-fixed' | 'obsolete', reason: result.reason, closeComment: result.closeComment }, confirmer, say);
  }
  const cwd = join(ctx.runDir, `confirm-${issue.number}-${process.pid}`);
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  const prompt = renderPrompt(ctx, 'confirm-answer.md', { ISSUE: String(issue.number), TITLE: issue.title, WORKER_REASON: result.reason, ANSWER: result.answer ?? '' });
  const run = await runAgent(ctx, 'confirmer', issue.number, cwd, confirmer, prompt);
  holdLease(ctx, issue.number, 'settle the confirmer');
  if (run.exitCode !== 0) return null;
  const checked = validateConfirmation(readResult<unknown>(cwd, CONFIRMATION_FILE), issue.number);
  if (!checked.ok) {
    say(`confirmer's answer is unusable (${checked.why}); kept at ${cwd}`);
    return null;
  }
  rmSync(cwd, { recursive: true, force: true });
  return checked.result;
}

/** Hands a leaf to a person with both opinions on the thread. */
function parkWithBothOpinions(ctx: Context, issue: Issue, result: WorkerResult, confirmation: { reason: string }, say: (m: string) => void): FixOutcome {
  holdLease(ctx, issue.number, 'hand the issue to a person');
  const body = `The worker judged this \`${result.verdict}\` (${result.reason}); the second engine disagreed: ${confirmation.reason}. A person decides.`;
  mutate(ctx, `comment on #${issue.number}`, ['gh', 'issue', 'comment', String(issue.number), '--body', body]);
  mutate(ctx, `label #${issue.number} needs-human`, ['gh', 'issue', 'edit', String(issue.number), '--add-label', 'needs-human']);
  say('the second engine disputed the close; handed to a person');
  move(ctx, issue, 'H2', `close disputed: ${confirmation.reason}`.slice(0, 120));
  return { outcome: 'handed-off', reason: `close disputed: ${confirmation.reason}` };
}

async function runReviewer(
  ctx: Context,
  issue: number,
  pr: number,
  cwd: string,
  round: number,
): Promise<ReviewResult | null> {
  const prompt = renderPrompt(ctx, 'review.md', {
    PR: String(pr),
    ISSUE: String(issue),
    ROUND: String(round),
    MAX_ROUNDS: String(ctx.knobs.maxReviewRounds),
  });
  const { exitCode } = await runAgent(ctx, 'reviewer', issue, cwd, ctx.seats.reviewer, prompt);
  holdLease(ctx, issue, 'settle the reviewer');
  // A verdict from a process that failed is not a verdict; treating it as one is how a crashed
  // reviewer's parting words could approve a merge.
  if (exitCode !== 0) return null;
  const result = readResult<ReviewResult>(cwd, 'loop-review.json');
  if (!result) return null;
  // A verdict the driver acts on is validated, not trusted: an unknown decision must read as no
  // verdict at all, because anything that is not an explicit rejection would otherwise fall
  // through land() to the merge path. The PR number must also be the one under review.
  if (!['merge', 'gather-more', 'block'].includes(result.decision) || Number(result.pr) !== pr) {
    return null;
  }
  if (!Array.isArray(result.blocking) || result.blocking.some((b) => typeof b !== 'string')) return null;
  result.touches = validTouches(result.touches);
  return result;
}

const TOUCH_KINDS = ['code', 'data', 'migration', 'stored-string', 'ci'] as const;

/** The classification as written, or undefined when it is not a non-empty array of known kinds. */
function validTouches(raw: unknown): WorkerResult['touches'] {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  if (raw.some((t) => !TOUCH_KINDS.includes(t))) return undefined;
  return raw as WorkerResult['touches'];
}

/**
 * What the diff mechanically touches, computed from its paths against `project.touchPaths`.
 *
 * A classification that gates a merge must not rest on the author's self-report; a worker that
 * writes `["code"]` over a migration would otherwise sail through `code-only` on its own word.
 * Only `migration` and `ci` are path-shaped; `data` and `stored-string` name runtime effects a
 * path cannot reveal, so those remain self-reported by worker and reviewer.
 */
function computedTouches(ctx: Context, cwd: string): Array<'migration' | 'ci'> {
  const files = sh(ctx, ['git', 'diff', '--name-only', `${ctx.project.remote}/${ctx.project.baseBranch}...HEAD`], cwd)
    .split('\n')
    .filter(Boolean);
  const found: Array<'migration' | 'ci'> = [];
  for (const [kind, patterns] of Object.entries(ctx.project.touchPaths) as Array<['migration' | 'ci', string[]]>) {
    if (files.some((file) => patterns.some((pattern) => matchesPath(file, pattern)))) found.push(kind);
  }
  return found;
}

/**
 * The classification the merge decision actually uses: worker report, reviewer report, and the
 * computed paths, unioned, so an omission on any side can never widen what the loop may merge.
 *
 * Null when either agent did not classify at all, which fails closed downstream. An absent field
 * is not evidence of a code-only change (treating it as `[]` would let a migration through), and
 * the requirement is symmetric: for `data` and `stored-string` the path scan sees nothing, so the
 * reviewer's classification is the only independent check on the worker's, and a merge without it
 * would rest on one self-report.
 */
function effectiveTouches(
  ctx: Context,
  reported: WorkerResult['touches'],
  reviewed: WorkerResult['touches'],
  cwd: string,
): WorkerResult['touches'] | null {
  if (!reported || reported.length === 0) return null;
  if (!reviewed || reviewed.length === 0) return null;
  return [...new Set([...reported, ...reviewed, ...computedTouches(ctx, cwd)])];
}

/** Whether the loop may merge this itself. Fails closed on a missing classification. */
function mergeAllowed(ctx: Context, touches: WorkerResult['touches'] | null): boolean {
  if (ctx.knobs.autoMerge === 'never') return false;
  if (ctx.knobs.autoMerge === 'always') return true;
  if (!touches || touches.length === 0) return false;
  const risky = ['data', 'migration', 'stored-string', 'ci'];
  return !touches.some((t) => risky.includes(t));
}

/**
 * Confirms the pull request the driver is about to merge is the one that was reviewed.
 *
 * The worker reports its own PR number, and `gh pr merge` acts on whatever that PR's head is at the
 * moment it runs. Without this, a number pointing at an unrelated pull request, or a push landing
 * after the review, merges something no reviewer ever read.
 */
async function pullRequestMatchesReview(
  ctx: Context,
  pr: number,
  issue: number,
  cwd: string,
  reviewedSha: string,
): Promise<string | null> {
  type View = { headRefOid: string; baseRefName: string; headRefName: string; state: string };
  const read = (): View => JSON.parse(sh(ctx, ['gh', 'pr', 'view', String(pr), '--json', 'headRefOid,baseRefName,headRefName,state']));
  const localHead = sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);
  let view = read();
  // A catch-up has just pushed this head, and the pull request's head can trail the push by a few
  // seconds. When the worktree already holds the expected commit, wait for GitHub to agree before
  // calling it a mismatch; a wrong head stays wrong after the wait.
  // Awaited, not slept through: other lanes' output, timeouts, and lease renewals run meanwhile.
  for (let tries = 0; view.headRefOid !== reviewedSha && localHead === reviewedSha && tries < 6; tries++) {
    await Bun.sleep(5_000);
    view = read();
  }

  if (view.state !== 'OPEN') return `pull request is ${view.state}`;
  if (view.baseRefName !== ctx.project.baseBranch) return `targets ${view.baseRefName}, not ${ctx.project.baseBranch}`;
  if (!new RegExp(`(?:^|[^0-9])${issue}(?:[^0-9]|$)`).test(view.headRefName)) {
    return `branch ${view.headRefName} does not name issue ${issue}`;
  }
  if (view.headRefOid !== reviewedSha) return `head ${view.headRefOid.slice(0, 9)} is not the reviewed commit`;
  if (view.headRefOid !== localHead) return 'remote head and worktree head disagree';
  if (dirtyPaths(ctx, cwd).length > 0) return 'worktree has uncommitted changes';
  return null;
}

/** Whether a pull request is still a draft, which is the worker saying the work is unfinished. */
function isDraft(ctx: Context, pr: number): boolean {
  return sh(ctx, ['gh', 'pr', 'view', String(pr), '--json', 'isDraft', '--jq', '.isDraft']) === 'true';
}

/**
 * The build gate: block until the pull request's checks are green, or say why they never will be.
 * Returns null when every check passed (or the repository runs none), otherwise a refusal reason.
 * Unknown states fail closed; a merge with a failing, unfinished, or never-run build is never allowed:
 * a required check that was only skipped or cancelled has reached no verdict, and is waited on.
 */
/**
 * Waits for the checks of `expect.sha`, the head that would land. Checks register one at a time
 * after a push, so an observation of the list is never proof of the whole list: neither an empty
 * list, nor a short green one, nor one that has stopped changing. What "all of them" means has to
 * come from somewhere that is not this moment's view. The rules, all of which fail closed:
 *
 * - The expected checks are named: by `requiredChecks` in the config, or else by the checks the
 *   reviewed head carried, which had the length of a review to register. With neither, nothing
 *   says what complete looks like and the landing is refused by name. Only `checks: 'none'` says
 *   the repository runs no checks on a pull request.
 * - Every expected check must be present and green on the landing head, every other check present
 *   must be green too, and no check suite GitHub has opened on the head may be incomplete. Suite
 *   data that cannot be read is waited on, never assumed complete.
 */
/**
 * The names of the checks and statuses a commit carries. For the reviewed head this is the
 * expected set of a landing: it had the length of a review to register all of them.
 */
function checksOn(ctx: Context, sha: string): { names: string[]; passed: string[] } {
  // One object to a line, since a head can carry more check runs than one page holds and a page
  // apiece of JSON arrays is not one JSON document.
  const lines = (argv: string[]) =>
    sh(ctx, argv)
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { name: string; verdict: string | null });
  const runs = lines(['gh', 'api', `repos/${ctx.project.repo}/commits/${sha}/check-runs?per_page=100`, '--paginate', '--jq', '.check_runs[] | {name, verdict: .conclusion}']);
  const statuses = lines(['gh', 'api', `repos/${ctx.project.repo}/commits/${sha}/statuses?per_page=100`, '--paginate', '--jq', '.[] | {name: .context, verdict: .state}']);
  const all = [...runs, ...statuses];
  // Which of them had passed there is kept too: a check that passed for the reviewer and is only
  // skipped on the head that would land has stopped running, which a job skipped by design never did.
  const passed = all.filter((c) => c.verdict === 'success' || c.verdict === 'neutral').map((c) => c.name);
  return { names: [...new Set(all.map((c) => c.name))], passed: [...new Set(passed)] };
}

/** The status checks the base branch's protection requires; none when the branch has no such rule. */
function requiredStatusChecks(ctx: Context): string[] {
  try {
    return JSON.parse(sh(ctx, ['gh', 'api', `repos/${ctx.project.repo}/branches/${ctx.project.baseBranch}/protection/required_status_checks`, '--jq', '[.contexts[]?, .checks[]?.context] | unique'], ctx.repoRoot, 1)) as string[];
  } catch {
    return []; // no protection, or no right to read it: either way nothing here names a check
  }
}

export async function awaitGreenChecks(
  ctx: Context,
  pr: number,
  say: (message: string) => void,
  expect?: { sha: string; names?: string[]; passedAtReview?: string[]; required?: string[] },
  /** The tracker read and the wait, replaceable so a test neither shells out nor sleeps. */
  io: { read: (argv: string[]) => string; sleep: (ms: number) => Promise<void>; now: () => number } = { read: (argv) => sh(ctx, argv), sleep: (ms) => Bun.sleep(ms), now: () => Date.now() },
): Promise<string | null> {
  type CheckNode = { name?: string; context?: string; status?: string; conclusion?: string; state?: string };
  // A check that ran and was satisfied. SKIPPED and CANCELLED are neither this nor a failure: no
  // verdict was reached, and a name whose every node is one of those has not been checked at all.
  const PASSED = new Set(['SUCCESS', 'NEUTRAL']);
  const RUNNING = new Set(['PENDING', 'EXPECTED', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'REQUESTED']);
  // GitHub renders an unfinished CheckRun with conclusion "" (empty string, not null), so a
  // nullish coalesce would read "" as a verdict and fail-close a merely-running check.
  const classify = (c: CheckNode): 'passed' | 'skipped' | 'cancelled' | 'pending' | 'failed' => {
    const verdict = c.conclusion || c.state || c.status || null;
    if (verdict === null || RUNNING.has(verdict)) return 'pending';
    if (PASSED.has(verdict)) return 'passed';
    if (verdict === 'SKIPPED') return 'skipped';
    // A cancelled run was superseded or stopped, often by the repository's own concurrency rule when
    // a draft is marked ready; it says nothing about the change, so it is waited out, not refused.
    if (verdict === 'CANCELLED') return 'cancelled';
    return 'failed';
  };
  const nameOf = (c: CheckNode) => c.name ?? c.context ?? 'unnamed check';

  const deadline = io.now() + ctx.knobs.checksTimeoutMinutes * 60_000;
  const wait = async (why: string, ms: number): Promise<string | null> => {
    const left = deadline - io.now();
    if (left <= 0) return `${why}, after ${ctx.knobs.checksTimeoutMinutes} minutes`;
    say(`${why}; waiting`);
    // Slept a second at a time: a stop must unwind this lane, and release its claim, well inside
    // the time the signal handler waits, not at the end of a thirty second nap or a checks timeout.
    await stoppableSleep(Math.min(ms, left), io.sleep);
    return null;
  };
  type Suite = { app: string; runs: number };
  /** Suites GitHub has opened on the head that are not complete; null when they cannot be read. */
  const openSuites = (sha: string): Suite[] | null => {
    try {
      // Every page, one object to a line: first the page's own tally, then its open suites. A head
      // can carry more suites than one page holds, and a read that stops short must not look like
      // a head with nothing open, so the suites seen have to add up to the total GitHub reports.
      const jq = '{total: .total_count, seen: (.check_suites | length)}, (.check_suites[] | select(.status != "completed") | {app: (.app.slug // "unknown app"), runs: .latest_check_runs_count})';
      const lines = io.read(['gh', 'api', '--paginate', `repos/${ctx.project.repo}/commits/${sha}/check-suites?per_page=100`, '--jq', jq]).split('\n').filter((line) => line.trim() !== '');
      const rows = lines.map((line) => JSON.parse(line) as Partial<Suite> & { total?: number; seen?: number });
      const pages = rows.filter((row) => row.total !== undefined || row.seen !== undefined);
      const suites = rows.filter((row) => !pages.includes(row));
      const whole = pages.length > 0 && pages.every((page) => Number.isFinite(page.total) && Number.isFinite(page.seen) && page.total === pages[0].total) && pages.reduce((sum, page) => sum + (page.seen ?? 0), 0) === pages[0].total;
      return whole && suites.every((s) => typeof s.app === 'string' && Number.isFinite(s.runs)) ? (suites as Suite[]) : null;
    } catch {
      return null;
    }
  };
  // GitHub opens a suite for every installed app on every push, and an app that runs nothing here
  // leaves its suite queued with no run in it for ever. Which apps those are is written down, like
  // the checks: no age says a first run is not still on its way. The list is a person's word that
  // the app runs nothing here, not a detection; a first run that registers after the landing has
  // passed is not seen. While the gate still waits, a listed app's suite holds once it has a run.
  const idleApps = new Set(ctx.knobs.idleCheckSuiteApps ?? []);
  const holds = (suite: Suite) => suite.runs > 0 || !idleApps.has(suite.app);
  const passedOver = new Set<string>();
  // The authority on what complete looks like is a list somebody wrote down: the config's, or the
  // base branch's required status checks. What the reviewed head happened to carry is added to it
  // but cannot stand in for it, since a fast review sees a partly registered list too.
  const authoritative = [...new Set([...(ctx.knobs.requiredChecks ?? []), ...(expect?.required ?? [])])];
  if (expect && ctx.knobs.checks !== 'none' && authoritative.length === 0) {
    return `nothing names the checks this landing must pass: the config lists no requiredChecks and ${ctx.project.baseBranch} requires no status checks (a repository that runs no checks says so with checks: 'none')`;
  }
  const expected = [...new Set([...authoritative, ...(expect?.names ?? [])])];
  for (;;) {
    const raw = io.read(['gh', 'pr', 'view', String(pr), '--json', 'statusCheckRollup,headRefOid']);
    const view = JSON.parse(raw) as { statusCheckRollup: CheckNode[] | null; headRefOid: string };
    const rollup: CheckNode[] = view.statusCheckRollup ?? [];
    if (expect && view.headRefOid !== expect.sha) {
      const gaveUp = await wait('the pull request does not show the landing head yet', 15_000);
      if (gaveUp) return gaveUp;
      continue;
    }
    if (rollup.length === 0 && (ctx.knobs.checks === 'none' || !expect)) return null;

    const failed = rollup.filter((c) => classify(c) === 'failed');
    if (failed.length > 0) {
      return `checks failed: ${failed.map((c) => `${nameOf(c)} (${c.conclusion || c.state || c.status})`).join(', ')}`;
    }

    const pending = rollup.filter((c) => classify(c) === 'pending');
    if (pending.length > 0) {
      const gaveUp = await wait(`checks still unfinished: ${pending.map(nameOf).join(', ')}`, 30_000);
      if (gaveUp) return gaveUp;
      continue;
    }

    // A head can carry several nodes under one name: a run the repository cancelled, the skipped
    // jobs of a run made while the pull request was a draft, and the run that counts. Judged by
    // name, then: a name passes on a node that passed. A name somebody expects is not satisfied by
    // being skipped, or a landing could merge with no check having run; a cancelled node with no
    // passing sibling has no verdict either. Which names must have run: the written list, the
    // config's and the base branch's, and every check that had passed on the head the reviewer read.
    // Not every name that head carried: a repository can have jobs skipped on every pull request by
    // design (a release, a deploy on push), those were skipped at review too, and waiting for them
    // to pass would hold every landing to the timeout. A check that passed at review and is only
    // skipped now is the other case: it stopped running, and the approval counted on it.
    const mustRun = new Set([...authoritative, ...(expect?.passedAtReview ?? [])]);
    const byName = new Map<string, Array<ReturnType<typeof classify>>>();
    for (const c of rollup) byName.set(nameOf(c), [...(byName.get(nameOf(c)) ?? []), classify(c)]);
    const unjudged = [...byName.entries()]
      .filter(([name, kinds]) => !kinds.includes('passed') && (kinds.includes('cancelled') || mustRun.has(name)))
      .map(([name, kinds]) => `${name} (${[...new Set(kinds)].join(' and ')})`);
    if (unjudged.length > 0) {
      const gaveUp = await wait(`no check has reached a verdict under: ${unjudged.join(', ')}`, 30_000);
      if (gaveUp) return gaveUp;
      continue;
    }

    // Everything visible has passed. It is the whole list only when every expected check is in it
    // and nothing GitHub has opened on this head is still running or still to register.
    if (!expect) return null;
    const present = new Set(rollup.map(nameOf));
    const missing = expected.filter((name) => !present.has(name));
    if (missing.length > 0) {
      const gaveUp = await wait(`expected check(s) have not registered on the landing head: ${missing.join(', ')}`, 15_000);
      if (gaveUp) return gaveUp;
      continue;
    }
    const open = openSuites(expect.sha);
    const holding = open?.filter(holds) ?? [];
    for (const suite of open ?? []) {
      if (holds(suite) || passedOver.has(suite.app)) continue;
      passedOver.add(suite.app);
      say(`the ${suite.app} check suite is open with no run in it, and the config lists ${suite.app} in idleCheckSuiteApps; not waiting on it`);
    }
    if (open !== null && holding.length === 0) return null;
    const gaveUp = await wait(open === null ? 'the check suites of the landing head cannot be read' : `check suite(s) on the landing head have not finished: ${holding.map((suite) => (suite.runs > 0 ? suite.app : `${suite.app} (no run in it; an app that runs nothing here belongs in idleCheckSuiteApps)`)).join(', ')}`, 15_000);
    if (gaveUp) return gaveUp;
  }
}

/**
 * The base commit a merge landed on, when it is not the one this lane last fetched; null when the
 * merge landed on the base the lane held, or when it cannot be told (which is logged, not guessed).
 */
function landedOnUnseenBase(ctx: Context, pr: number, seen: string, say: (message: string) => void): string | null {
  try {
    const mergeCommit = sh(ctx, ['gh', 'pr', 'view', String(pr), '--json', 'mergeCommit', '--jq', '.mergeCommit.oid']);
    const landedOn = sh(ctx, ['gh', 'api', `repos/${ctx.project.repo}/commits/${mergeCommit}`, '--jq', '.parents[0].sha']);
    if (!landedOn || landedOn === seen) return null;
    say(`merged onto ${landedOn.slice(0, 10)}, but this lane last saw ${ctx.project.baseBranch} at ${seen.slice(0, 10)}: something else landed in between, and the combination is unverified`);
    return landedOn;
  } catch (error) {
    say(`could not tell which base commit the merge landed on: ${(error as Error).message.split('\n')[0]}`);
    return null;
  }
}

/**
 * The integration queue: the pull master.
 *
 * Coding is the concurrent part of this loop. Everything downstream of "I think this is done" is
 * sequential, one branch at a time, because the base branch is shared and a review is only good for
 * the commit it read. Bringing a branch up to date, reviewing it, and merging it all happen inside
 * this queue, so nothing can move the branch or the base between the read and the merge.
 */

export function serializePullMaster<T>(ctx: Context, issue: Issue, say: (message: string) => void, action: () => Promise<T>): Promise<T> {
  // A landing can wait on checks for as long as the timeout, and the lanes behind it are silent
  // meanwhile; each says once whom it is waiting behind, on the console and on its card.
  // A place in the line is taken at once, not when the turn comes, so two lanes that join in the
  // same tick still see each other.
  const line = (ctx.landingLine ??= []);
  const holder = line[0];
  line.push(issue.number);
  if (holder !== undefined) {
    say(`waiting for the landing line behind #${holder}`);
    // The note goes on the card where it already is: a rejected review queues here too, and it
    // is not Approved. A card this pipeline never placed is left to the driver.
    const lane = lastLane.get(laneKeyOf(ctx, issue.number));
    if (lane) move(ctx, issue, lane, `waiting for the landing line behind #${holder}`);
  }
  const held = async () => {
    try {
      // The wait for the line can outlast a lease; what was true when the lane joined is asked again.
      holdLease(ctx, issue.number, 'take its turn in the landing line');
      return await action();
    } finally {
      line.splice(line.indexOf(issue.number), 1);
    }
  };
  const next = ctx.integrationQueue.then(held, held);
  ctx.integrationQueue = next.catch(() => undefined);
  return next;
}

/**
 * Upstream is more correct until this work is merged. No seat begins on a lane that lacks the
 * current base: not a revision, not a review, not a merge. A lane that is behind at all merges the
 * base in (never a rebase) and pushes; what that costs is decided separately, by whether the
 * movement reached the paths the proof or the approval covers.
 *
 * `since` is the commit the standing proof or verdict was pinned to. Returns null when the lane
 * already holds the base; `conflict` when the merge could not apply, which the pipeline never
 * resolves itself; otherwise the head before and after, and the overlap: the incoming files
 * inside the import closure of this work, or a global invalidator. An empty overlap means the
 * world did not move beneath the proof; a non-empty one means it did.
 */
type CaughtUp = { before: string; after: string; overlap: string[]; netChangeIntact: boolean };

function netChangeId(cwd: string, baseSha: string, head: string): string {
  // The branch's own change against the base it contains, as a patch id: stable across a merge
  // that brought in only files this work does not touch. Two argument-array processes, no shell:
  // a configured ref is data and must never be read as syntax.
  const diff = Bun.spawnSync(['git', 'diff', `${baseSha}...${head}`], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (diff.exitCode !== 0) return '';
  const id = Bun.spawnSync(['git', 'patch-id', '--stable'], { cwd, stdin: diff.stdout, stdout: 'pipe', stderr: 'pipe' });
  return id.stdout.toString().trim().split(/\s+/)[0] ?? '';
}

function catchUp(ctx: Context, issue: Issue, cwd: string, since: string, say: (message: string) => void, why: string): CaughtUp | 'conflict' | null {
  // A catch-up merges the base in and pushes the lane's branch; every wait in a landing can
  // outlast the lease, so every catch-up asks for it first.
  holdLease(ctx, issue.number, `catch up ${why}`);
  if (ctx.dryRun) return null;
  // One fetch, one commit: the behind check, the overlap, the contribution comparison, and the
  // merge all use this base. A base that moves again meanwhile is the next catch-up's business.
  const baseSha = fetchBase(ctx, cwd);
  const behind = behindBase(ctx, cwd, baseSha);
  if (behind.length === 0) return null;
  // Both judged before the merge: afterwards the merge base is the base's own tip and every
  // comparison against it is vacuously empty.
  const overlap = staleAgainstBase(ctx, cwd, since, baseSha);
  const before = sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);
  const idBefore = netChangeId(cwd, baseSha, before);
  say(`the base moved (${behind.slice(0, 3).join(', ')}${behind.length > 3 ? `, and ${behind.length - 3} more` : ''}); catching up ${why}`);
  move(ctx, issue, 'F2', `catching up ${why}`);
  if (!updateFromBase(ctx, cwd, baseSha)) return 'conflict';
  const after = sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);
  const idAfter = netChangeId(cwd, baseSha, after);
  return { before, after, overlap, netChangeIntact: idBefore !== '' && idBefore === idAfter };
}

export type Reviewed = { review: ReviewResult; reviewedSha: string };
/** A review that produced no trusted verdict says which dead-letter queue owns the reason. */
export type DeadLetter = { dlq: DlqPhase; reason: string };
/**
 * `park` hands the landing to a person (the merge boundary, or the issue changed under the review);
 * `dlq` is a landing the machine could not complete (a conflict, red checks, a failed smoke, a
 * refused line, an unreported merge), which the landing queue's triage may retry.
 */
export type Landing = 'merged' | 'revise' | 'stale' | { park: string } | { dlq: string };

/** How long the smoke command may run before the pull request parks as unbootable. */

/**
 * Judge one branch. Runs outside the queue, so reviews overlap.
 *
 * This performs no git writes and no merge. It reads the tree as it stands, records the commit it
 * read, and returns the verdict; whether that verdict still applies at merge time is the pull
 * master's question, not this one's. Keeping review out of the serial section is what stops one
 * long review from holding up every other lane behind it.
 */
async function review(
  ctx: Context,
  issue: Issue,
  pr: number,
  cwd: string,
  say: (message: string) => void,
  round: number,
): Promise<Reviewed | DeadLetter> {
  // A draft is the worker's own statement that the work is not finished. Reviewing one wastes the
  // review and, worse, can approve a branch the worker still intends to push to.
  if (isDraft(ctx, pr)) {
    say('worker left the pull request in draft; treating it as incomplete');
    move(ctx, issue, 'D3', `PR #${pr} left in draft`);
    return { dlq: 'work', reason: `The worker reported a fix but left pull request #${pr} in draft, which is its own statement that the work is not finished.` };
  }

  // A dirty tree means checks run against files that are not in the pull request: a worker's
  // uncommitted edit could make the reviewer's re-run pass while the clean remote commit fails.
  const dirty = dirtyPaths(ctx, cwd);
  if (dirty.length > 0) {
    say('worktree has uncommitted changes; a review here would judge code that is not in the pull request');
    return { dlq: 'work', reason: `The worker left uncommitted changes in its worktree (${dirty.slice(0, 5).join(', ')}), so a review would judge code that is not in pull request #${pr}.` };
  }

  const reviewedSha = sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);
  move(ctx, issue, 'E2', `round ${round}, PR #${pr} at ${reviewedSha.slice(0, 10)}`);
  const verdict = await runReviewer(ctx, issue.number, pr, cwd, round);
  if (!verdict) {
    say('reviewer wrote no verdict');
    return { dlq: 'review', reason: `The reviewer produced no trusted verdict on pull request #${pr} at ${reviewedSha.slice(0, 10)}.` };
  }
  // A verdict that is not merge is explained by what blocks it, not by how good the evidence was.
  const why = verdict.decision !== 'merge' && verdict.blocking.length > 0 ? verdict.blocking.join(' | ') : verdict.adequacy;
  say(`review: ${verdict.decision}; ${why}`);
  if (verdict.decision === 'merge') move(ctx, issue, 'F1', `approved at ${reviewedSha.slice(0, 10)}`);
  return { review: verdict, reviewedSha };
}

/**
 * The pull master's turn: decide whether a finished review still applies, and if it does, merge.
 *
 * Exactly one of these runs at a time, because the base branch is shared. It holds no agent and
 * spawns none, so the serial section is short by construction.
 *
 * Freshness is judged against the reviewed commit rather than the current head. A branch that is
 * merely behind is left alone; per the freshness rule a receipt is true as of the commit it was
 * captured at, so upstream movement that does not reach this work leaves it standing. Movement that
 * does reach it invalidates the proof, so the branch catches up and is judged again.
 */
async function land(
  ctx: Context,
  issue: Issue,
  pr: number,
  touches: WorkerResult['touches'],
  reviewed: Reviewed,
  cwd: string,
  say: (message: string) => void,
  ceiling: number = DEFAULT_MAX_POINTS,
  /** False when a rejection here would spend the issue's last review round. */
  revisionFollows = true,
): Promise<Landing> {
  const { review: verdict, reviewedSha } = reviewed;

  // Rejections are judged before freshness, because staleness invalidates an approval and not a
  // rejection. A proof is pinned to the commit it was captured at, so movement into that commit can
  // make an approval describe something other than what would land; a rejection names a gap in the
  // work, and the base moving does not fill it. Re-reviewing one just re-derives it: the branch blocks,
  // catches up, and blocks again for the same reason.
  //
  // `gather-more` says the evidence is short; `block` says the change is. Both spend a round, both
  // go back to the author, and the per-issue budget bounds the retries with the DLQ underneath.
  if (verdict.decision === 'block' || verdict.decision === 'gather-more') {
    // The rejection that spends the last round is followed by no revision: the pull request stays
    // ready for the person who reads the dead letter, and nothing is caught up for nobody.
    if (!revisionFollows) return 'revise';
    // Back to draft before anything is pushed: the catch-up below and the revision pushes that
    // follow must not each spend a CI run on a pull request still marked ready.
    mutate(ctx, `return PR #${pr} to draft for revision`, ['gh', 'pr', 'ready', String(pr), '--undo']);
    // A revision never begins on a stale lane: whatever the base changed, the author revises
    // against current code rather than against the base as it stood when this branch started.
    if (catchUp(ctx, issue, cwd, reviewedSha, say, 'before the revision') === 'conflict') {
      // A dead letter must not sit in draft: the person reading it would find a branch the CI
      // guard is configured to skip, and nothing else would ever flip it back.
      mutate(ctx, `mark PR #${pr} ready again before the dead letter`, ['gh', 'pr', 'ready', String(pr)]);
      say(`conflicts with ${ctx.project.baseBranch}; a human has to resolve it`);
      return { dlq: `the branch conflicts with ${ctx.project.baseBranch}` };
    }
    return 'revise';
  }

  // From here the verdict is `merge`. Nothing lands that lacks the current base: a lane behind at
  // all merges the base in first, and what lands is a head that contains everything upstream has.
  // Whether the approval survives that is the freshness question. Movement inside the work's
  // import closure, or a global invalidator, means the approval no longer describes what would
  // land, and the head is judged again. Movement outside it leaves the approval standing, provided
  // the branch's own change is byte-identical across the merge; the landing head is then the
  // caught-up one, and the checks below are waited on for that head, not the reviewed one.
  // The boundary is a fact about the change itself, so it is asked once, before anything waits.
  const effective = effectiveTouches(ctx, touches, verdict.touches, cwd);
  if (!mergeAllowed(ctx, effective)) {
    mutate(ctx, `park PR #${pr} (autoMerge: ${ctx.knobs.autoMerge}, touches ${effective?.join(', ') ?? 'unstated'})`, [
      'gh',
      'pr',
      'edit',
      String(pr),
      '--add-label',
      'loop/parked',
    ]);
    return { park: `autoMerge is ${ctx.knobs.autoMerge} and the change touches ${effective?.join(', ') ?? 'categories nobody stated'}` };
  }

  // The approval is pinned to the commit the reviewer read. Anything pushed to the lane since then
  // was never judged, and a catch-up that started from it would carry it in under the approval.
  if (!ctx.dryRun && sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd) !== reviewedSha) {
    say('the lane moved past the reviewed commit; the approval no longer describes what would land');
    return 'stale';
  }

  // Single file, and upstream is checked each time. Every pass catches up, runs the gates on the
  // head that would land, and then looks upstream once more: checks, smoke, and a paused line can
  // each take long enough for another merge to land, and a head that lacks it must not merge.
  let landingSha = reviewedSha;
  // What complete looks like, read before anything moves the head: the checks the reviewed head carried.
  const reviewedChecks = ctx.dryRun || ctx.knobs.checks === 'none' ? { names: [], passed: [] } : checksOn(ctx, reviewedSha);
  const requiredByBase = ctx.dryRun || ctx.knobs.checks === 'none' ? [] : requiredStatusChecks(ctx);
  /** The base commit this lane held at its last look upstream. */
  let baseSeen = '';
  for (let pass = 0; ; pass++) {
    const caught = catchUp(ctx, issue, cwd, landingSha, say, 'before the merge');
    if (caught === 'conflict') {
      say(`conflicts with ${ctx.project.baseBranch}; a human has to resolve it`);
      return { dlq: `the branch conflicts with ${ctx.project.baseBranch}` };
    }
    if (caught) {
      if (caught.overlap.length > 0) {
        say(`base moved into this work (${caught.overlap.join(', ')}); the approval no longer describes what would land`);
        return 'stale';
      }
      if (!caught.netChangeIntact) {
        say('the catch-up changed what this branch contributes; the approval no longer describes what would land');
        return 'stale';
      }
      say(`base moved outside this work; the approval stands and the landing head is ${caught.after.slice(0, 10)}`);
      landingSha = caught.after;
    }

    const mismatch = await pullRequestMatchesReview(ctx, pr, issue.number, cwd, landingSha);
    if (mismatch) {
      say(`refusing to merge PR #${pr}: ${mismatch}`);
      return { dlq: mismatch };
    }

    // A failing or unfinished build never merges, whatever the review said. The reviewer watched
    // checks too, but its answer ages: any catch-up since the verdict pushed a head whose CI run
    // started fresh, and this is the last moment anything looks. Waiting here blocks the serial
    // queue, which is honest; a merge may not outrun its own build.
    // Every gate below takes time, and anything that lands meanwhile leaves this head behind. So
    // upstream is looked at after each one, before the card enters the next lane: a card is never
    // in Smoke or Merging lacking the base, and a stale one goes straight back to the catch-up.
    const lookUpstream = (after: string): 'fresh' | 'again' | { dlq: string } => {
      if (ctx.dryRun) return 'fresh';
      // The commit fetched is the commit compared and the commit remembered. The remote-tracking
      // ref is shared with every other lane, so reading it again could name a commit never checked.
      const checked = fetchBase(ctx, cwd);
      if (behindBase(ctx, cwd, checked).length === 0) {
        baseSeen = checked;
        return 'fresh';
      }
      if (pass >= MAX_BASE_REFRESHES) {
        return { dlq: `the base moved ${pass + 1} times while this landing waited on its gates; it needs a quiet base or a person` };
      }
      say(`the base moved ${after}; catching up again before anything else`);
      return 'again';
    };

    move(ctx, issue, 'F3', `PR #${pr} at ${landingSha.slice(0, 10)}`);
    const notGreen = await awaitGreenChecks(ctx, pr, say, ctx.dryRun ? undefined : { sha: landingSha, names: reviewedChecks.names, passedAtReview: reviewedChecks.passed, required: requiredByBase });
    holdLease(ctx, issue.number, 'act on the checks of the landing head');
    if (notGreen) {
      say(`refusing to merge PR #${pr}: ${notGreen}`);
      return { dlq: notGreen };
    }

    const afterChecks = lookUpstream('while the checks ran');
    if (afterChecks === 'again') continue;
    if (afterChecks !== 'fresh') return afterChecks;

    // A green build is not a booted result. A change can compile, type-check, and pass every test
    // and still fail the moment the result starts, because nothing above ever started it. The smoke
    // command is the repository's own "boot it and hit it once", run in the lane against the exact
    // head that would land. Optional; a repository with nothing to boot leaves it unset.
    if (ctx.project.smokeCommand) {
      say(`running the smoke command: ${ctx.project.smokeCommand}`);
      move(ctx, issue, 'F4');
      // Awaited, never spawnSync: a synchronous wait of minutes holds the event loop, so a signal
      // could not even begin the stop until the command ended. Registered with the agents, under
      // its own process group, so a stop takes it down with them.
      const running = Bun.spawn([...(SETSID ? [SETSID] : []), 'sh', '-c', ctx.project.smokeCommand], { cwd, stdout: 'pipe', stderr: 'pipe' });
      const registered = Object.assign(running, { issue: issue.number, repo: ctx.project.repo });
      children.add(registered);
      const overdue = setTimeout(() => killAgent(running), ctx.knobs.smokeTimeoutMinutes * 60_000);
      const [stdout, stderr, exitCode] = await Promise.all([new Response(running.stdout).text(), new Response(running.stderr).text(), running.exited]);
      clearTimeout(overdue);
      children.delete(registered);
      if (isStopping()) throw new RunStopping(`the run is stopping; the smoke command on PR #${pr} was stopped`);
      const smoke = { exitCode: running.signalCode ? null : exitCode, stdout, stderr };
      if (smoke.exitCode !== 0) {
        const tail = `${smoke.stdout}\n${smoke.stderr}`.trim().split('\n').slice(-6).join(' | ');
        const reason = `the smoke command exited ${smoke.exitCode ?? 'by timeout'}: ${tail || 'no output'}`;
        say(`refusing to merge PR #${pr}: ${reason}`);
        return { dlq: reason };
      }
      say('smoke command passed');
      const afterSmoke = lookUpstream('while the smoke command ran');
      if (afterSmoke === 'again') continue;
      if (afterSmoke !== 'fresh') return afterSmoke;
    }

    // The driver's last word. A driver holding its line waits here rather than answering; one that
    // gives up answers with a reason, and the landing is a dead letter without a review round spent.
    // The card is in Merging for the whole wait: a paused line holds a card that is about to land.
    move(ctx, issue, 'F5', `PR #${pr} at ${landingSha.slice(0, 10)}`);
    if (ctx.mayMerge) {
      const permission = await ctx.mayMerge();
      if (!permission.ok) {
        say(`refusing to merge PR #${pr}: ${permission.reason}`);
        return { dlq: permission.reason };
      }
    }

    // The last read before the merge: a hold, a pause, a child, or another run's claim that landed
    // during the review makes the merge someone else's call.
    if (!ctx.dryRun) {
      // A lost lease is not a changed issue, and it is not this run's to park.
      holdLease(ctx, issue.number, 'read the gate before an act on the issue');
      const gate = liveGate(ctx, trackerIo(ctx), issue.number, ceiling);
      if (!gate.ok) {
        say(`refusing to merge PR #${pr}: ${gate.why}`);
        return { park: `the issue changed under the review: ${gate.why}` };
      }
    }

    // The last look upstream. Pinning the head does not pin the base: if anything landed while
    // the line held this card, this head lacks it, and the pass runs again from the catch-up.
    const atTheMerge = lookUpstream('while this landing waited for the line');
    if (atTheMerge === 'fresh') break;
    if (atTheMerge !== 'again') return atTheMerge;
  }

  // `--match-head-commit` makes the merge itself refuse if the head moved between this check and
  // the call, so the commit that lands is the commit that was read.
  // The reads above are synchronous, so a signal that arrived during them has not been heard yet.
  await yieldToStop(`merge PR #${pr}`);
  // The yield lets a failed renewal be heard too: the lease is asked for once more, last of all.
  holdLease(ctx, issue.number, `merge PR #${pr}`);
  mutate(ctx, `merge PR #${pr}`, ['gh', 'pr', 'merge', String(pr), '--merge', '--match-head-commit', landingSha]);

  // Confirm it actually landed before closing anything. On a repository with a merge queue or
  // auto-merge, `gh pr merge` can enqueue rather than merge; a queued pull request would land
  // later while this driver has already parked it, so cancel whatever was scheduled first.
  // The merge report can trail the merge by a few seconds; wait for it before calling it missing.
  const readMerged = () => sh(ctx, ['gh', 'pr', 'view', String(pr), '--json', 'mergedAt', '--jq', '.mergedAt']);
  let merged = readMerged();
  for (let tries = 0; (!merged || merged === 'null') && tries < 6; tries++) {
    await Bun.sleep(5_000);
    merged = readMerged();
  }
  if (!merged || merged === 'null') {
    try {
      sh(ctx, ['gh', 'pr', 'merge', String(pr), '--disable-auto']);
    } catch {
      // nothing was scheduled
    }
    say(`PR #${pr} did not report a merge; cancelled any queued merge and left the worktree and issue alone`);
    return { dlq: 'the merge was requested but the pull request did not report a merge' };
  }

  // The merge is confirmed, so its record is finished even if the run is stopping meanwhile.
  return finishDespiteStop(async (): Promise<Landing> => {
    // The confirmation can outlast the lease. The merge stands either way, but its record is then
    // written on an issue another run may hold, so it is left to the next run start's reconcile.
    if (leaseLost(ctx, issue.number)) {
      say(`merged PR #${pr}, but this run lost its lease on the issue meanwhile; its record is left to the next run start`);
      return 'merged';
    }
    // The paths that landed, read while the worktree still exists.
    const paths = sh(ctx, ['git', 'diff', '--name-only', `${ctx.project.remote}/${ctx.project.baseBranch}...HEAD`], cwd)
      .split('\n')
      .filter(Boolean);
    // The merge pins the head it lands, never the base it lands on. One driver's queue is single
    // file, but a person or another operator's loop can merge in the seconds between the last look
    // upstream and this merge, and a repository that does not require up-to-date branches lets it.
    // That cannot be prevented from here, so it is detected and said plainly.
    const unseenBase = ctx.dryRun || !baseSeen ? null : landedOnUnseenBase(ctx, pr, baseSeen, say);
    if (unseenBase) {
      mutate(ctx, `note on PR #${pr} that it landed across an unseen commit`, [
        'gh', 'pr', 'comment', String(pr), '--body',
        `This merged onto ${unseenBase.slice(0, 10)}, which landed on \`${ctx.project.baseBranch}\` between the last look upstream and the merge. The checks and the review covered the branch without that commit; the combination is unverified until the base's own checks pass.`,
      ]);
    }
    move(ctx, issue, 'T1', `PR #${pr} merged ${merged}`);
    // Tell the driver while the worktree still exists, so the event carries the paths that landed.
    if (ctx.afterMerge) {
      ctx.afterMerge({ issue: issue.number, title: issue.title, pr, sha: landingSha, mergedAt: merged, paths, unseenBase: unseenBase ?? undefined });
    }
    // The person watching the main checkout sees the fix land, when the config asks for that.
    followBase(ctx, paths);

    // Read the branch name while the worktree still exists, then drop it. This is the one removal
    // that keeps nothing back: the change is merged, so the base holds every commit the lane had.
    const branch = sh(ctx, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    removeWorktree(ctx, issue.number);
    try {
      sh(ctx, ['git', 'push', ctx.project.remote, '--delete', branch]);
    } catch {
      say(`merged branch ${branch} was already deleted`);
    }
    // Read once more before the close. The merge has landed either way; a refusal here parks the
    // issue with the merge named, so a person sees a closed pull request against an open issue.
    if (!ctx.dryRun) {
      // A lost lease is not a changed issue, and it is not this run's to park.
      holdLease(ctx, issue.number, 'read the gate before an act on the issue');
      const gate = liveGate(ctx, trackerIo(ctx), issue.number, ceiling);
      if (!gate.ok) {
        say(`merged PR #${pr} but not closing the issue: ${gate.why}`);
        parkIssue(ctx, issue.number, `Pull request #${pr} merged at ${merged}, but the issue was not closed because ${gate.why}. A person closes it or carries on.`);
        return 'merged';
      }
    }
    await closeIssue(ctx, issue.number, `Closed by #${pr}.`, { kind: 'merged', pr, mergeSha: reviewedSha, reason: `merged #${pr}`, by: 'worker' });
    return 'merged';
  });
}

async function settleTerminalVerdict(ctx: Context, issue: Issue, result: WorkerResult, ceiling: number, say: (message: string) => void, pr?: number): Promise<FixOutcome | null> {
  const closePullRequest = () => {
    if (pr) mutate(ctx, `close PR #${pr}`, ['gh', 'pr', 'close', String(pr), '--comment', 'Superseded; see the issue.']);
  };
  // Every close re-reads the issue and its ancestors first: a hold, a pause, a child, or a claim
  // that landed since the worker started makes the close someone else's call.
  const gateBeforeClose = (): FixOutcome | null => {
    if (ctx.dryRun) return null;
    // A lost lease is not a changed issue, and it is not this run's to park.
    holdLease(ctx, issue.number, 'read the gate before an act on the issue');
    const gate = liveGate(ctx, trackerIo(ctx), issue.number, ceiling);
    if (gate.ok) return null;
    say(`refusing to close: ${gate.why}`);
    parkIssue(ctx, issue.number, `The loop reached a \`${result.verdict}\` verdict (${result.reason}) but did not close, because ${gate.why}.`);
    closePullRequest();
    retireLane(ctx, issue.number, say);
    return { outcome: 'parked', reason: gate.why };
  };

  switch (result.verdict) {
    case 'already-fixed':
    case 'obsolete': {
      const confirmation = await confirmWorkerClose(ctx, issue, result, say);
      if (!confirmation) return { outcome: 'failed', reason: 'no usable confirmation of the close' };
      if (!confirmation.agree) {
        closePullRequest();
        retireLane(ctx, issue.number, say);
        return parkWithBothOpinions(ctx, issue, result, confirmation, say);
      }
      const refused = gateBeforeClose();
      if (refused) return refused;
      // The obsolete pull request goes first: a crash after it leaves retryable work, whereas a
      // crash after the close would leave an open pull request attached to a closed issue.
      closePullRequest();
      await closeIssue(ctx, issue.number, `${result.closeComment ?? result.reason}\n\nIndependently re-checked: ${confirmation.reason}`, { kind: 'closed', reason: result.verdict, by: 'worker' });
      move(ctx, issue, 'T2', result.verdict);
      retireLane(ctx, issue.number, say);
      return { outcome: 'closed', reason: result.reason };
    }

    case 'answered': {
      const confirmation = await confirmWorkerClose(ctx, issue, result, say);
      if (!confirmation) return { outcome: 'failed', reason: 'no usable confirmation of the answer' };
      if (!confirmation.agree) {
        closePullRequest();
        retireLane(ctx, issue.number, say);
        return parkWithBothOpinions(ctx, issue, result, confirmation, say);
      }
      const refused = gateBeforeClose();
      if (refused) return refused;
      closePullRequest();
      const marker = `<!-- carve-answer issue=${issue.number} -->`;
      const already = ctx.dryRun ? false : trackerIo(ctx).view(issue.number)?.comments.some((c) => c.author === ctx.botLogin && c.body.startsWith(marker));
      if (!already) mutate(ctx, `post the answer on #${issue.number}`, ['gh', 'issue', 'comment', String(issue.number), '--body', `${marker}\n${result.answer ?? ''}`]);
      await closeIssue(ctx, issue.number, `Answered; see the answer above. Independently re-checked: ${confirmation.reason}`, { kind: 'answered', reason: 'answered', by: 'worker' });
      move(ctx, issue, 'T2', 'answered');
      retireLane(ctx, issue.number, say);
      return { outcome: 'closed', reason: result.reason };
    }

    case 'needs-decision':
    case 'needs-human':
      // Comment first, then the label that hides the issue from selection.
      mutate(ctx, `comment on #${issue.number}`, ['gh', 'issue', 'comment', String(issue.number), '--body', result.reason]);
      mutate(ctx, `label #${issue.number} ${result.verdict}`, [
        'gh',
        'issue',
        'edit',
        String(issue.number),
        '--add-label',
        result.verdict,
      ]);
      closePullRequest();
      move(ctx, issue, result.verdict === 'needs-decision' ? 'H1' : 'H2', result.reason.slice(0, 120));
      retireLane(ctx, issue.number, say);
      return { outcome: 'handed-off', reason: result.reason };

    case 'out-of-band': {
      if (result.points) {
        // The worker's own size can be one the repository has never carried a label for.
        ensureLabel(ctx, `size: ${result.points}`, 'c5def5', `Sized at ${result.points} by a worker that found the work larger than appraised`);
        mutate(ctx, `size #${issue.number} at ${result.points}`, [
          'gh',
          'issue',
          'edit',
          String(issue.number),
          '--add-label',
          `size: ${result.points}`,
        ]);
        // Two size labels would leave selection reading whichever it finds; add-then-remove plus
        // pointsFromLabels reading the max keeps the issue out of the band during the swap.
        const prior = issue.labels.find((l) => /^size:\s*\d+$/.test(l.name) && l.name !== `size: ${result.points}`);
        if (prior) {
          mutate(ctx, `clear ${prior.name} on #${issue.number}`, [
            'gh',
            'issue',
            'edit',
            String(issue.number),
            '--remove-label',
            prior.name,
          ]);
        }
      }
      closePullRequest();
      move(ctx, issue, 'C1', `out-of-band at ${result.points ?? 'unstated'} points`);
      retireLane(ctx, issue.number, say);
      return { outcome: 'handed-off', reason: result.reason };
    }

    default:
      return null;
  }
}

/**
 * One more worker or confirmer failure on the issue; at the cap the issue goes to the work
 * dead-letter queue with the log tail, so a leaf nobody can work stops costing attempts. The
 * count lives on the issue, like reviews.
 */
function countFailure(ctx: Context, issue: Issue, reason: string, say: (message: string) => void, pr?: number): FixOutcome {
  holdLease(ctx, issue.number, 'count the failed attempt');
  const attempts = recordAttempt(ctx, issue.number, attemptCount(issue.labels));
  say(`attempt ${attempts} of ${ctx.knobs.maxWorkerAttempts} failed`);
  // With a pull request open there is no Ready to go back to: a Ready card is one a worker starts
  // from nothing, and this work exists. It waits in the work queue for a redrive, at once.
  if (pr) return deadLetter(ctx, issue, 'work', `The worker or its confirmer failed on pull request #${pr} (attempt ${attempts}): ${reason}`, say, pr);
  if (attempts >= ctx.knobs.maxWorkerAttempts) {
    return deadLetter(ctx, issue, 'work', `The worker failed ${attempts} times on this issue and the loop stops trying. Last failure: ${reason}`, say);
  }
  move(ctx, issue, 'B1', `attempt ${attempts} failed; attempts remain`);
  return { outcome: 'failed', reason };
}

/** The lane each queue's card sits in. */
const DLQ_LANE: Record<DlqPhase, string> = { appraisal: 'Q1', carve: 'Q2', work: 'Q3', review: 'Q4', landing: 'Q5' };

/**
 * Ejects the issue to one phase's dead-letter queue and says so on every projection. A pull
 * request, when there is one, carries the same label, so a person reading the branch sees the
 * state the issue carries rather than an unlabelled draft nobody claimed.
 */
function deadLetter(ctx: Context, issue: Issue, phase: DlqPhase, reason: string, say: (message: string) => void, pr?: number): FixOutcome {
  holdLease(ctx, issue.number, 'send the issue to a dead-letter queue');
  sendToDlq(ctx, issue.number, phase, reason);
  if (pr) mutate(ctx, `label PR #${pr} loop/dlq: ${phase}`, ['gh', 'pr', 'edit', String(pr), '--add-label', `loop/dlq: ${phase}`]);
  say(`to the ${phase} DLQ: ${reason.split('\n')[0]}`);
  move(ctx, issue, DLQ_LANE[phase], reason.slice(0, 120));
  return { outcome: 'dlq', reason: `${phase} dead letter: ${reason.split('\n')[0]}` };
}

async function workIssue(
  ctx: Context,
  issue: Issue,
  cwd: string,
  maxPoints: number,
  ceiling: number,
  say: (message: string) => void,
): Promise<FixOutcome> {
  const result = await runWorker(ctx, issue, cwd, maxPoints);
  say(`verdict: ${result.verdict}; ${result.reason}`);

  // The pull request this work has, resolved once for every settlement below. A worker that died
  // after opening one, or a verdict that closes the issue, names none, so the tracker is asked. A
  // list that cannot be read throws, and the throw keeps the lane: unknown is not "none".
  // A dry run stops at the first seat it does not run. Nothing was tried, so no failure is counted
  // and the card rests in the lane the rehearsal reached.
  if (result.verdict === 'not-run') return { outcome: 'not-run', reason: result.reason };
  const pr = result.verdict === 'fixed' ? result.pr : (result.pr ?? (ctx.dryRun ? undefined : openPullFor(ctx, issue.number)));
  if (result.verdict === 'failed') {
    say('worker failed; leaving it untouched');
    return countFailure(ctx, issue, result.reason, say, pr);
  }
  const settled = await settleTerminalVerdict(ctx, issue, result, ceiling, say, pr);
  if (settled) return settled.outcome === 'failed' ? countFailure(ctx, issue, settled.reason, say, pr) : settled;

  if (result.pr) move(ctx, issue, 'E1', `PR #${result.pr} ready for review`);
  return reviewAndLand(ctx, issue, cwd, result, maxPoints, say, ceiling);
}

/**
 * The review pipeline for a pull request that exists: review, land, revise, until it merges,
 * parks, or exhausts its budget. Split from workIssue so a restart can re-enter it: a dead run's
 * worktree still holds the worker's verdict file, and resuming from that file is what un-strands
 * a pull request the crash left behind (see findStranded).
 *
 * From here the work is sequential. Coding is the concurrent part; integration is a pull master
 * working a queue, one branch at a time. The queue keeps this loop's own lanes from moving the
 * branch or the base between the read and the merge; GitHub itself still can, which is why the
 * merge pins the head with --match-head-commit and confirms mergedAt afterwards.
 *
 * The budget is a per-issue high-water mark, not a per-run allowance. An issue that spent two
 * rounds in an earlier run starts this one with one left, because the count lives on the issue
 * and the process does not. That is the whole point: it is what stops an issue cycling between
 * worker and reviewer forever, one restart at a time, with nothing accumulating against it.
 */
export async function reviewAndLand(
  ctx: Context,
  issue: Issue,
  cwd: string,
  first: WorkerResult,
  maxPoints: number,
  say: (message: string) => void,
  ceiling: number = maxPoints,
): Promise<FixOutcome> {
  let result = first;
  let consumed = reviewCount(issue.labels);
  let refreshes = 0;
  // Why the work stopped, carried to the park comment so the reason lives on the issue rather
  // than only in this run's log. Only a person's call parks; a machine's failure is a dead letter.
  let parkReason = 'the loop worked this issue and could not finish the call';
  // A budget already spent when the work arrives here (a resume, a redrive nobody reset) is the
  // review queue's, as it is when the last round is spent below: a machine's limit, not a person's call.
  if (consumed >= ctx.knobs.maxReviewRounds && !ctx.dryRun) {
    return deadLetter(ctx, issue, 'review', `The review budget of ${consumed} rounds was already spent when this pull request came back for review.`, say, result.pr);
  }
  while (consumed < ctx.knobs.maxReviewRounds) {
    if (!result.pr) return deadLetter(ctx, issue, 'work', 'The worker reported a fix but named no pull request.', say);
    const pr = result.pr;
    const touches = result.touches;

    if (ctx.dryRun) break;

    // No review begins on a stale lane. The proof was captured at the current head; a base that
    // moved since is merged in first, so the reviewer judges what would actually land. Movement
    // that reached the paths the proof covers means the world moved beneath the proof: the work
    // goes back to its author to reacquire it, which is upstream churn and spends no round.
    const proofHead = sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);
    const current = catchUp(ctx, issue, cwd, proofHead, say, 'before the review');
    if (current === 'conflict') return deadLetter(ctx, issue, 'landing', `The branch conflicts with ${ctx.project.baseBranch}.`, say, pr);
    if (current && (current.overlap.length > 0 || !current.netChangeIntact)) {
      refreshes += 1;
      if (refreshes > MAX_BASE_REFRESHES) {
        return deadLetter(ctx, issue, 'landing', `The base moved into this work ${refreshes} times, past the refresh cap; the landing needs a quiet base or a person.`, say, pr);
      }
      say(`base moved into what the proof covers (${current.overlap.join(', ') || 'the branch\'s own change'}); the proof is stale and goes back to be reacquired`);
      mutate(ctx, `return PR #${pr} to draft for the reproof`, ['gh', 'pr', 'ready', String(pr), '--undo']);
      result = await runWorker(ctx, issue, cwd, maxPoints, {
        pr,
        decision: 'gather-more',
        adequacy: 'The base branch moved into the paths this proof covers after it was captured, so the receipts describe a tree that no longer exists.',
        confidence: 'freshness',
        blocking: [
          `The branch has been caught up with ${ctx.project.baseBranch}. These incoming files are inside the import closure of your change, or invalidate everything: ${current.overlap.join(', ') || 'the merge altered your own change'}. Re-run the checks on the current head, confirm the fix still holds, reacquire every receipt whose covered paths they reach, and update the proof. Change code only if the base's movement requires it.`,
        ],
      }, true);
      say(`verdict: ${result.verdict}; ${result.reason}`);
      if (result.verdict === 'failed') return countFailure(ctx, issue, `while reacquiring stale proof: ${result.reason}`, say, pr);
      const resettled = await settleTerminalVerdict(ctx, issue, result, ceiling, say, pr);
      if (resettled) return resettled.outcome === 'failed' ? countFailure(ctx, issue, resettled.reason, say, pr) : resettled;
      continue;
    }

    // Reviewing happens here, outside the queue, so lanes review at the same time.
    if (consumed > 0 || refreshes > 0 || current) move(ctx, issue, 'E1', `PR #${pr} back for review`);
    const reviewed = await review(ctx, issue, pr, cwd, say, consumed + 1);
    if ('dlq' in reviewed) return deadLetter(ctx, issue, reviewed.dlq, reviewed.reason, say, pr);

    // Merging happens there, one branch at a time, because the base branch is shared.
    const outcome = await serializePullMaster(ctx, issue, say, async () => land(ctx, issue, pr, touches, reviewed, cwd, say, ceiling, consumed + 1 < ctx.knobs.maxReviewRounds));
    if (outcome === 'merged') return { outcome: 'merged', reason: `merged pull request #${pr}` };

    // The base reached this work while the review was running. That is upstream churn, not a defect
    // in the change, so it costs a fresh review but not a round of the issue's budget. Bounded:
    // a base that keeps landing into these files would otherwise re-review forever.
    if (outcome === 'stale') {
      refreshes += 1;
      if (refreshes > MAX_BASE_REFRESHES) {
        say(`base moved into this work ${refreshes} times`);
        return deadLetter(ctx, issue, 'landing', `The base moved into this work ${refreshes} times, past the refresh cap; the landing needs a quiet base or a person.`, say, pr);
      }
      continue;
    }

    const { review: verdict } = reviewed;

    // A landing the machine could not complete is the landing queue's, and it spends no round:
    // the reviewer found nothing wrong with the work, and a conflict, a red check, a failed smoke,
    // or a refused line is not an objection a revision could answer. Charging the budget here
    // would let three red builds eject an issue nobody ever rejected.
    if (typeof outcome === 'object' && 'dlq' in outcome) return deadLetter(ctx, issue, 'landing', outcome.dlq, say, pr);

    // An approved change the merge boundary declined to land is a person's call, and it spends no
    // round for the same reason.
    if (typeof outcome === 'object' && verdict.decision === 'merge') {
      parkReason = outcome.park;
      break;
    }

    // A rejection was reached and the work goes back or stops, so the round is spent whether the
    // outcome is a revision or a park. Recorded before the revision starts rather than after it
    // finishes, so a run killed mid-revision still leaves the budget honest; the alternative
    // silently refunds a round every time a run dies. A merge ends the accounting instead: the
    // issue is closing, and label churn on a closed issue records nothing anyone reads.
    consumed = recordReview(ctx, issue.number, consumed);
    say(`review round ${consumed} of ${ctx.knobs.maxReviewRounds}`);

    if (typeof outcome === 'object') {
      // The gate that parked says why, and the rejected review adds the reviewer's own words.
      const reviewerWords = verdict.blocking.length > 0 ? verdict.blocking.join('\n') : verdict.adequacy;
      parkReason = `${outcome.park}\n\nReviewer: ${reviewerWords}`;
      break;
    }

    if (consumed >= ctx.knobs.maxReviewRounds) {
      const objection = verdict.blocking.length > 0 ? verdict.blocking.join('\n') : verdict.adequacy;
      return deadLetter(ctx, issue, 'review', `The review budget of ${consumed} rounds is spent without a merge.\n\n${objection}`, say, pr);
    }

    // Revision is programming, so it happens outside the queue; the branch rejoins it afterwards.
    // The pull request is already back in draft: land() flips it before any catch-up push.
    result = await runWorker(ctx, issue, cwd, maxPoints, verdict);
    say(`verdict: ${result.verdict}; ${result.reason}`);
    // The attempt counts, and a failed revision on an open pull request is the work queue's.
    if (result.verdict === 'failed') return countFailure(ctx, issue, `on a revision: ${result.reason}`, say, pr);
    const settled = await settleTerminalVerdict(ctx, issue, result, ceiling, say, pr);
    if (settled) return settled.outcome === 'failed' ? countFailure(ctx, issue, settled.reason, say, pr) : settled;
  }

  holdLease(ctx, issue.number, 'park the issue');
  parkIssue(ctx, issue.number, parkReason);
  // The pull request is parked too, so a human reading the branch sees the same state the issue
  // carries rather than an unlabelled draft nobody claimed.
  if (result.pr) {
    mutate(ctx, `park PR #${result.pr}`, ['gh', 'pr', 'edit', String(result.pr), '--add-label', 'loop/parked']);
  }
  say('parked for a human');
  move(ctx, issue, 'H3', parkReason.slice(0, 120));
  return { outcome: 'parked', reason: parkReason };
}

/**
 * Fixes one issue end to end and says how it ended.
 *
 * The lane is created here and removed here, whatever the outcome, so no exit leaks a worktree.
 * A crash never runs the cleanup, which is exactly when the resume path should get its chance.
 */
export async function fixIssue(
  ctx: Context,
  issue: Issue,
  options: { maxPoints?: number; ceiling?: number; confirmer?: Seat } = {},
): Promise<FixOutcome> {
  // Lanes interleave, so every line an issue emits names the issue. Without this the console is a
  // shuffled deck of verdicts with no way to tell which belongs to which.
  const say = (message: string) => ctx.log(`#${issue.number}  ${message}`);
  ctx.step(`#${issue.number} ${issue.title}`);
  const maxPoints = options.maxPoints ?? DEFAULT_MAX_POINTS;
  const ceiling = options.ceiling ?? maxPoints;
  if (options.confirmer) ctx.seats.confirmer = options.confirmer;
  assertDistinctEngines(ctx.seats.worker, ctx.seats.confirmer ?? ctx.seats.reviewer, 'worker and confirmer');

  // The live gate, then the claim, then the lane: nothing is created for an issue this run may not work.
  const io = trackerIo(ctx);
  const gate = liveGate(ctx, io, issue.number, ceiling);
  if (!gate.ok) {
    say(`left alone: ${gate.why}`);
    return { outcome: gate.outcome, reason: gate.why };
  }
  const handle = await claim(ctx, io, issue.number, 'working');
  if (handle === 'busy') return { outcome: 'busy', reason: 'another run holds this issue' };
  const stopRenewing = keepClaimed(handle, () => {
    // The lease ran out unrenewed: another run may hold the issue now, so this one's agent stops.
    const killed = killAgentsOn(ctx.project.repo, issue.number);
    ctx.log(`#${issue.number}  lost its lease (renewals failed until the claim ran out); stopped ${killed} agent(s)`);
  });

  // Everything after the claim is inside the try: a worktree that cannot be created must not
  // leave a claim behind that keeps renewing itself with nobody working under it.
  let keepLane = false;
  try {
    // Even in a dry run the path is the worktree's, never the main checkout, so nothing downstream
    // learns to treat the main checkout as a valid agent working directory.
    const cwd = ctx.dryRun
      ? resolve(ctx.repoRoot, ctx.project.worktreeRoot, `issue-${issue.number}`)
      : worktreeFor(ctx, issue.number);
    inFlight.set(issue.number, { dir: cwd, busy: false });
    // Awaited, not returned: a returned promise would run the cleanup below while the work it
    // guards is still going.
    return await workIssue(ctx, issue, cwd, maxPoints, ceiling, say);
  } catch (error) {
    const recorded = recordThrow(ctx, issue, error as Error, say);
    keepLane = recorded.keepLane;
    return recorded.outcome;
  } finally {
    stopRenewing();
    try {
      handle.release();
    } catch (error) {
      say(`could not release the claim: ${(error as Error).message}`);
    }
    inFlight.delete(issue.number);

    // Whatever the outcome, this lane is finished with the directory, so it goes here rather than
    // at each of the eight exits that used to leak one. Nothing in-process reads it again, and
    // the resume path resumes only a `fixed` verdict whose pull request is open at the same head on
    // an unlabelled issue; every outcome that reaches this line (failed, parked, DLQed, budget
    // exhausted, terminal verdict, merged) is one it already refuses. Removing the worktree also
    // sweeps the `issue-N-<scratch>` siblings agents make for evidence capture, which nothing else
    // reclaims. A crash never runs this block, which is exactly when resume should get its chance,
    // so reconcile still owns that case on the next start. A throw that could not be recorded on
    // the issue keeps its lane too: the worktree is then the only record of what happened.
    if (!ctx.dryRun && !keepLane) retireLane(ctx, issue.number, say);
  }
}

/** The open pull request whose branch names this issue, when there is one. Throws when the list cannot be read: "unknown" is not "none". */
function openPullFor(ctx: Context, issue: number): number | undefined {
  const raw = sh(ctx, ['gh', 'pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,headRefName,author,body']);
  const pulls = JSON.parse(raw) as Array<{ number: number; headRefName: string; author?: { login?: string }; body?: string }>;
  // What is found here can be parked or closed, so a branch that merely ends in the number is not
  // enough: the pull request must be the loop's own (its login opened it) and must name the issue.
  const names = new RegExp(`#${issue}\\b`);
  return pulls.find((pr) => pr.headRefName.endsWith(`-${issue}`) && pr.author?.login === ctx.botLogin && names.test(pr.body ?? ''))?.number;
}

/**
 * A step that threw (a push the retries could not save, a fetch that failed, a checks read that
 * errored) is a machine failure, and it is recorded like one rather than only logged. The queue is
 * the one that owns the lane the card was in: a throw while reviewing is a review dead letter, a
 * throw while landing a landing one. In the work phase a pull request decides it: with one open
 * the failure is a work dead letter carrying the error, and without one it is a counted attempt,
 * back to Ready until the cap. When the recording itself fails, or the pull request list cannot be
 * read, the lane is kept: the worktree is then the only record of what happened.
 */
/**
 * Before a finished lane is removed: work it committed and never pushed exists nowhere else, and a
 * failed attempt is exactly when there is some. Pushed, it survives for the next attempt to read
 * and for a person to look at. A lane that cannot be pushed is kept instead, since removing it
 * would be the only irreversible act here.
 */
export function retireLane(ctx: Context, issue: number, say: (message: string) => void): void {
  if (preserveLaneWork(ctx, issue, say)) removeWorktree(ctx, issue);
}

export function preserveLaneWork(ctx: Context, issue: number, say: (message: string) => void): boolean {
  // The lane's own directory, by the same rule that made it; a lane already gone holds nothing.
  const cwd = resolve(ctx.repoRoot, ctx.project.worktreeRoot, `issue-${issue}`);
  if (!existsSync(cwd)) return true;
  try {
    // Nothing here that no remote has: the lane holds no work of its own, whatever it is on.
    if (Number(sh(ctx, ['git', 'rev-list', '--count', 'HEAD', '--not', '--remotes'], cwd)) === 0) return true;
    const branch = sh(ctx, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    // A lane starts detached, so a worker that committed before it made its branch has its only
    // copy here, reachable by nothing but this worktree's HEAD. There is no branch to push it to;
    // the lane is kept, and a person reads it.
    if (branch === 'HEAD') {
      // A branch ref would survive the worktree; a detached head does not, and the next run's
      // reconcile removes a clean lane. The commits are given a ref of their own first, in the
      // repository all worktrees share, so removing this directory can never make them unreachable.
      // One ref per rescue, named for the commit it saves: a later attempt on the same issue must
      // not take the name of an earlier one and leave its history unreachable.
      const head = sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);
      const rescued = `refs/loop/rescued/issue-${issue}/${head.slice(0, 12)}`;
      sh(ctx, ['git', 'update-ref', rescued, head], cwd);
      say(`keeping the lane, and saved its detached commits as ${rescued}: no branch and no remote has them`);
      return false;
    }
    // Only this issue's own branch is published, by the coder's naming rule. A lane that ended up on
    // some other branch, the base most of all, is kept for a person rather than pushed anywhere: a
    // cleanup step is no place to publish a change nobody reviewed.
    if (branch === ctx.project.baseBranch || !branch.endsWith(`-${issue}`)) {
      say(`keeping the lane: it holds commits that are on no remote, on ${branch}, which is not this issue's branch`);
      return false;
    }
    sh(ctx, ['git', 'push', ctx.project.remote, `HEAD:refs/heads/${branch}`], cwd);
    say(`pushed ${branch}: this lane held commits that were on no remote, and the lane is about to go`);
    return true;
  } catch (error) {
    say(`keeping the lane: it holds commits that are on no remote and could not be pushed (${(error as Error).message.split('\n')[0]})`);
    return false;
  }
}

export function recordThrow(ctx: Context, issue: Issue, error: Error, say: (message: string) => void, knownPr?: number): { outcome: FixOutcome; keepLane: boolean } {
  const lane = lastLane.get(laneKeyOf(ctx, issue.number));
  const reason = `The pipeline threw${lane ? ` in ${lane}` : ''}: ${error.message.split('\n').slice(0, 6).join(' | ')}`;
  // After the merge there is nothing to retry and nothing to queue: the change landed. The run
  // start reconciles a merged pull request against an open issue, so the card stays where it is.
  if (lane?.startsWith('T')) {
    say(`${reason}. The change had already landed; the next run start reconciles the issue with its merged pull request`);
    return { outcome: { outcome: 'merged', reason: `${reason} (after the merge)` }, keepLane: false };
  }
  // A lost lease is not a failure of the work: another run may hold the issue, so nothing is
  // written on it, and the lane is kept for whoever reads what happened.
  if (error instanceof LeaseLostError || leaseLost(ctx, issue.number)) {
    say(`lost its lease; nothing is written on the issue, the lane is kept, and anything already pushed survives: ${error.message.split('\n')[0]}`);
    return { outcome: { outcome: 'lease-lost', reason: 'this run lost its lease on the issue' }, keepLane: true };
  }
  // Nor is a stop, which is the operator's: nothing is counted or queued, and the lane is kept,
  // since a worker stopped mid-change leaves its only record there.
  if (error instanceof RunStopping || isStopping()) {
    say('stopped with the run; nothing is written on the issue, the lane is kept, and anything already pushed survives');
    return { outcome: { outcome: 'stopped', reason: error.message.split('\n')[0] }, keepLane: true };
  }
  say(reason);
  if (ctx.dryRun) return { outcome: { outcome: 'failed', reason }, keepLane: false };
  try {
    const pr = knownPr ?? openPullFor(ctx, issue.number);
    // With no lane remembered (the driver placed the card; this pipeline had not moved it yet), the
    // pull request says which phase the card was in: a draft is still Work's, a ready one is Review's.
    const owner = lane ? phaseOfLane(lane) : pr && !isDraft(ctx, pr) ? 'review' : 'work';
    // This pipeline visits Confirming close only for a worker's own close, so a throw there is
    // still the worker's failure; the appraisal and carve queues belong to their own drivers.
    const phase = owner === 'appraisal' || owner === 'carve' ? 'work' : owner;
    const outcome = pr || phase !== 'work' ? deadLetter(ctx, issue, phase, reason, say, pr) : countFailure(ctx, issue, reason, say);
    return { outcome, keepLane: false };
  } catch (second) {
    say(`could not record the failure on the issue (${(second as Error).message.split('\n')[0]}); keeping the lane for inspection`);
    return { outcome: { outcome: 'failed', reason }, keepLane: true };
  }
}

/**
 * Continues an existing pull request instead of opening a second one: the redrive a person makes
 * by lifting a park or a dead letter. The lane is checked out on the pull request's branch, the
 * worker runs in revision mode with the objection that stopped the work as its brief, and the
 * result goes through the same review and landing as a first attempt. A worker that reports a
 * fix without naming the pull request is taken to mean this one.
 */
export async function redriveIssue(
  ctx: Context,
  issue: Issue,
  pull: { number: number; branch: string },
  /**
   * What stopped the work, which is the revision's brief. Null when nothing did: the pull request
   * only lost its driver (a run that died elsewhere, a lane that is gone), so there is no objection
   * to answer and the card goes to the closest lane that can carry it on, Proving, not to a revision.
   */
  objection: string | null,
  options: { maxPoints?: number; ceiling?: number; confirmer?: Seat } = {},
): Promise<FixOutcome> {
  const say = (message: string) => ctx.log(`#${issue.number}  ${message}`);
  ctx.step(`#${issue.number} ${issue.title} (${objection === null ? 'resuming' : 'redrive of'} PR #${pull.number})`);
  const maxPoints = options.maxPoints ?? DEFAULT_MAX_POINTS;
  const ceiling = options.ceiling ?? maxPoints;
  if (options.confirmer) ctx.seats.confirmer = options.confirmer;
  assertDistinctEngines(ctx.seats.worker, ctx.seats.confirmer ?? ctx.seats.reviewer, 'worker and confirmer');

  const io = trackerIo(ctx);
  const gate = liveGate(ctx, io, issue.number, ceiling);
  if (!gate.ok) {
    say(`left alone: ${gate.why}`);
    return { outcome: gate.outcome, reason: gate.why };
  }
  const handle = await claim(ctx, io, issue.number, 'working');
  if (handle === 'busy') return { outcome: 'busy', reason: 'another run holds this issue' };
  const stopRenewing = keepClaimed(handle, () => {
    // The lease ran out unrenewed: another run may hold the issue now, so this one's agent stops.
    const killed = killAgentsOn(ctx.project.repo, issue.number);
    ctx.log(`#${issue.number}  lost its lease (renewals failed until the claim ran out); stopped ${killed} agent(s)`);
  });

  let keepLane = false;
  try {
    const cwd = ctx.dryRun
      ? resolve(ctx.repoRoot, ctx.project.worktreeRoot, `issue-${issue.number}`)
      : worktreeAtPullRequest(ctx, issue.number, pull.branch);
    inFlight.set(issue.number, { dir: cwd, busy: false });
    if (ctx.dryRun) {
      say(`DRY RUN  would ${objection === null ? 'reacquire the proof of' : 'revise'} PR #${pull.number} on ${pull.branch}, then review and land`);
      return { outcome: 'not-run', reason: 'dry run: the redrive was not run' };
    }
    // The pull request goes back to draft first, so the catch-up and the revision's pushes spend
    // no CI run. Then the base: a redriven pull request has usually sat, and no revision begins on
    // a stale lane.
    if (!isDraft(ctx, pull.number)) mutate(ctx, `return PR #${pull.number} to draft for the redrive`, ['gh', 'pr', 'ready', String(pull.number), '--undo']);
    const head = sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);
    if (catchUp(ctx, issue, cwd, head, say, 'before the redrive') === 'conflict') {
      return deadLetter(ctx, issue, 'landing', `The branch conflicts with ${ctx.project.baseBranch}.`, say, pull.number);
    }
    const feedback: ReviewResult =
      objection === null
        ? {
            pr: pull.number,
            decision: 'gather-more',
            adequacy: 'This pull request lost its driver before it was reviewed. Nobody has objected to the change; its proof has to be current before a review can start.',
            confidence: 'resume',
            blocking: [
              `The branch has been caught up with ${ctx.project.baseBranch}. Re-run the checks on the current head, confirm the fix still holds, reacquire any receipt that no longer describes this head, and update the proof. Change code only if something fails.`,
            ],
          }
        : {
            pr: pull.number,
            decision: 'gather-more',
            adequacy: 'This pull request was stopped by the objection below; a person has asked for it to be continued.',
            confidence: 'redrive',
            blocking: [objection],
          };
    let result = await runWorker(ctx, issue, cwd, maxPoints, feedback, objection === null);
    say(`verdict: ${result.verdict}; ${result.reason}`);
    if (result.verdict === 'failed') return countFailure(ctx, issue, `on a ${objection === null ? 'resume' : 'redrive'}: ${result.reason}`, say, pull.number);
    if (result.verdict === 'fixed' && !result.pr) result = { ...result, pr: pull.number, branch: pull.branch };
    const settled = await settleTerminalVerdict(ctx, issue, result, ceiling, say, pull.number);
    if (settled) return settled.outcome === 'failed' ? countFailure(ctx, issue, settled.reason, say, pull.number) : settled;
    if (result.pr) move(ctx, issue, 'E1', `PR #${result.pr} ready for review again`);
    // Awaited, not returned: returning the promise ran this cleanup the moment the reviewer
    // started, so two live redrives reviewed and merged with no claim and no lease.
    return await reviewAndLand(ctx, issue, cwd, result, maxPoints, say, ceiling);
  } catch (error) {
    const recorded = recordThrow(ctx, issue, error as Error, say, pull.number);
    keepLane = recorded.keepLane;
    return recorded.outcome;
  } finally {
    stopRenewing();
    try {
      handle.release();
    } catch (error) {
      say(`could not release the claim: ${(error as Error).message}`);
    }
    inFlight.delete(issue.number);
    if (!ctx.dryRun && !keepLane) retireLane(ctx, issue.number, say);
  }
}

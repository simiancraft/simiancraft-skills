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
import { join, resolve } from 'node:path';
import { confirmClose, validateConfirmation } from '../../appraise-github-issues/lib/appraise.ts';
import { type CodeBrief, runCode } from '../../code-github-issue/lib/code.ts';
import { type ProveBrief, runProve } from '../../prove-github-issue/lib/prove.ts';
import { claim, type ClaimHandle, keepClaimed, LeaseLostError, leaseLost, liveGate, trackerIo } from '../../carve-github-issue/lib/claims.ts';
import type { TrackerIo } from '../../carve-github-issue/lib/tree.ts';
import { children, killAgent, killAgentsOn, parseJsonFile, readResult, refuseEnvironmentFault, renderPrompt, runAgent, SETSID } from './agent.ts';
import type { Blocker } from './blockers.ts';
import type { Context } from './context.ts';
import { CONFIRMATION_FILE, PROOF_FILE } from './control-files.ts';
import { assertDistinctEngines, type Seat } from './engines.ts';
import { followBase } from './follow-base.ts';
import { EnvironmentFault, type EnvironmentFaultKind, environmentFaultOf, rememberFaultMarkers, settleOutsideStop } from './environment-fault.ts';
import { attemptCount, ceilingFor, closeIssue, type DlqPhase, ensureLabel, parkIssue, recordAttempt, recordReview, reviewCount, sendToDlq } from './labels.ts';
import { clearSizeLabels, weighHold } from './panel.ts';
import { dirtyPaths, inFlight, removeWorktree, rescueRef, resetLane, seatScratch, updateFromBase, worktreeAtPullRequest, worktreeFor } from './lane.ts';
import { finishDespiteStop, isFinishing, isStopping, mutate, RunStopping, sh, stoppableSleep, transportFailureIn, yieldToStop } from './shell.ts';
import { boundaryWaived } from './land.ts';
import { recordMerge } from './record-merge.ts';
import { type CheckObservation, type CheckStatus, type LandingObservation, landingWatch } from './landing-watch.ts';
import { type BaseCommit, behindBase, behindBeyondNoise, commitsBehind, describeCommits, fetchBase, MAX_BASE_REFRESHES, MAX_NOISE_REFRESHES, matchesPath, staleAgainstBase } from './staleness.ts';
import { codedComment, latestStep, type Touch, unprovedComment } from './work-markers.ts';
import { heldComment, loopHoldStands, proofHeldComment, standingApproval, standingStop, stopComment } from './stop-record.ts';
import { loopNote } from './note.ts';

/**
 * How the pipeline finished with an issue, and why.
 *
 * `closed` is a verdict that ended the issue without code (already fixed, obsolete); `handed-off`
 * is one that needs a person (a product decision, access an agent lacks, work outside the band);
 * `parked` means a pull request exists and a human owns the next call.
 */
export type FixOutcome = {
  /** `not-run` is a dry run that reached a seat it does not run: nothing was tried, so nothing failed. */
  /**
   * `lease-lost` is not `busy`: `busy` says another run's claim was seen, and the driver places the
   * card for it; here this run's own lease ran out, who holds the issue now is not known, and the
   * card is no longer this run's to place.
   */
  /** `stopped` is a lane the operator's stop unwound: nothing about it was settled, and the next run takes it up. */
  /**
   * `unjudged` is a lane that ended on an environment fault (a full disk, no memory, a person's
   * stop): the work was not judged, nothing was counted, the lane was cleared, and the work is rerun
   * later; on a host fault the driver was asked to pause the line. `fault` names which.
   */
  outcome: 'merged' | 'parked' | 'handed-off' | 'closed' | 'dlq' | 'failed' | 'left-alone' | 'busy' | 'not-run' | 'stopped' | 'lease-lost' | 'unjudged';
  reason: string;
  fault?: EnvironmentFaultKind;
};

/** The largest `size: N` on an issue, or null when it carries none. */
function labelPoints(labels: Array<{ name: string }>): number | null {
  const sizes = labels.map((l) => /^size:\s*(\d+)$/.exec(l.name)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1]));
  return sizes.length ? Math.max(...sizes) : null;
}

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
  /**
   * The seat whose escape this is. A coder's escape has nothing proved behind it; a prover's comes
   * after the code was pushed and announced, so its hold keeps the pull request open.
   */
  seat?: 'coder' | 'prover';
  /** For needs-human: `base` when the seat reproduced the failure on the untouched base, which is not the change's. */
  outside?: 'base';
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
  blockedBy?: { nodes: Blocker[] };
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
 * The Work phase for one issue, as two seats on two fresh contexts: the coder (`code-github-issue`)
 * makes, gates, and pushes the change; the prover (`prove-github-issue`) proves the pushed head and
 * hands it to review as a ready pull request. Each seat ends at a fact on the remote, the driver
 * moves the card between them, and the push is announced on the issue before anything else
 * happens, so a kill costs the lane it happened in: a prover that dies leaves a coded commit the
 * next attempt proves again, not one it codes again.
 *
 * Where the turn starts follows from why it exists. A first attempt places itself from the issue's
 * standing `loop-step` marker; a reproof, a resumed pull request, and a reviewer's request for more
 * evidence are the prover's alone; an objection to the code, and a person's redrive, are the
 * coder's, then the prover's. The answer is the one `WorkerResult` the rest of the pipeline reads.
 */
async function runWorker(
  ctx: Context,
  issue: Issue,
  cwd: string,
  maxPoints: number,
  feedback?: ReviewResult,
  /** True when nothing was rejected: the base moved beneath the proof and only the proof is owed. */
  reproof = false,
): Promise<WorkerResult> {
  const say = (message: string) => ctx.log(`#${issue.number}  ${message}`);
  const fromThread = feedback ? JSON.stringify(feedback, null, 2) : '';
  // A redrive arrives as gather-more too, but a person asking for the work to be continued is
  // asking the coder; only the reviewer's own request for evidence, a reproof, and a resume are the prover's.
  const proveOnly = reproof || (feedback !== undefined && feedback.decision === 'gather-more' && feedback.confidence !== 'redrive');

  let code: CodeBrief | null = null;
  let proof: ProveBrief | null = null;
  let coded: { branch: string; gated: string; touches: Touch[] } | null = null;
  let note: string | undefined;
  if (proveOnly && feedback) {
    // Nothing is known about which commit was gated, so the prover gates the head it proves.
    coded = { branch: laneBranch(ctx, cwd), gated: '', touches: [] };
    // A catch-up and a lost driver owe the same thing, current proof; a reviewer's request owes more of it.
    proof = reproof || feedback.confidence === 'resume' ? { kind: 'reproof', text: fromThread } : { kind: 'more-evidence', text: fromThread };
    note = reproof ? 'reacquiring proof after the base moved' : feedback.confidence === 'resume' ? 'continuing the existing pull request: it lost its driver' : 'more evidence after a review';
  } else if (feedback) {
    code = { kind: 'revision', branch: laneBranch(ctx, cwd), text: fromThread };
    // The note says where the brief came from. A person lifting a park or a dead letter is not a
    // review; a card that says otherwise sends its reader to look for one that never happened.
    note = feedback.confidence === 'redrive' ? 'continuing the existing pull request: a person asked for it to be continued' : 'revision after a review';
  } else {
    const placed = placeWork(ctx, issue, cwd, say);
    if (placed.kind === 'prove') {
      coded = placed.coded;
      proof = { kind: 'handoff', text: placed.handoff };
      note = `resuming at Proving: ${placed.coded.branch} was coded at ${placed.sha.slice(0, 12)} by an earlier attempt`;
    } else code = placed.brief;
  }

  // At most the attempts the issue has left: every refused proof spends one and codes again.
  for (;;) {
    if (code) {
      const revision = code.kind === 'revision';
      move(ctx, issue, revision ? 'D4' : 'D1', code.kind === 'unproved' ? 'the proof was refused; coding again with what it could not show' : note);
      // Only a first attempt may be reset on a retry: every other kind holds a branch someone already read.
      const c = await runCode(ctx, issue, cwd, maxPoints, code, code.kind === 'first' ? () => resetLane(ctx, issue.number, cwd) : undefined);
      holdLease(ctx, issue.number, 'settle the coder');
      if (c.verdict === 'not-run') return { issue: issue.number, verdict: 'not-run', reason: c.reason };
      if (c.verdict !== 'coded') {
        // The escapes are the same words either seat may say, with the pull request a revision holds.
        return { issue: issue.number, verdict: c.verdict, reason: c.reason, points: c.points, closeComment: c.closeComment, answer: c.answer, pr: feedback?.pr, branch: c.branch, touches: c.touches, seat: 'coder', outside: c.outside };
      }
      coded = { branch: c.branch ?? '', gated: c.gated ?? '', touches: c.touches ?? [] };
      // The push is the fact; the announcement is what the next run, on any machine, reads.
      if (!ctx.dryRun) {
        mutate(ctx, `announce #${issue.number} coded at ${String(c.sha).slice(0, 12)}`, ['gh', 'issue', 'comment', String(issue.number), '--body', codedComment(ctx.runId, { branch: coded.branch, sha: c.sha ?? '', gated: coded.gated, touches: coded.touches }, c.handoff ?? '')]);
      }
      proof = { kind: 'handoff', text: c.handoff ?? '' };
      note = `coded at ${String(c.sha).slice(0, 12)}; proving on a fresh seat`;
      code = null;
    }
    if (!coded || !proof) throw new Error(`#${issue.number}: the Work phase reached Proving with nothing coded`);

    // No seat begins on a stale lane: the base is merged in at the seam, never inside a turn.
    const seam = ctx.dryRun ? 'current' : await seamCatchUp(ctx, issue, cwd, say, 'before proving');
    if (seam === 'conflict') {
      return { issue: issue.number, verdict: 'failed', reason: `the branch conflicts with ${ctx.project.baseBranch} at the seam before proving`, pr: feedback?.pr, branch: coded.branch };
    }
    // The catch-up pushed a merge, so the announcement must name the new head: placement proves only
    // an announced head, and a prover killed after this seam must be proved again, not coded again.
    if (seam === 'caught-up' && proof.kind === 'handoff') {
      const head = sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);
      mutate(ctx, `announce #${issue.number} coded at ${head.slice(0, 12)} after catching up`, ['gh', 'issue', 'comment', String(issue.number), '--body', codedComment(ctx.runId, { branch: coded.branch, sha: head, gated: coded.gated, touches: coded.touches }, proof.text)]);
    }
    move(ctx, issue, 'D2', note);
    const p = await runProve(ctx, issue, cwd, coded, proof);
    holdLease(ctx, issue.number, 'settle the prover');
    if (p.verdict === 'not-run') return { issue: issue.number, verdict: 'not-run', reason: p.reason };
    if (p.verdict === 'proved') {
      const touches = [...new Set([...coded.touches, ...(p.touches ?? [])])];
      return { issue: issue.number, verdict: 'fixed', reason: p.reason, pr: p.pr, branch: coded.branch, touches: touches.length > 0 ? touches : undefined };
    }
    if (p.verdict !== 'unprovable') return { issue: issue.number, verdict: p.verdict, reason: p.reason, pr: p.pr ?? feedback?.pr, branch: coded.branch, seat: 'prover' };

    // Proof that cannot be produced is a fault in the code: back a step, spending an attempt. The
    // last attempt is the caller's to count, so a refusal at the cap is never counted twice.
    const spent = attemptCount(issue.labels);
    if (spent + 1 >= ctx.knobs.maxWorkerAttempts) {
      return { issue: issue.number, verdict: 'failed', reason: `the change could not be proved: ${p.brief}`, pr: p.pr ?? feedback?.pr, branch: coded.branch };
    }
    const used = recordAttempt(ctx, issue.number, spent);
    issue.labels = [...issue.labels.filter((label) => !/^loop\/attempts:/.test(label.name)), { name: `loop/attempts: ${used}` }];
    say(`proof refused (attempt ${used} of ${ctx.knobs.maxWorkerAttempts}); back to coding`);
    const head = ctx.dryRun ? '' : sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);
    if (!ctx.dryRun) mutate(ctx, `announce #${issue.number} not proved at ${head.slice(0, 12)}`, ['gh', 'issue', 'comment', String(issue.number), '--body', unprovedComment(ctx.runId, coded.branch, head, p.brief ?? '')]);
    code = { kind: 'unproved', branch: coded.branch, text: p.brief ?? '' };
    proof = null;
  }
}

/** The branch a lane holds; a detached lane has none to name, which no seat may then continue. */
function laneBranch(ctx: Context, cwd: string): string {
  if (ctx.dryRun) return 'dry-run';
  const branch = sh(ctx, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (branch === 'HEAD') throw new Error(`the lane at ${cwd} is detached, so there is no branch to continue`);
  return branch;
}

export type Placement =
  | { kind: 'code'; brief: CodeBrief }
  | { kind: 'prove'; sha: string; handoff: string; coded: { branch: string; gated: string; touches: Touch[] } };

/**
 * Where a first attempt starts, read from facts on the remote and the tracker, never from a dead
 * process's memory. A `coded` announcement whose commit is still the head of its branch on the
 * remote is proved, not coded again. An `unproved` one is coded again on its branch with what the
 * prover could not show. A branch that moved past its announcement, or one of this issue's branches
 * that was pushed and never announced, holds work nobody declared finished, so a coder continues it.
 * An announcement whose commit the base already holds is history, not work. Anything else starts
 * from the base. The lane is switched onto the branch it continues.
 */
export function placeWork(ctx: Context, issue: Issue, cwd: string, say: (message: string) => void): Placement {
  const first: Placement = { kind: 'code', brief: { kind: 'first' } };
  if (ctx.dryRun) return first;
  const node = trackerIo(ctx).view(issue.number);
  const step = node ? latestStep(node.comments, ctx.botLogin) : null;
  if (!step) {
    const pushed = unannouncedBranch(ctx, cwd, issue.number);
    if (!pushed) return first;
    say(`${pushed} holds pushed work for this issue that was never announced; a coder continues it`);
    switchLane(ctx, cwd, pushed);
    return { kind: 'code', brief: { kind: 'continue', branch: pushed, text: 'Nothing was announced for it: the coder that pushed it stopped before it said the change was finished.' } };
  }
  const remoteHead = remoteBranchHead(ctx, cwd, step.branch);
  if (!remoteHead) {
    say(`the announced branch ${step.branch} is gone from ${ctx.project.remote}; starting from the base`);
    return first;
  }
  const baseSha = fetchBase(ctx, cwd);
  if (Bun.spawnSync(['git', 'merge-base', '--is-ancestor', step.sha, baseSha], { cwd, stdout: 'pipe', stderr: 'pipe' }).exitCode === 0) {
    say(`the announced commit ${step.sha.slice(0, 12)} is already in ${ctx.project.baseBranch}; starting from the base`);
    return first;
  }
  switchLane(ctx, cwd, step.branch);
  if (step.kind === 'unproved') return { kind: 'code', brief: { kind: 'unproved', branch: step.branch, text: step.brief } };
  if (remoteHead !== step.sha) {
    return { kind: 'code', brief: { kind: 'continue', branch: step.branch, text: `It was announced coded at ${step.sha}, and has moved to ${remoteHead} since.` } };
  }
  return { kind: 'prove', sha: step.sha, handoff: step.handoff, coded: { branch: step.branch, gated: step.gated, touches: step.touches } };
}

/** Checks the lane out on a branch at its remote head. */
function switchLane(ctx: Context, cwd: string, branch: string): void {
  sh(ctx, ['git', 'fetch', ctx.project.remote, `+refs/heads/${branch}:refs/remotes/${ctx.project.remote}/${branch}`], cwd);
  sh(ctx, ['git', 'checkout', '-B', branch, `${ctx.project.remote}/${branch}`], cwd);
}

/**
 * The one branch on the remote that names this issue the way a coder is told to (`fix/<words>-<n>`)
 * and is not yet in the base, or null. Two such branches are a person's to sort out, so neither is taken.
 */
function unannouncedBranch(ctx: Context, cwd: string, issue: number): string | null {
  const out = sh(ctx, ['git', 'ls-remote', '--heads', ctx.project.remote, 'refs/heads/fix/*'], cwd);
  const branches = out.split('\n').map((line) => line.trim().split(/\s+/)[1] ?? '').filter((ref) => ref.endsWith(`-${issue}`)).map((ref) => ref.replace(/^refs\/heads\//, ''));
  return branches.length === 1 ? branches[0] : null;
}

/** The commit a branch names on the remote, or null when the remote has no such branch. Throws when the remote cannot be read. */
function remoteBranchHead(ctx: Context, cwd: string, branch: string): string | null {
  const out = sh(ctx, ['git', 'ls-remote', '--heads', ctx.project.remote, `refs/heads/${branch}`], cwd);
  return out.trim().split(/\s+/)[0] || null;
}

/**
 * Whether a lane behind `baseSha` lacks only release noise (`behindBeyondNoise` is empty), which
 * the merge brings in, so no catch-up is owed and no new head restarts CI. Never when the base
 * requires an up-to-date branch: GitHub then refuses the merge until the lane holds every base
 * commit. `skipNoise` is that answer when the caller already read it; otherwise it is read here,
 * and only once the movement is known to be noise.
 */
function behindOnlyByNoise(ctx: Context, cwd: string, baseSha: string, skipNoise?: boolean): boolean {
  if (skipNoise === false || behindBeyondNoise(ctx, cwd, baseSha).length > 0) return false;
  return skipNoise ?? !requiresUpToDate(ctx);
}

/**
 * The catch-up at the seam between two Work seats: the base merged in and pushed when the lane is
 * behind, with no card move, since the card is between lanes the driver already owns. A conflict is
 * never resolved here.
 */
async function seamCatchUp(ctx: Context, issue: Issue, cwd: string, say: (message: string) => void, why: string): Promise<'conflict' | 'current' | 'caught-up'> {
  await yieldToStop(`catch up ${why}`);
  holdLease(ctx, issue.number, `catch up ${why}`);
  const baseSha = fetchBase(ctx, cwd);
  const behind = behindBase(ctx, cwd, baseSha);
  if (behind.length === 0) return 'current';
  if (behindOnlyByNoise(ctx, cwd, baseSha)) {
    say(`the base moved only by release noise (${behind.slice(0, 3).join(', ')}); the merge brings it in, so no catch-up ${why}`);
    return 'current';
  }
  say(`the base moved (${behind.slice(0, 3).join(', ')}${behind.length > 3 ? `, and ${behind.length - 3} more` : ''}); catching up ${why}`);
  await yieldToStop(`catch up ${why}`);
  if (updateFromBase(ctx, cwd, baseSha)) return 'caught-up';
  await yieldToStop(`settle catch-up conflict ${why}`);
  return 'conflict';
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
  const run = refuseEnvironmentFault(await runAgent(ctx, 'confirmer', issue.number, cwd, confirmer, prompt), 'confirmer', issue.number);
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
  mutate(ctx, `comment on #${issue.number}`, ['gh', 'issue', 'comment', String(issue.number), '--body', loopNote(body)]);
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
    SCRATCH_DIR: seatScratch(ctx, issue, 'reviewer'),
  });
  // A reviewer stopped from outside, or one that failed on the host, throws here: a full disk is
  // not a review that failed, and the work it was to review was not judged.
  const { exitCode } = refuseEnvironmentFault(await runAgent(ctx, 'reviewer', issue, cwd, ctx.seats.reviewer, prompt), 'reviewer', issue);
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
  return reviewedChecks([...runs, ...statuses]);
}

/**
 * What a landing expects from the checks the reviewed head carried. A name is expected to register
 * on the landing head only if a node under it ran at review: a name that was only ever skipped (a job
 * skipped by design, or the jobs of a run made while the pull request was a draft, whose matrix
 * names are not even expanded, as `Tests (${{ matrix.shard }}/3)`) may never register again, and
 * waiting for it holds the landing to the timeout. Which names had passed is kept too: a check that
 * passed for the reviewer and is only skipped on the head that would land has stopped running.
 */
export function reviewedChecks(all: Array<{ name: string; verdict: string | null }>): { names: string[]; passed: string[] } {
  const ran = all.filter((c) => c.verdict !== 'skipped').map((c) => c.name);
  const passed = all.filter((c) => c.verdict === 'success' || c.verdict === 'neutral').map((c) => c.name);
  return { names: [...new Set(ran)], passed: [...new Set(passed)] };
}

/**
 * Whether the base requires a branch to be up to date before it merges, by classic protection or by
 * a ruleset. When it does, a landing catches up on every base movement, release noise included, or
 * GitHub refuses it. Only a base known to require neither skips that: a denied or failed read is not
 * knowledge, so it answers true and the landing catches up as before.
 */
function requiresUpToDate(ctx: Context): boolean {
  let classic: boolean;
  try {
    classic = sh(ctx, ['gh', 'api', `repos/${ctx.project.repo}/branches/${ctx.project.baseBranch}/protection/required_status_checks`, '--jq', '.strict'], ctx.repoRoot, 1) === 'true';
  } catch (error) {
    // Only GitHub's explicit answer that the branch has no such protection lets the ruleset check decide.
    if (!/Branch not protected|Required status checks not enabled/i.test((error as Error).message)) return true;
    classic = false;
  }
  if (classic) return true;
  try {
    // The rules in force on the branch, rulesets included; readable with ordinary repository access.
    return (
      sh(ctx, ['gh', 'api', `repos/${ctx.project.repo}/rules/branches/${ctx.project.baseBranch}`, '--jq', '[.[] | select(.type == "required_status_checks") | .parameters.strict_required_status_checks_policy] | any'], ctx.repoRoot, 1) ===
      'true'
    );
  } catch {
    return true;
  }
}

/** The status checks the base branch's protection requires; none when the branch has no such rule. */
export function requiredStatusChecks(ctx: Context, read: (argv: string[]) => string = (argv) => sh(ctx, argv, ctx.repoRoot, 1)): string[] {
  try {
    return JSON.parse(read(['gh', 'api', `repos/${ctx.project.repo}/branches/${ctx.project.baseBranch}/protection/required_status_checks`, '--jq', '[.contexts[]?, .checks[]?.context] | unique'])) as string[];
  } catch {
    return []; // no protection, or no right to read it: either way nothing here names a check
  }
}

/**
 * What the checks wait came to: null when the landing head is green, a refusal's reason, or the
 * pull request's end when someone merged or closed it while the wait watched (`head` is the head it
 * was merged or closed at).
 */
export type ChecksWait = string | null | { ended: 'MERGED' | 'CLOSED'; head: string };

/** How long a check may sit queued, never started by its provider, before the checks wait calls it stuck (`stuckCheckMinutes`). */
export const DEFAULT_STUCK_CHECK_MINUTES = 30;

/** How long the checks wait keeps retrying a tracker it cannot reach before it settles as an outside stop. */
export const TRANSPORT_WINDOW_MS = 5 * 60_000;

export async function awaitGreenChecks(
  ctx: Context,
  pr: number,
  say: (message: string) => void,
  expect?: { sha: string; names?: string[]; passedAtReview?: string[]; required?: string[] },
  /** The tracker read and the wait, replaceable so a test neither shells out nor sleeps. */
  io: { read: (argv: string[]) => string; sleep: (ms: number) => Promise<void>; now: () => number } = { read: (argv) => sh(ctx, argv), sleep: (ms) => Bun.sleep(ms), now: () => Date.now() },
): Promise<ChecksWait> {
  const deadline = io.now() + ctx.knobs.checksTimeoutMinutes * 60_000;
  const stuckAfterMs = (ctx.knobs.stuckCheckMinutes ?? DEFAULT_STUCK_CHECK_MINUTES) * 60_000;
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
  // A read the tracker could not answer says nothing about the checks: it is retried with backoff,
  // inside the checks deadline and a window of its own. One that outlasts both is an outside stop
  // (`transport`), settled with nothing counted, never a landing dead letter.
  let offlineSince: number | null = null;
  let retries = 0;
  const watch = landingWatch(pr, io);
  const observe = async (): Promise<LandingObservation | null> => {
    try {
      const seen = watch.observe();
      offlineSince = null;
      retries = 0;
      return seen;
    } catch (error) {
      const text = (error as Error).message ?? '';
      if (!transportFailureIn(text)) throw error;
      const now = io.now();
      offlineSince ??= now;
      const why = text.trim().split('\n').at(-1) ?? text;
      if (now - offlineSince >= TRANSPORT_WINDOW_MS || deadline - now <= 0) {
        throw new EnvironmentFault({ kind: 'transport' }, 'landing', `the checks of PR #${pr} could not be read for ${Math.round((now - offlineSince) / 1000)}s: ${why}`);
      }
      const backoff = Math.min(5_000 * 2 ** retries, 60_000);
      retries += 1;
      say(`the tracker could not be reached (${why}); reading the checks again in ${backoff / 1000}s`);
      await stoppableSleep(Math.min(backoff, deadline - now), io.sleep);
      return null;
    }
  };
  for (;;) {
    const seen = await observe();
    if (seen === null) continue;
    // A pull request merged or closed by anyone has nothing left to wait for: the wait ends with what happened.
    if (seen.state !== 'OPEN') return { ended: seen.state, head: seen.head };
    const rollup = seen.checks;
    if (expect && seen.head !== expect.sha) {
      const gaveUp = await wait('the pull request does not show the landing head yet', 15_000);
      if (gaveUp) return gaveUp;
      continue;
    }
    if (rollup.length === 0 && (ctx.knobs.checks === 'none' || !expect)) return null;

    // A head can carry several nodes under one name: a run the repository cancelled, the skipped
    // jobs of a run made while the pull request was a draft, a rerun, and the run that counts. Judged
    // by name, then, and by the newest run under it, as required checks are: ordered by completion,
    // else start, else first sighting, a newer failure overrides an older pass, a newer pass an older
    // failure, and a newer run still going keeps the name pending. Skipped and cancelled nodes reach
    // no verdict and are passed over here. Runs that cannot be ordered are read fail-closed: a
    // failure before a running one, a running one before a pass.
    const byName = new Map<string, CheckObservation[]>();
    for (const c of rollup) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
    const RANK: Partial<Record<CheckStatus, number>> = { failed: 3, pending: 2, passed: 1 };
    const newest = (nodes: CheckObservation[]): CheckObservation | null =>
      nodes.filter((c) => RANK[c.status]).reduce<CheckObservation | null>((best, c) => (!best || c.at > best.at || (c.at === best.at && (RANK[c.status] ?? 0) > (RANK[best.status] ?? 0)) ? c : best), null);
    const standing = new Map([...byName].map(([name, nodes]) => [name, newest(nodes)?.status ?? null] as const));
    const failed = [...byName.values()].filter((nodes) => standing.get(nodes[0].name) === 'failed');
    if (failed.length > 0) {
      return `checks failed: ${failed.map((nodes) => `${nodes[0].name} (${newest(nodes)?.verdict})`).join(', ')}`;
    }

    const pending = [...byName.values()].filter((nodes) => standing.get(nodes[0].name) === 'pending');
    if (pending.length > 0) {
      // A check its provider never started, queued past the threshold, is stuck, not slow: waiting
      // out the checks timeout on it ends in a dead letter for a change nobody faulted. It ends the
      // wait as an outside stop that names the check and its provider.
      const now = io.now();
      const stuck = pending
        // The runs newer than the name's newest verdict: an older queued run a newer one superseded holds nothing.
        .map((nodes) => {
          const verdicts = nodes.filter((c) => c.status === 'passed' || c.status === 'failed').map((c) => c.at);
          const since = verdicts.length > 0 ? Math.max(...verdicts) : -Infinity;
          return nodes.filter((c) => c.status === 'pending' && c.at >= since);
        })
        .filter((running) => running.every((c) => c.queued) && now - Math.min(...running.map((c) => c.firstSeen)) >= stuckAfterMs)
        .map((running) => ({ check: running[0].name, provider: running[0].provider, minutes: Math.round((now - Math.min(...running.map((c) => c.firstSeen))) / 60_000) }));
      if (stuck.length > 0) {
        const named = stuck.map((s) => `${s.check} (${s.provider}, queued ${s.minutes} minutes and never started)`).join(', ');
        say(`stuck check(s) on PR #${pr}: ${named}`);
        throw new EnvironmentFault({ kind: 'stuck-check', check: stuck[0].check, provider: stuck[0].provider }, 'landing', `a check on PR #${pr} is stuck in its provider's queue: ${named}`);
      }
      const gaveUp = await wait(`checks still unfinished: ${pending.map((nodes) => nodes[0].name).join(', ')}`, 30_000);
      if (gaveUp) return gaveUp;
      continue;
    }

    // What is left under a name with no pass is skipped or cancelled. A name somebody expects is
    // not satisfied by being skipped, or a landing could merge with no check having run; a cancelled
    // node with no passing sibling has no verdict either. Which names must have run: the written
    // list, the config's and the base branch's, and every check that had passed on the head the
    // reviewer read. Not every name that head carried: a repository can have jobs skipped on every
    // pull request by design (a release, a deploy on push), those were skipped at review too, and
    // waiting for them to pass would hold every landing to the timeout. A check that passed at
    // review and is only skipped now is the other case: it stopped running, and the approval counted on it.
    const mustRun = new Set([...authoritative, ...(expect?.passedAtReview ?? [])]);
    const unjudged = [...byName.entries()]
      .map(([name, nodes]) => [name, nodes.map((c) => c.status)] as const)
      .filter(([name, kinds]) => standing.get(name) === null && (kinds.includes('cancelled') || mustRun.has(name)))
      .map(([name, kinds]) => `${name} (${[...new Set(kinds)].join(' and ')})`);
    if (unjudged.length > 0) {
      const gaveUp = await wait(`no check has reached a verdict under: ${unjudged.join(', ')}`, 30_000);
      if (gaveUp) return gaveUp;
      continue;
    }

    // Everything visible has passed. It is the whole list only when every expected check is in it
    // and nothing GitHub has opened on this head is still running or still to register.
    if (!expect) return null;
    const present = new Set(rollup.map((c) => c.name));
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
 * current base: not a revision, not a review, not a merge. A lane that is behind merges the base in
 * (never a rebase) and pushes; what that costs is decided separately, by whether the movement
 * reached the paths the proof or the approval covers. The one exception is a base that moved only
 * by release noise (`behindOnlyByNoise`), which the merge brings in without a catch-up.
 *
 * `since` is the commit the standing proof or verdict was pinned to. Returns null when the lane
 * already holds the base, or lacks only release noise; `conflict` when the merge could not apply, which the pipeline never
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

/** Pull requests whose boundary waiver is already on the thread: a reproof re-enters the landing, and the note says it once. */
const waiverNoted = new Set<number>();

export async function catchUp(ctx: Context, issue: Issue, cwd: string, since: string, say: (message: string) => void, why: string, options: { skipNoise?: boolean } = {}): Promise<CaughtUp | 'conflict' | null> {
  // A catch-up merges the base in and pushes the lane's branch; every wait in a landing can
  // outlast the lease, so every catch-up asks for it first.
  await yieldToStop(`catch up ${why}`);
  holdLease(ctx, issue.number, `catch up ${why}`);
  if (ctx.dryRun) return null;
  // One fetch, one commit: the behind check, the overlap, the contribution comparison, and the
  // merge all use this base. A base that moves again meanwhile is the next catch-up's business.
  const baseSha = fetchBase(ctx, cwd);
  const behind = behindBase(ctx, cwd, baseSha);
  if (behind.length === 0) return null;
  if (behindOnlyByNoise(ctx, cwd, baseSha, options.skipNoise)) {
    say(`the base moved only by release noise (${behind.slice(0, 3).join(', ')}); the merge brings it in, so no catch-up`);
    return null;
  }
  // Both judged before the merge: afterwards the merge base is the base's own tip and every
  // comparison against it is vacuously empty.
  const overlap = staleAgainstBase(ctx, cwd, since, baseSha);
  const before = sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);
  const idBefore = netChangeId(cwd, baseSha, before);
  say(`the base moved (${behind.slice(0, 3).join(', ')}${behind.length > 3 ? `, and ${behind.length - 3} more` : ''}); catching up ${why}`);
  await yieldToStop(`catch up ${why}`);
  move(ctx, issue, 'F2', `catching up ${why}`);
  if (!updateFromBase(ctx, cwd, baseSha)) {
    await yieldToStop(`settle catch-up conflict ${why}`);
    return 'conflict';
  }
  const after = sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);
  const idAfter = netChangeId(cwd, baseSha, after);
  return { before, after, overlap, netChangeIntact: idBefore !== '' && idBefore === idAfter };
}

export type Reviewed = { review: ReviewResult; reviewedSha: string };
/** A review that produced no trusted verdict says which dead-letter queue owns the reason. */
export type DeadLetter = { dlq: DlqPhase; reason: string };
/**
 * `park` hands the landing to a person (the merge boundary, marked `boundary`, or the issue changed under the review);
 * `dlq` is a landing the machine could not complete (a conflict, red checks, a failed smoke, a
 * refused line, an unreported merge), which the landing queue's triage may retry.
 */
export type Landing = 'merged' | 'revise' | 'stale' | { reproof: CaughtUp } | { park: string; boundary?: true } | { dlq: string };

/** How long the smoke command may run before the landing is a dead letter as unbootable. */

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
  /** The worker's classification, recorded with an approval beside the reviewer's. */
  touches?: WorkerResult['touches'],
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
  if (verdict.decision === 'merge') {
    // The approval is a fact a later run reads from the thread (what stopped the work since is
    // newer than it), so it is recorded there, pinned to the head the reviewer read.
    // Both seats' classification rides on the record, so a landing of this same head can rest on it.
    const classified = validTouches(touches) && validTouches(verdict.touches) ? [...new Set([...(touches ?? []), ...(verdict.touches ?? [])])].join(',') : undefined;
    mutate(ctx, `record the approval of PR #${pr} on #${issue.number}`, ['gh', 'issue', 'comment', String(issue.number), '--body', stopComment('approved', { sha: reviewedSha, pr, touches: classified }, `**Approved** at \`${reviewedSha.slice(0, 12)}\` on pull request #${pr}; landing next.`)]);
    move(ctx, issue, 'F1', `approved at ${reviewedSha.slice(0, 10)}`);
  }
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
    // A revision never begins on a stale lane: whatever the base changed beyond release noise, the
    // author revises against current code rather than against the base as it stood when this branch started.
    if (await catchUp(ctx, issue, cwd, reviewedSha, say, 'before the revision') === 'conflict') {
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
  const touched = effective?.join(', ') ?? 'unstated';
  // A driver can keep an issue's merge for a person whatever autoMerge says; its reason rides on the
  // boundary's own, so the park still reads as the boundary's and `--land` still waives it.
  const held = ctx.holdAtBoundary?.(issue, { cwd, base: `${ctx.project.remote}/${ctx.project.baseBranch}` }) ?? null;
  const heldNote = held ? `; ${held}` : '';
  const allowed = held === null && mergeAllowed(ctx, effective);
  if (!allowed && boundaryWaived(ctx.landPastBoundary, issue.number, effective)) {
    // A person cleared this landing past the boundary; every gate below still holds, and a missing
    // classification is not waived (boundaryWaived fails closed on it).
    say(`the merge boundary would park this (autoMerge: ${ctx.knobs.autoMerge}, touches ${touched}${heldNote}); a person cleared it with --land`);
    if (!waiverNoted.has(pr)) {
      waiverNoted.add(pr);
      mutate(ctx, `note the boundary waiver on PR #${pr}`, [
        'gh',
        'pr',
        'comment',
        String(pr),
        '--body',
        `Cleared by a person to land past the merge boundary (\`fix.ts --land\`): autoMerge is ${ctx.knobs.autoMerge} and this change touches ${touched}${heldNote}. It merges only if the freshness, check, smoke, and line gates all pass.`,
      ]);
    }
  } else if (!allowed) {
    mutate(ctx, `park PR #${pr} (autoMerge: ${ctx.knobs.autoMerge}, touches ${touched}${heldNote})`, [
      'gh',
      'pr',
      'edit',
      String(pr),
      '--add-label',
      'loop/parked',
    ]);
    return { park: `autoMerge is ${ctx.knobs.autoMerge} and the change touches ${effective?.join(', ') ?? 'categories nobody stated'}${heldNote}`, boundary: true };
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
  // Release noise on the base is merged in by the merge itself, unless protection insists on an up-to-date branch.
  const skipNoise = !ctx.dryRun && !requiresUpToDate(ctx);
  /** The base commit this lane held at its last look upstream. */
  let baseSeen = '';
  /** The base commit of the last look upstream; its commits were judged then. */
  let lastLook: string | undefined;
  /** Moves counted against the refresh cap, moves made only of release noise, and every commit that moved the base. */
  let refreshes = 0;
  let noiseMoves = 0;
  const movers: BaseCommit[] = [];
  /** Set when someone else merged the pull request while this landing watched its checks. */
  let mergedElsewhere = false;
  for (;;) {
    const caught = await catchUp(ctx, issue, cwd, landingSha, say, 'before the merge', { skipNoise });
    if (caught === 'conflict') {
      say(`conflicts with ${ctx.project.baseBranch}; a human has to resolve it`);
      return { dlq: `the branch conflicts with ${ctx.project.baseBranch}` };
    }
    if (caught) {
      // The catch-up is already merged and pushed, so the next pass's own catch-up finds nothing
      // behind; it is handed back whole, so the proof is reacquired rather than only re-reviewed.
      if (caught.overlap.length > 0) {
        say(`base moved into this work (${caught.overlap.join(', ')}); the approval no longer describes what would land`);
        return { reproof: caught };
      }
      if (!caught.netChangeIntact) {
        say('the catch-up changed what this branch contributes; the approval no longer describes what would land');
        return { reproof: caught };
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
      const beyondNoise = behindBeyondNoise(ctx, cwd, checked);
      if ((skipNoise ? beyondNoise : behindBase(ctx, cwd, checked)).length === 0) {
        baseSeen = checked;
        lastLook = checked;
        return 'fresh';
      }
      // What the move changed decides what it costs, never who made it. Release machinery follows
      // every merge, so a move made only of release noise (reached here only when protection wants an
      // up-to-date branch) still catches up but is not counted against the refresh cap; it has a
      // larger bound of its own, so a stream of them cannot loop forever.
      const moved = commitsBehind(ctx, cwd, checked, lastLook);
      lastLook = checked;
      movers.unshift(...moved);
      const byNoise = beyondNoise.length === 0;
      if (byNoise) noiseMoves += 1;
      else refreshes += 1;
      const total = refreshes + noiseMoves;
      const named = movers.length > 0 ? `; the commits that moved it: ${describeCommits(movers)}` : '';
      if (refreshes > MAX_BASE_REFRESHES) {
        return { dlq: `the base moved ${total} times while this landing waited on its gates (${refreshes} beyond release noise)${named}; it needs a quiet base or a person` };
      }
      if (noiseMoves > MAX_NOISE_REFRESHES) {
        return { dlq: `the base moved ${total} times while this landing waited on its gates (${noiseMoves} only by release noise, past that bound of ${MAX_NOISE_REFRESHES})${named}; it needs a quiet base or a person` };
      }
      say(`the base moved ${after}${byNoise ? ' only by release noise, not counted against the refresh cap' : ''}; catching up again before anything else`);
      return 'again';
    };

    move(ctx, issue, 'F3', `PR #${pr} at ${landingSha.slice(0, 10)}`);
    const notGreen = await awaitGreenChecks(ctx, pr, say, ctx.dryRun ? undefined : { sha: landingSha, names: reviewedChecks.names, passedAtReview: reviewedChecks.passed, required: requiredByBase });
    holdLease(ctx, issue.number, 'act on the checks of the landing head');
    if (notGreen !== null && typeof notGreen === 'object') {
      if (notGreen.ended === 'CLOSED') {
        say(`PR #${pr} was closed while its checks were waited on; a person decides what follows`);
        return { park: `pull request #${pr} was closed while its checks were waited on` };
      }
      // Merged by a person or another writer: the merge stands, and its bookkeeping is still owed.
      say(`PR #${pr} was merged at ${notGreen.head.slice(0, 10)} while its checks were waited on; recording the merge`);
      landingSha = notGreen.head;
      mergedElsewhere = true;
      break;
    }
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
      const permission = await ctx.mayMerge(issue);
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
      // A hold on the pull request is a person's word too, whatever the issue carries.
      const held = pullHolds(ctx, pr)[0];
      if (held) {
        say(`refusing to merge PR #${pr}: it carries ${held}`);
        return { park: `pull request #${pr} carries \`${held}\`; it merges once that label is off the pull request` };
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
  if (!mergedElsewhere) {
    await yieldToStop(`merge PR #${pr}`);
    // The yield lets a failed renewal be heard too: the lease is asked for once more, last of all.
    holdLease(ctx, issue.number, `merge PR #${pr}`);
    mutate(ctx, `merge PR #${pr}`, ['gh', 'pr', 'merge', String(pr), '--merge', '--match-head-commit', landingSha]);
  }

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
    await recordMerge(ctx, { issue: issue.number, title: issue.title, pr, sha: landingSha, mergedAt: merged, paths, unseenBase: unseenBase ?? undefined }, {
      place: (note) => move(ctx, issue, 'T1', note),
      note: `PR #${pr} merged ${merged}`,
      by: 'worker',
      comment: `Closed by #${pr}.`,
      reason: `merged #${pr}`,
      mergeSha: reviewedSha,
      beforeClose: () => {
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
      },
      // Read once more before the close. The merge has landed either way; a refusal here parks the
      // issue with the merge named, so a person sees a closed pull request against an open issue.
      gate: () => {
        // A lost lease is not a changed issue, and it is not this run's to park.
        holdLease(ctx, issue.number, 'read the gate before an act on the issue');
        const gate = liveGate(ctx, trackerIo(ctx), issue.number, ceiling);
        if (gate.ok) return null;
        say(`merged PR #${pr} but not closing the issue: ${gate.why}`);
        return gate.why;
      },
    });
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
      // The thread is read before anything closes: a read that throws then leaves the pull request
      // open and the answer recoverable, rather than closed with the answer only in a lane file.
      const marker = `<!-- carve-answer issue=${issue.number} -->`;
      const already = ctx.dryRun ? false : trackerIo(ctx).view(issue.number)?.comments.some((c) => c.author === ctx.botLogin && c.body.startsWith(marker));
      closePullRequest();
      if (!already) mutate(ctx, `post the answer on #${issue.number}`, ['gh', 'issue', 'comment', String(issue.number), '--body', `${marker}\n${result.answer ?? ''}`]);
      await closeIssue(ctx, issue.number, `Answered; see the answer above. Independently re-checked: ${confirmation.reason}`, { kind: 'answered', reason: 'answered', by: 'worker' });
      move(ctx, issue, 'T2', 'answered');
      retireLane(ctx, issue.number, say);
      return { outcome: 'closed', reason: result.reason };
    }

    case 'needs-decision':
    case 'needs-human': {
      // A prover's ask comes after the code was pushed and announced, and a coder's on a pull request
      // it was continuing comes with that pull request's work already reviewed: either is an outside
      // stop that waits on a person with the pull request held open, never a reason to close it.
      if (result.verdict === 'needs-human' && (result.seat === 'prover' || pr)) return holdForAPerson(ctx, issue, result, say, pr);
      // Comment first, then the label that hides the issue from selection. The comment is the stop's
      // record on the thread, so it outranks any held proof an earlier seat left.
      mutate(ctx, `comment on #${issue.number}`, ['gh', 'issue', 'comment', String(issue.number), '--body', heldComment(result.verdict, result.reason)]);
      // A question the worker raised is weighed by a decision panel first, when one can sit; one it
      // settles goes back to be appraised with the receipt as its ruling, and holds nobody up.
      if (result.verdict === 'needs-decision') {
        const weighed = await weighHold(ctx, { issue: issue.number, title: issue.title, question: result.reason, raiser: ctx.seats.worker });
        if (weighed.kind === 'unavailable') say(`no decision panel (${weighed.why}); held for a person`);
        if (weighed.kind === 'proceed') {
          clearSizeLabels(ctx, issue.number);
          closePullRequest();
          move(ctx, issue, 'A1', 'decided by review; back to appraisal');
          retireLane(ctx, issue.number, say);
          return { outcome: 'handed-off', reason: 'the decision review settled the question; back to appraisal' };
        }
      }
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
    }

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
 * A seat that needs a person, where the work is already on a pull request or pushed: an outside
 * stop that waits on one. A prover's ask (access, credentials, a shared record it may not touch)
 * answers after the code was pushed and announced; a coder's, on a pull request it was continuing,
 * leaves that pull request's approval and receipts standing, and a gate it found failing on the
 * untouched base (`outside: 'base'`) is not the change's at all. The work is held where it stands
 * rather than thrown away: the pull request stays open (back in draft when the coder was continuing
 * it), the issue and the pull request both carry `needs-human`, and the issue says what is missing
 * and how the hold comes off. The lane is retired as on every other exit (a lane holding a coder's
 * uncommitted edit is kept); the branch is on the remote, and the pickup checks it out afresh.
 *
 * Lifting the issue's label is the whole pickup. The issue goes back to where its facts put it:
 * Drafted or Ready for review with this pull request, where the burndown resumes it (a held proof
 * from Proving, a coder's hold with its own words as the coder's brief), or, with no pull request,
 * Ready, where the coded announcement is proved rather than coded again. `fix.ts --redrive` does the
 * same at once. The pickup takes the pull request's label off with the issue's, and a label still
 * on the pull request at the merge gate refuses the merge.
 */
function holdForAPerson(ctx: Context, issue: Issue, result: WorkerResult, say: (message: string) => void, pr?: number): FixOutcome {
  holdLease(ctx, issue.number, 'hold the work for a person');
  const branch = result.branch ?? '';
  const prover = result.seat === 'prover';
  const cause = !prover && result.outside === 'base' ? 'base' : 'needs-person';
  settleOutsideStop(ctx, issue, { cause, seat: prover ? 'prover' : 'coder', reason: result.reason }, prover ? 'proving' : 'coding', say, {
    pr,
    continuation: !prover,
    // A held proof keeps the record its pickup reads.
    record: prover ? proofHeldComment(ctx.runId, { branch, pr }, result.reason) : undefined,
  });
  say(`the ${prover ? 'prover' : 'coder'} needs a person; ${pr ? `PR #${pr} stays open, ` : ''}held with needs-human`);
  move(ctx, issue, 'H2', `${prover ? 'proof held' : cause === 'base' ? 'base fails its gate' : 'held'}: ${result.reason}`.slice(0, 120));
  retireLane(ctx, issue.number, say);
  return { outcome: 'handed-off', reason: result.reason };
}

/** The hold labels a person may put on a pull request itself; one standing at the merge gate refuses the merge. */
export const PULL_HOLD_LABELS = ['needs-human', 'needs-decision', 'loop/skip'];

/** The holds a person's labels put on a pull request; throws when the labels cannot be read, since unknown is not "none". */
function pullHolds(ctx: Context, pr: number): string[] {
  const labels = sh(ctx, ['gh', 'pr', 'view', String(pr), '--json', 'labels', '--jq', '.labels[].name']).split('\n').map((l) => l.trim());
  return labels.filter((label) => PULL_HOLD_LABELS.includes(label));
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
  /** An approval standing on the head in hand, which goes straight to the landing on the first pass. */
  standing?: Reviewed,
): Promise<FixOutcome> {
  let result = first;
  let approved = standing;
  let consumed = reviewCount(issue.labels);
  let refreshes = 0;
  // Why the work stopped, carried to the park comment so the reason lives on the issue rather
  // than only in this run's log. Only a person's call parks; a machine's failure is a dead letter.
  let parkReason = 'the loop worked this issue and could not finish the call';
  /** A boundary park is recorded as one, so `--land` can tell it from every other. */
  let parkKind: 'park' | 'boundary' = 'park';
  // A budget already spent when the work arrives here (a resume, a redrive nobody reset) is the
  // review queue's, as it is when the last round is spent below: a machine's limit, not a person's call.
  // A landing on a standing approval runs no review, so a spent budget does not stop it.
  if (consumed >= ctx.knobs.maxReviewRounds && !ctx.dryRun && !standing) {
    return deadLetter(ctx, issue, 'review', `The review budget of ${consumed} rounds was already spent when this pull request came back for review.`, say, result.pr);
  }
  /** A catch-up the merge gate already made, whose movement reached this work: the next pass reproves from it. */
  let caughtAtLanding: CaughtUp | null = null;
  while (approved || consumed < ctx.knobs.maxReviewRounds) {
    if (!result.pr) return deadLetter(ctx, issue, 'work', 'The worker reported a fix but named no pull request.', say);
    const pr = result.pr;
    const touches = result.touches;

    if (ctx.dryRun) break;

    // An approval that still stands on this very head, judged by the redrive before anything moved
    // (`approvedAtHead`), is the review: no catch-up is owed and nothing new was pushed.
    let reviewed: Reviewed | DeadLetter;
    if (approved) {
      reviewed = approved;
      approved = undefined;
    } else {
      // No review begins on a stale lane. The proof was captured at the current head; a base that
      // moved since is merged in first, so the reviewer judges what would actually land. Movement
      // that reached the paths the proof covers means the world moved beneath the proof: the work
      // goes back to its author to reacquire it, which is upstream churn and spends no round.
      const proofHead = sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);
      const current = caughtAtLanding ?? await catchUp(ctx, issue, cwd, proofHead, say, 'before the review');
      caughtAtLanding = null;
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
      reviewed = await review(ctx, issue, pr, cwd, say, consumed + 1, touches);
    }
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
    // The merge gate's catch-up reached what the proof covers: back to the top, where the reproof
    // branch counts the refresh and sends the work to have its proof reacquired.
    if (typeof outcome === 'object' && 'reproof' in outcome) {
      caughtAtLanding = outcome.reproof;
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
      if (outcome.boundary) parkKind = 'boundary';
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
  parkIssue(ctx, issue.number, parkReason, parkKind);
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
 * The live gate and the claim a lane starts under, or the outcome that stops it before it starts.
 *
 * Without `lift`, the gate comes first and nothing is claimed for an issue it refuses. A person's
 * redrive or landing passes `lift`, which removes the hold that stopped the issue. The gate refuses
 * a held issue, so there the claim is taken first and the hold lifted under it: a run that reads
 * the issue between those writes sees the hold or the claim, never neither, and leaves its lane
 * alone. A refusal, or a lift that throws, releases the claim.
 */
export async function claimLane(
  ctx: Context,
  io: TrackerIo,
  issue: number,
  ceiling: number,
  say: (message: string) => void,
  lift?: () => void,
): Promise<ClaimHandle | FixOutcome> {
  if (!lift) {
    const gate = liveGate(ctx, io, issue, ceiling);
    if (!gate.ok) {
      say(`left alone: ${gate.why}`);
      return { outcome: gate.outcome, reason: gate.why };
    }
    const handle = await claim(ctx, io, issue, 'working');
    return handle === 'busy' ? { outcome: 'busy', reason: 'another run holds this issue' } : handle;
  }
  // Read before the claim: a claim that succeeds clears the record of a lease this run lost.
  if (leaseLost(ctx, issue)) {
    const why = 'this run lost its lease on the issue: its renewals failed until the claim ran out';
    say(`left alone: ${why}`);
    return { outcome: 'busy', reason: why };
  }
  const handle = await claim(ctx, io, issue, 'working');
  if (handle === 'busy') return { outcome: 'busy', reason: 'another run holds this issue' };
  const letGo = () => {
    try {
      handle.release();
    } catch (error) {
      say(`could not release the claim: ${(error as Error).message}`);
    }
  };
  let gate: ReturnType<typeof liveGate>;
  try {
    lift();
    gate = liveGate(ctx, io, issue, ceiling);
  } catch (error) {
    letGo();
    throw error;
  }
  if (!gate.ok) {
    say(`left alone: ${gate.why}`);
    letGo();
    return { outcome: gate.outcome, reason: gate.why };
  }
  return handle;
}

/**
 * A lane's life under a claim: claimed (`claimLane`, with the person's `lift` when there is one),
 * leased, opened, worked, and released. Every driver that works an issue in a lane goes through it.
 *
 * Everything after the claim is inside the try: a lane that cannot be opened must not leave a claim
 * behind that keeps renewing itself with nobody working under it. A throw is recorded in the queue
 * of the lane it happened in (`recordThrow`, against `pr` when the lane continues one). Whatever the
 * outcome, the claim and the lease end here and the lane is retired, unless the throw could not be
 * recorded on the issue: the worktree is then the only record of what happened. A crash never runs
 * the cleanup, which is exactly when the resume path should get its chance. A claim refused returns
 * its outcome and opens nothing.
 */
export async function withLane(
  ctx: Context,
  issue: Issue,
  say: (message: string) => void,
  lane: { ceiling: number; lift?: () => void; pr?: number; open: () => string },
  work: (cwd: string) => Promise<FixOutcome>,
): Promise<FixOutcome> {
  const handle = await claimLane(ctx, trackerIo(ctx), issue.number, lane.ceiling, say, lane.lift);
  if ('outcome' in handle) return handle;
  const stopRenewing = keepClaimed(handle, () => {
    // The lease ran out unrenewed: another run may hold the issue now, so this one's agent stops.
    const killed = killAgentsOn(ctx.project.repo, issue.number);
    ctx.log(`#${issue.number}  lost its lease (renewals failed until the claim ran out); stopped ${killed} agent(s)`);
  });
  let keepLane = false;
  try {
    const cwd = lane.open();
    inFlight.set(issue.number, { dir: cwd, busy: false });
    // Awaited, not returned: a returned promise would run the cleanup below while the work it
    // guards is still going.
    return await work(cwd);
  } catch (error) {
    const recorded = recordThrow(ctx, issue, error as Error, say, lane.pr);
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
    // Nothing in-process reads the directory again, and the resume path resumes only a `fixed`
    // verdict whose pull request is open at the same head on an unlabelled issue; every outcome
    // that reaches this line is one it already refuses. Removing the worktree also sweeps the
    // `issue-N-<scratch>` siblings agents make for evidence capture, which nothing else reclaims.
    if (!ctx.dryRun && !keepLane) retireLane(ctx, issue.number, say);
  }
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
  /** `lift`: a person's redrive, which removes the hold under this run's claim; see `claimLane`. */
  options: { maxPoints?: number; ceiling?: number; confirmer?: Seat; lift?: () => void } = {},
): Promise<FixOutcome> {
  // Lanes interleave, so every line an issue emits names the issue. Without this the console is a
  // shuffled deck of verdicts with no way to tell which belongs to which.
  const say = (message: string) => ctx.log(`#${issue.number}  ${message}`);
  ctx.step(`#${issue.number} ${issue.title}`);
  rememberFaultMarkers(ctx, issue.number, issue.labels);
  // An issue the knife judged one piece is worked at its own size: the worker is not asked to fit
  // it under a ceiling the knife already said it cannot be cut to.
  const maxPoints = ceilingFor((issue.labels ?? []).map((l) => l.name), labelPoints(issue.labels ?? []), options.maxPoints ?? DEFAULT_MAX_POINTS);
  const ceiling = options.ceiling ?? maxPoints;
  if (options.confirmer) ctx.seats.confirmer = options.confirmer;
  assertDistinctEngines(ctx.seats.worker, ctx.seats.confirmer ?? ctx.seats.reviewer, 'worker and confirmer');

  // The live gate and the claim, then the lane: nothing is created for an issue this run may not work.
  return withLane(ctx, issue, say, {
    ceiling,
    lift: options.lift,
    // Even in a dry run the path is the worktree's, never the main checkout, so nothing downstream
    // learns to treat the main checkout as a valid agent working directory.
    open: () => (ctx.dryRun ? resolve(ctx.repoRoot, ctx.project.worktreeRoot, `issue-${issue.number}`) : worktreeFor(ctx, issue.number)),
  }, async (cwd) => await workIssue(ctx, issue, cwd, maxPoints, ceiling, say));
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
    // Edits nobody committed live only in this directory, and a forced removal deletes them; a lane
    // a review refused for its dirty tree is exactly where they are. It is kept for a person.
    const dirty = dirtyPaths(ctx, cwd);
    if (dirty.length > 0) {
      say(`keeping the lane: it holds uncommitted changes (${dirty.slice(0, 3).map((line) => line.slice(3)).join(', ')}${dirty.length > 3 ? ', ...' : ''})`);
      return false;
    }
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
      const rescued = rescueRef(ctx, issue, sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd), cwd);
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

/**
 * Clears a lane an environment fault interrupted, so the rerun starts clean. Kept dirty, it would
 * be judged after all: a fresh worker refuses a dirty lane, and a later run's reconcile sends one
 * with no pull request to the work dead letter. Commits no remote has get a ref of their own first,
 * so nothing committed is lost; what is uncommitted was the interrupted run's, whose answer is not
 * trusted. A lane that cannot be cleared is left where it is, and said so.
 *
 * A lane that holds a prover's proof of its head, clean and on a remote, is kept: the proof is the
 * finished work a resume picks up from (`findStranded`), and clearing it would prove the same
 * commit again.
 */
export function clearLaneForRerun(ctx: Context, issue: number, say: (message: string) => void): void {
  if (ctx.dryRun) return;
  const cwd = resolve(ctx.repoRoot, ctx.project.worktreeRoot, `issue-${issue}`);
  if (!existsSync(cwd)) return;
  try {
    if (holdsProof(ctx, cwd)) {
      say('kept the lane: it holds the proof of its pushed head, which the rerun resumes from');
      return;
    }
    if (Number(sh(ctx, ['git', 'rev-list', '--count', 'HEAD', '--not', '--remotes'], cwd)) > 0) {
      const rescued = rescueRef(ctx, issue, sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd), cwd);
      say(`saved the lane's unpushed commits as ${rescued}`);
    }
    removeWorktree(ctx, issue);
    say('cleared the lane for the rerun');
  } catch (error) {
    say(`could not clear the lane for the rerun (${(error as Error).message.split('\n')[0]}); it is kept`);
  }
}

/** A proved answer in the lane, nothing uncommitted beside it, and a head some remote has. */
function holdsProof(ctx: Context, cwd: string): boolean {
  if (parseJsonFile<{ verdict?: string }>(join(cwd, PROOF_FILE))?.verdict !== 'proved') return false;
  if (dirtyPaths(ctx, cwd).length > 0) return false;
  return Number(sh(ctx, ['git', 'rev-list', '--count', 'HEAD', '--not', '--remotes'], cwd)) === 0;
}

export function recordThrow(ctx: Context, issue: Issue, error: Error, say: (message: string) => void, knownPr?: number): { outcome: FixOutcome; keepLane: boolean } {
  const lane = lastLane.get(laneKeyOf(ctx, issue.number));
  let reason = `The pipeline threw${lane ? ` in ${lane}` : ''}: ${error.message.split('\n').slice(0, 6).join(' | ')}`;
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
  // Nor is an environment fault: a full disk, exhausted memory, or a person's stop says nothing
  // about the work, which was not judged. It is an outside stop, settled in one place
  // (`settleOutsideStop`): nothing is counted or held, the stop is recorded on the issue, the next
  // placement puts the card by its facts, the lane is cleared for the rerun here (so the cleanup
  // below has nothing left to retire), and a host fault pauses the line. The one charged case, the
  // same host fault again on the rerun, falls through and is settled below as the failure it then is.
  const fault = environmentFaultOf(error);
  if (fault) {
    const settled = settleOutsideStop(ctx, issue, { fault }, lane ?? '', say);
    if (!settled.charged) {
      clearLaneForRerun(ctx, issue.number, say);
      // The same outside stop run after run waits on a person (`OUTSIDE_REPEAT_BOUND`).
      if (settled.held) {
        move(ctx, issue, 'H2', settled.reason.slice(0, 120));
        return { outcome: { outcome: 'handed-off', reason: settled.reason }, keepLane: true };
      }
      return { outcome: { outcome: 'unjudged', reason: settled.reason, fault: fault.kind }, keepLane: true };
    }
    reason = `The pipeline threw${lane ? ` in ${lane}` : ''}, and ${settled.reason}: ${error.message.split('\n')[0]}`;
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
 * The approval a continuation lands on without proving or reviewing again, or null when the work
 * owes either. All of these must hold: the newest approval on the thread since the pull request
 * opened still stands (`standingApproval`: nothing but a boundary park or an outside stop that
 * reruns the work is newer), it names both seats' classification, it was given to this pull request
 * at the head the lane and the pull request both hold, the pull request is ready, the base needs no
 * catch-up (by the landing's own rule for release noise), and the checks on that head are green now,
 * judged by the newest run under each name. A head that moved, an approval for another commit, or
 * checks that are not green keep the usual path.
 */
async function approvedAtHead(
  ctx: Context,
  pr: number,
  cwd: string,
  comments: Array<{ author?: string; body: string; createdAt?: string }>,
  since: string,
  say: (message: string) => void,
): Promise<Reviewed | null> {
  const approval = standingApproval(comments, { botLogin: ctx.botLogin, since });
  if (!approval || (approval.pr !== undefined && approval.pr !== pr)) return null;
  const touches = validTouches(approval.touches);
  if (!touches) return null;
  const sha = approval.sha;
  if (sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd) !== sha) return null;
  const view = JSON.parse(sh(ctx, ['gh', 'pr', 'view', String(pr), '--json', 'headRefOid,isDraft'])) as { headRefOid: string; isDraft: boolean };
  if (view.headRefOid !== sha || view.isDraft) return null;
  const base = fetchBase(ctx, cwd);
  if ((requiresUpToDate(ctx) ? behindBase(ctx, cwd, base) : behindBeyondNoise(ctx, cwd, base)).length > 0) return null;
  if (ctx.knobs.checks !== 'none') {
    // One look, no wait: green now, by the landing's own rules, or the usual path.
    const reviewedChecks = checksOn(ctx, sha);
    const now = { ...ctx, knobs: { ...ctx.knobs, checksTimeoutMinutes: 0 } };
    const green = await awaitGreenChecks(now, pr, () => {}, { sha, names: reviewedChecks.names, passedAtReview: reviewedChecks.passed, required: requiredStatusChecks(ctx) });
    if (green !== null) return null;
  }
  say(`PR #${pr} was approved at ${sha.slice(0, 10)}, which it still holds, the base needs no catch-up, and its checks are green; landing on that approval`);
  return {
    review: { pr, decision: 'merge', adequacy: `Approved at ${sha.slice(0, 12)}; the approval stands on the thread.`, confidence: 'standing approval', blocking: [], touches },
    reviewedSha: sha,
  };
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
  /** `landing`: a person's --land; with no objection, the brief says the change was approved and parked by policy. */
  /** `lift`: the person's removal of the hold, made under this run's claim; see `claimLane`. */
  options: { maxPoints?: number; ceiling?: number; confirmer?: Seat; landing?: boolean; lift?: () => void } = {},
): Promise<FixOutcome> {
  const say = (message: string) => ctx.log(`#${issue.number}  ${message}`);
  rememberFaultMarkers(ctx, issue.number, issue.labels);
  ctx.step(`#${issue.number} ${issue.title} (${objection === null ? 'resuming' : 'redrive of'} PR #${pull.number})`);
  // An issue the knife judged one piece is worked at its own size: the worker is not asked to fit
  // it under a ceiling the knife already said it cannot be cut to.
  const maxPoints = ceilingFor((issue.labels ?? []).map((l) => l.name), labelPoints(issue.labels ?? []), options.maxPoints ?? DEFAULT_MAX_POINTS);
  const ceiling = options.ceiling ?? maxPoints;
  if (options.confirmer) ctx.seats.confirmer = options.confirmer;
  assertDistinctEngines(ctx.seats.worker, ctx.seats.confirmer ?? ctx.seats.reviewer, 'worker and confirmer');

  return withLane(ctx, issue, say, {
    ceiling,
    lift: options.lift,
    pr: pull.number,
    open: () => (ctx.dryRun ? resolve(ctx.repoRoot, ctx.project.worktreeRoot, `issue-${issue.number}`) : worktreeAtPullRequest(ctx, issue.number, pull.branch)),
  }, async (cwd) => {
    if (ctx.dryRun) {
      say(`DRY RUN  would ${objection === null ? 'reacquire the proof of' : 'revise'} PR #${pull.number} on ${pull.branch}, then review and land`);
      return { outcome: 'not-run', reason: 'dry run: the redrive was not run' };
    }
    // The pull request goes back to draft first, so the catch-up and the revision's pushes spend
    // no CI run. Then the base: a redriven pull request has usually sat, and no revision begins on
    // a stale lane.
    // The issue's hold is the one selection and the live gate read, and it is lifted, or this
    // redrive would not have passed the gate. When the newest stop on the thread is the loop's own
    // hold (a held proof, or an outside stop that waited on a person), the pull request's
    // `needs-human` is that hold's mirror; it comes off with it, or the merge
    // gate would refuse the very work the person released. A label a person put on the pull
    // request after anything else stopped the work stays, and the merge gate honours it.
    // Read as every reader of the stop reads it: the loop's own records since this pull request opened.
    const opened = () => sh(ctx, ['gh', 'pr', 'view', String(pull.number), '--json', 'createdAt', '--jq', '.createdAt']);
    const thread = () => trackerIo(ctx).view(issue.number)?.comments ?? [];
    if (pullHolds(ctx, pull.number).includes('needs-human') && loopHoldStands(standingStop(thread(), ctx.botLogin, opened()))) {
      mutate(ctx, `lift needs-human on PR #${pull.number}: the issue's hold was lifted`, ['gh', 'pr', 'edit', String(pull.number), '--remove-label', 'needs-human']);
    }
    // Nothing objected, and an approval still stands on this very head: the landing goes ahead on
    // it, with no draft, no proof, and no review again, each of which would only re-establish what
    // the record already says and start another CI run on an unchanged head.
    if (objection === null) {
      const standing = await approvedAtHead(ctx, pull.number, cwd, thread(), opened(), say);
      if (standing) {
        move(ctx, issue, 'F1', `approved at ${standing.reviewedSha.slice(0, 10)}; landing on the standing approval`);
        const first: WorkerResult = { issue: issue.number, verdict: 'fixed', reason: 'approved earlier at this head', pr: pull.number, branch: pull.branch, touches: standing.review.touches };
        return await reviewAndLand(ctx, issue, cwd, first, maxPoints, say, ceiling, standing);
      }
    }
    if (!isDraft(ctx, pull.number)) mutate(ctx, `return PR #${pull.number} to draft for the redrive`, ['gh', 'pr', 'ready', String(pull.number), '--undo']);
    const head = sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);
    if (await catchUp(ctx, issue, cwd, head, say, 'before the redrive') === 'conflict') {
      return deadLetter(ctx, issue, 'landing', `The branch conflicts with ${ctx.project.baseBranch}.`, say, pull.number);
    }
    const feedback: ReviewResult =
      objection === null
        ? {
            pr: pull.number,
            decision: 'gather-more',
            adequacy: options.landing
              ? 'This pull request was reviewed and approved, then parked by the merge boundary, and a person has cleared it to land. Nobody has objected to the change; its proof has to be current before it is reviewed again and lands.'
              : 'This pull request lost its driver before it was reviewed. Nobody has objected to the change; its proof has to be current before a review can start.',
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
    // Awaited, like every pipeline call here: the claim and the lease must outlive the review and
    // the landing, or two live redrives review and merge with no claim and no lease.
    return await reviewAndLand(ctx, issue, cwd, result, maxPoints, say, ceiling);
  });
}

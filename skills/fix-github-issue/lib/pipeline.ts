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

import { resolve } from 'node:path';
import { CHECKS_TIMEOUT_MS, logTail, readResult, renderPrompt, runAgent } from './agent.ts';
import type { Context } from './context.ts';
import { closeIssue, parkIssue, recordReview, reviewCount, sendToDlq } from './labels.ts';
import { dirtyPaths, inFlight, removeWorktree, resetLane, updateFromBase, worktreeFor } from './lane.ts';
import { mutate, sh } from './shell.ts';
import { MAX_BASE_REFRESHES, matchesPath, staleAgainstBase } from './staleness.ts';

/**
 * How the pipeline finished with an issue, and why.
 *
 * `closed` is a verdict that ended the issue without code (already fixed, obsolete); `handed-off`
 * is one that needs a person (a product decision, access an agent lacks, work outside the band);
 * `parked` means a pull request exists and a human owns the next call.
 */
export type FixOutcome = {
  outcome: 'merged' | 'parked' | 'handed-off' | 'closed' | 'dlq' | 'failed';
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
  | 'failed';

export type WorkerResult = {
  issue: number;
  verdict: Verdict;
  points?: number;
  reason: string;
  /** For already-fixed and obsolete: the comment to post before closing, receipt included. */
  closeComment?: string;
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

export type Issue = { number: number; title: string; createdAt: string; labels: Array<{ name: string }> };

async function runWorker(
  ctx: Context,
  issue: Issue,
  cwd: string,
  maxPoints: number,
  feedback?: ReviewResult,
): Promise<WorkerResult> {
  const prompt = renderPrompt(ctx, 'triage-and-fix.md', {
    ISSUE: String(issue.number),
    TITLE: issue.title,
    MAX_POINTS: String(maxPoints),
    FEEDBACK: feedback
      ? `A reviewer has already seen your pull request and asked for more. Address every blocking item, ` +
        `push to the same branch, and update the proof comment.\n\n${JSON.stringify(feedback, null, 2)}`
      : 'This is the first attempt at this issue.',
  });

  // A revision is the exception: its lane holds the branch and the pull request under review, so a
  // reset would throw away work the reviewer already read. Only a first attempt may be reset.
  const { logPath, exitCode } = await runAgent(
    ctx,
    feedback ? 'worker-revise' : 'worker',
    issue.number,
    cwd,
    ctx.seats.worker,
    prompt,
    feedback ? undefined : () => resetLane(ctx, issue.number, cwd),
  );
  if (exitCode !== 0) {
    return {
      issue: issue.number,
      verdict: 'failed',
      reason: `worker exited ${exitCode}, so its verdict is not trusted; log ends: ${logTail(logPath)}`,
    };
  }

  const result = readResult<WorkerResult>(cwd, 'loop-verdict.json');
  const KNOWN: Verdict[] = ['already-fixed', 'obsolete', 'needs-decision', 'needs-human', 'out-of-band', 'fixed', 'failed'];
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
  return result;
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
function pullRequestMatchesReview(
  ctx: Context,
  pr: number,
  issue: number,
  cwd: string,
  reviewedSha: string,
): string | null {
  const raw = sh(ctx, ['gh', 'pr', 'view', String(pr), '--json', 'headRefOid,baseRefName,headRefName,state']);
  const view: { headRefOid: string; baseRefName: string; headRefName: string; state: string } = JSON.parse(raw);
  const localHead = sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);

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
 * Unknown states fail closed; a merge with a failing or unfinished build is never allowed.
 */
async function awaitGreenChecks(ctx: Context, pr: number, say: (message: string) => void): Promise<string | null> {
  type CheckNode = { name?: string; context?: string; status?: string; conclusion?: string; state?: string };
  const GREEN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
  const RUNNING = new Set(['PENDING', 'EXPECTED', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'REQUESTED']);
  // GitHub renders an unfinished CheckRun with conclusion "" (empty string, not null), so a
  // nullish coalesce would read "" as a verdict and fail-close a merely-running check.
  const classify = (c: CheckNode): 'green' | 'pending' | 'failed' => {
    const verdict = c.conclusion || c.state || c.status || null;
    if (verdict === null || RUNNING.has(verdict)) return 'pending';
    return GREEN.has(verdict) ? 'green' : 'failed';
  };
  const nameOf = (c: CheckNode) => c.name ?? c.context ?? 'unnamed check';

  const deadline = Date.now() + CHECKS_TIMEOUT_MS;
  for (;;) {
    const raw = sh(ctx, ['gh', 'pr', 'view', String(pr), '--json', 'statusCheckRollup', '--jq', '.statusCheckRollup']);
    const rollup: CheckNode[] = raw ? JSON.parse(raw) : [];

    const failed = rollup.filter((c) => classify(c) === 'failed');
    if (failed.length > 0) {
      return `checks failed: ${failed.map((c) => `${nameOf(c)} (${c.conclusion || c.state || c.status})`).join(', ')}`;
    }

    const pending = rollup.filter((c) => classify(c) === 'pending');
    if (pending.length === 0) return null;
    if (Date.now() >= deadline) {
      return `checks still unfinished after ${Math.round(CHECKS_TIMEOUT_MS / 60000)} minutes: ${pending.map(nameOf).join(', ')}`;
    }
    say(`waiting on ${pending.length} unfinished check(s) before merging`);
    await Bun.sleep(30_000);
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

function serializePullMaster<T>(ctx: Context, action: () => Promise<T>): Promise<T> {
  const next = ctx.integrationQueue.then(action, action);
  ctx.integrationQueue = next.catch(() => undefined);
  return next;
}

export type Reviewed = { review: ReviewResult; reviewedSha: string };
export type Landing = 'merged' | 'revise' | 'stale' | { park: string };

/** How long the smoke command may run before the pull request parks as unbootable. */
const SMOKE_TIMEOUT_MS = 10 * 60 * 1000;

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
): Promise<Reviewed | null> {
  // A draft is the worker's own statement that the work is not finished. Reviewing one wastes the
  // review and, worse, can approve a branch the worker still intends to push to.
  if (isDraft(ctx, pr)) {
    say('worker left the pull request in draft; treating it as incomplete');
    return null;
  }

  // A dirty tree means checks run against files that are not in the pull request: a worker's
  // uncommitted edit could make the reviewer's re-run pass while the clean remote commit fails.
  if (dirtyPaths(ctx, cwd).length > 0) {
    say('worktree has uncommitted changes; a review here would judge code that is not in the pull request');
    return null;
  }

  const reviewedSha = sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);
  const verdict = await runReviewer(ctx, issue.number, pr, cwd, round);
  if (!verdict) {
    say('reviewer wrote no verdict');
    return null;
  }
  // A verdict that is not merge is explained by what blocks it, not by how good the evidence was.
  const why = verdict.decision !== 'merge' && verdict.blocking.length > 0 ? verdict.blocking.join(' | ') : verdict.adequacy;
  say(`review: ${verdict.decision}; ${why}`);
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
    // Back to draft before anything is pushed: the catch-up below and the revision pushes that
    // follow must not each spend a CI run on a pull request still marked ready.
    mutate(ctx, `return PR #${pr} to draft for revision`, ['gh', 'pr', 'ready', String(pr), '--undo']);
    // Catch up anyway, so the revision happens against current code rather than against the base as
    // it stood when this branch started. Cheap here, and it saves the next review a refresh.
    const behind = staleAgainstBase(ctx, cwd, reviewedSha);
    if (behind.length > 0) {
      say(`catching up before the revision (${behind.join(', ')})`);
      if (!updateFromBase(ctx, cwd)) {
        // A parked pull request must not sit in draft: the human reading loop/parked would find a
        // branch the CI guard is configured to skip, and nothing else would ever flip it back.
        mutate(ctx, `mark PR #${pr} ready again before parking`, ['gh', 'pr', 'ready', String(pr)]);
        say(`conflicts with ${ctx.project.baseBranch}; a human has to resolve it`);
        return { park: `the branch conflicts with ${ctx.project.baseBranch}; a human has to resolve it` };
      }
    }
    return 'revise';
  }

  // From here the verdict is `merge`, and only now does freshness decide anything.
  const overlap = staleAgainstBase(ctx, cwd, reviewedSha);
  if (overlap.length > 0) {
    say(`base moved into this work (${overlap.join(', ')}); the approval no longer describes what would land`);
    if (!updateFromBase(ctx, cwd)) {
      say(`conflicts with ${ctx.project.baseBranch}; a human has to resolve it`);
      return { park: `the branch conflicts with ${ctx.project.baseBranch}; a human has to resolve it` };
    }
    return 'stale';
  }

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

  const mismatch = pullRequestMatchesReview(ctx, pr, issue.number, cwd, reviewedSha);
  if (mismatch) {
    say(`refusing to merge PR #${pr}: ${mismatch}`);
    return { park: mismatch };
  }

  // A failing or unfinished build never merges, whatever the review said. The reviewer watched
  // checks too, but its answer ages: any catch-up since the verdict pushed a head whose CI run
  // started fresh, and this is the last moment anything looks. Waiting here blocks the serial
  // queue, which is honest; a merge may not outrun its own build.
  const notGreen = await awaitGreenChecks(ctx, pr, say);
  if (notGreen) {
    say(`refusing to merge PR #${pr}: ${notGreen}`);
    return { park: notGreen };
  }

  // A green build is not a booted result. A change can compile, type-check, and pass every test
  // and still fail the moment the result starts, because nothing above ever started it. The smoke
  // command is the repository's own "boot it and hit it once", run in the lane against the exact
  // head that would land. Optional; a repository with nothing to boot leaves it unset.
  if (ctx.project.smokeCommand) {
    say(`running the smoke command: ${ctx.project.smokeCommand}`);
    const smoke = Bun.spawnSync(['sh', '-c', ctx.project.smokeCommand], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: SMOKE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    if (smoke.exitCode !== 0) {
      const tail = `${smoke.stdout.toString()}\n${smoke.stderr.toString()}`.trim().split('\n').slice(-6).join(' | ');
      const reason = `the smoke command exited ${smoke.exitCode ?? 'by timeout'}: ${tail || 'no output'}`;
      say(`refusing to merge PR #${pr}: ${reason}`);
      return { park: reason };
    }
    say('smoke command passed');
  }

  // The driver's last word. A driver holding its line waits here rather than answering; one that
  // gives up answers with a reason, and the pull request parks without spending a review round.
  if (ctx.mayMerge) {
    const permission = await ctx.mayMerge();
    if (!permission.ok) {
      say(`refusing to merge PR #${pr}: ${permission.reason}`);
      return { park: permission.reason };
    }
  }

  // `--match-head-commit` makes the merge itself refuse if the head moved between this check and
  // the call, so the commit that lands is the commit that was read.
  mutate(ctx, `merge PR #${pr}`, ['gh', 'pr', 'merge', String(pr), '--merge', '--match-head-commit', reviewedSha]);

  // Confirm it actually landed before closing anything. On a repository with a merge queue or
  // auto-merge, `gh pr merge` can enqueue rather than merge; a queued pull request would land
  // later while this driver has already parked it, so cancel whatever was scheduled first.
  const merged = sh(ctx, ['gh', 'pr', 'view', String(pr), '--json', 'mergedAt', '--jq', '.mergedAt']);
  if (!merged || merged === 'null') {
    try {
      sh(ctx, ['gh', 'pr', 'merge', String(pr), '--disable-auto']);
    } catch {
      // nothing was scheduled
    }
    say(`PR #${pr} did not report a merge; cancelled any queued merge and left the worktree and issue alone`);
    return { park: 'the merge was requested but the pull request did not report a merge' };
  }

  // Tell the driver while the worktree still exists, so the event carries the paths that landed.
  if (ctx.afterMerge) {
    const paths = sh(ctx, ['git', 'diff', '--name-only', `${ctx.project.remote}/${ctx.project.baseBranch}...HEAD`], cwd)
      .split('\n')
      .filter(Boolean);
    ctx.afterMerge({ issue: issue.number, title: issue.title, pr, sha: reviewedSha, mergedAt: merged, paths });
  }

  // Read the branch name while the worktree still exists, then drop it.
  const branch = sh(ctx, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  removeWorktree(ctx, issue.number);
  try {
    sh(ctx, ['git', 'push', ctx.project.remote, '--delete', branch]);
  } catch {
    say(`merged branch ${branch} was already deleted`);
  }
  closeIssue(ctx, issue.number, `Closed by #${pr}.`);
  return 'merged';
}

function settleTerminalVerdict(ctx: Context, issue: Issue, result: WorkerResult, pr?: number): FixOutcome | null {
  const closePullRequest = () => {
    if (pr) mutate(ctx, `close PR #${pr}`, ['gh', 'pr', 'close', String(pr), '--comment', 'Superseded; see the issue.']);
  };

  switch (result.verdict) {
    case 'already-fixed':
    case 'obsolete':
      // The obsolete pull request goes first: a crash after it leaves retryable work, whereas a
      // crash after the close would leave an open pull request attached to a closed issue.
      closePullRequest();
      closeIssue(ctx, issue.number, result.closeComment ?? result.reason);
      removeWorktree(ctx, issue.number);
      return { outcome: 'closed', reason: result.reason };

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
      removeWorktree(ctx, issue.number);
      return { outcome: 'handed-off', reason: result.reason };

    case 'out-of-band': {
      if (result.points) {
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
      removeWorktree(ctx, issue.number);
      return { outcome: 'handed-off', reason: result.reason };
    }

    default:
      return null;
  }
}

async function workIssue(
  ctx: Context,
  issue: Issue,
  cwd: string,
  maxPoints: number,
  say: (message: string) => void,
): Promise<FixOutcome> {
  const result = await runWorker(ctx, issue, cwd, maxPoints);
  say(`verdict: ${result.verdict}; ${result.reason}`);

  if (result.verdict === 'failed') {
    say('worker failed; leaving it untouched');
    return { outcome: 'failed', reason: result.reason };
  }
  const settled = settleTerminalVerdict(ctx, issue, result);
  if (settled) return settled;

  return reviewAndLand(ctx, issue, cwd, result, maxPoints, say);
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
): Promise<FixOutcome> {
  let result = first;
  let consumed = reviewCount(issue.labels);
  let refreshes = 0;
  // Why the work stopped, carried to the park comment so the reason lives on the issue rather
  // than only in this run's log.
  let parkReason = 'the loop worked this issue and could not finish the call';
  while (consumed < ctx.knobs.maxReviewRounds) {
    if (!result.pr) {
      parkReason = 'the worker reported a fix but named no pull request';
      break;
    }
    const pr = result.pr;
    const touches = result.touches;

    if (ctx.dryRun) break;

    // Reviewing happens here, outside the queue, so lanes review at the same time.
    const reviewed = await review(ctx, issue, pr, cwd, say, consumed + 1);
    if (!reviewed) {
      parkReason = 'the reviewer produced no trusted verdict on this round';
      break;
    }

    // Merging happens there, one branch at a time, because the base branch is shared.
    const outcome = await serializePullMaster(ctx, async () => land(ctx, issue, pr, touches, reviewed, cwd, say));
    if (outcome === 'merged') return { outcome: 'merged', reason: `merged pull request #${pr}` };

    // The base reached this work while the review was running. That is upstream churn, not a defect
    // in the change, so it costs a fresh review but not a round of the issue's budget. Bounded:
    // a base that keeps landing into these files would otherwise re-review forever.
    if (outcome === 'stale') {
      refreshes += 1;
      if (refreshes > MAX_BASE_REFRESHES) {
        say(`base moved into this work ${refreshes} times; a human should land it`);
        parkReason = `the base moved into this work ${refreshes} times; a human should land it`;
        break;
      }
      continue;
    }

    const { review: verdict } = reviewed;

    // A verdict was reached and the work goes back or stops, so the round is spent whether the
    // outcome is a revision or a park. Recorded before the revision starts rather than after it
    // finishes, so a run killed mid-revision still leaves the budget honest; the alternative
    // silently refunds a round every time a run dies. A merge ends the accounting instead: the
    // issue is closing, and label churn on a closed issue records nothing anyone reads.
    consumed = recordReview(ctx, issue.number, consumed);
    say(`review round ${consumed} of ${ctx.knobs.maxReviewRounds}`);

    if (typeof outcome === 'object') {
      // The gate that parked says why; a rejected review adds the reviewer's own words.
      const reviewerWords = verdict.blocking.length > 0 ? verdict.blocking.join('\n') : verdict.adequacy;
      parkReason = verdict.decision === 'merge' ? outcome.park : `${outcome.park}\n\nReviewer: ${reviewerWords}`;
      break;
    }

    if (consumed >= ctx.knobs.maxReviewRounds) {
      sendToDlq(ctx, issue.number, consumed, verdict.blocking.length > 0 ? verdict.blocking.join('\n') : verdict.adequacy);
      say(`ejected to the DLQ after ${consumed} review rounds`);
      return { outcome: 'dlq', reason: `ejected after ${consumed} review rounds` };
    }

    // Revision is programming, so it happens outside the queue; the branch rejoins it afterwards.
    // The pull request is already back in draft: land() flips it before any catch-up push.
    result = await runWorker(ctx, issue, cwd, maxPoints, verdict);
    say(`verdict: ${result.verdict}; ${result.reason}`);
    if (result.verdict === 'failed') {
      // an open pull request now needs a human
      parkReason = result.reason;
      break;
    }
    const settled = settleTerminalVerdict(ctx, issue, result, pr);
    if (settled) return settled;
  }

  parkIssue(ctx, issue.number, parkReason);
  // The pull request is parked too, so a human reading the branch sees the same state the issue
  // carries rather than an unlabelled draft nobody claimed.
  if (result.pr) {
    mutate(ctx, `park PR #${result.pr}`, ['gh', 'pr', 'edit', String(result.pr), '--add-label', 'loop/parked']);
  }
  say('parked for a human');
  return { outcome: 'parked', reason: parkReason };
}

/**
 * Fixes one issue end to end and says how it ended.
 *
 * The lane is created here and removed here, whatever the outcome, so no exit leaks a worktree.
 * A crash never runs the cleanup, which is exactly when the resume path should get its chance.
 */
export async function fixIssue(ctx: Context, issue: Issue, options: { maxPoints?: number } = {}): Promise<FixOutcome> {
  // Lanes interleave, so every line an issue emits names the issue. Without this the console is a
  // shuffled deck of verdicts with no way to tell which belongs to which.
  const say = (message: string) => ctx.log(`#${issue.number}  ${message}`);
  ctx.step(`#${issue.number} ${issue.title}`);

  // Even in a dry run the path is the worktree's, never the main checkout, so nothing downstream
  // learns to treat the main checkout as a valid agent working directory.
  const cwd = ctx.dryRun
    ? resolve(ctx.repoRoot, ctx.project.worktreeRoot, `issue-${issue.number}`)
    : worktreeFor(ctx, issue.number);
  inFlight.set(issue.number, { dir: cwd, busy: false });
  try {
    return await workIssue(ctx, issue, cwd, options.maxPoints ?? DEFAULT_MAX_POINTS, say);
  } finally {
    inFlight.delete(issue.number);

    // Whatever the outcome, this lane is finished with the directory, so it goes here rather than
    // at each of the eight exits that used to leak one. Nothing in-process reads it again, and
    // the resume path resumes only a `fixed` verdict whose pull request is open at the same head on
    // an unlabelled issue; every outcome that reaches this line (failed, parked, DLQed, budget
    // exhausted, terminal verdict, merged) is one it already refuses. Removing the worktree also
    // sweeps the `issue-N-<scratch>` siblings agents make for evidence capture, which nothing else
    // reclaims. A crash never runs this block, which is exactly when resume should get its chance,
    // so reconcile still owns that case on the next start.
    if (!ctx.dryRun) removeWorktree(ctx, issue.number);
  }
}

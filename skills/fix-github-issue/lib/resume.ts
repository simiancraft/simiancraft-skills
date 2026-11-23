/**
 * Picking up after a run that died: clearing the worktrees it abandoned, finding the pull requests
 * it stranded, and putting those back through the review and landing path.
 *
 * Everything durable lives on the forge, so what a dead run leaves behind locally is a worktree
 * with no owner and, sometimes, a finished pull request with a verdict file nobody read.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { claim, keepClaimed, liveGate, trackerIo } from '../../carve-github-issue/lib/claims.ts';
import { liveClaim, readTree } from '../../carve-github-issue/lib/tree.ts';
import { killAgentsOn, parseJsonFile, VERDICT_FILE } from './agent.ts';
import { PROOF_FILE } from './control-files.ts';
import type { Context } from './context.ts';
import { isHeldBy, reviewCount, sendToDlq } from './labels.ts';
import { dirtyPaths, inFlight } from './lane.ts';
import { type FixOutcome, type Issue, recordThrow, retireLane, reviewAndLand, type WorkerResult } from './pipeline.ts';
import { isStopping, RunStopping, sh } from './shell.ts';

/** A pull request a dead run left behind, with the worktree and verdict to resume it from. */
export type Stranded = { issue: Issue; cwd: string; result: WorkerResult };

/**
 * Clears the wreckage of a run that died, so a crash costs the next run nothing.
 *
 * A loop process can die for reasons that are never established, so the answer is to make the
 * cause irrelevant rather than to guess at it. Everything durable lives on GitHub; what a dead run leaves
 * behind locally is a worktree with no owner and possibly a branch that never became a pull request.
 * Both are safe to reason about because no process holds them any more: this runs before any lane
 * starts, under the instance lock.
 */
export function reconcile(ctx: Context, claimed: Set<number>): void {
  let repaired = 0;

  for (const lane of managedLanes(ctx)) {
    const { issue, dir } = lane;
    // A scratch sibling belongs to its parent issue, so the claimed and dirty rules below judge it
    // by the parent where that still exists, and a sibling's removal takes only the sibling: removing
    // by issue number would also take the parent worktree this same pass may have chosen to keep.
    const judged = lane.sibling && existsSync(lane.parent) ? lane.parent : dir;

    // A pull request means the work reached GitHub and is not ours to throw away; selection already
    // treats the issue as claimed, so leave both alone and let a human or a later round finish it.
    if (claimed.has(issue)) {
      ctx.log(`reconcile: #${issue} has an open pull request; leaving its worktree in place`);
      continue;
    }

    // `fix.ts` holds no instance lock, so a loop can start while a hand-run fix's worker is still in
    // this lane, before its pull request exists. A live claim by another run means the lane is not
    // abandoned; a claim that cannot be read is treated the same, since removing is the irreversible act.
    const holder = lane.holder();
    if (holder) {
      ctx.log(`reconcile: #${issue} is claimed by ${holder}; leaving its worktree in place`);
      continue;
    }

    const dirty = (() => {
      try {
        return dirtyPaths(ctx, judged).length > 0;
      } catch {
        return false;
      }
    })();
    if (dirty) {
      if (rescueClosedLane(ctx, issue, dir)) {
        repaired++;
        continue;
      }
      ctx.log(`reconcile: #${issue} has uncommitted work and no pull request; leaving it for inspection`);
      parkForInspection(ctx, issue, `An earlier run left uncommitted work in its lane (${judged}) and no pull request. A person inspects or removes it; the loop will not hand this issue to a fresh worker until the lane is gone.`);
      continue;
    }

    if (lane.sibling) {
      ctx.log(`reconcile: removing abandoned scratch worktree ${dir}`);
      try {
        sh(ctx, ['git', 'worktree', 'remove', '--force', dir]);
      } catch {
        rmSync(dir, { recursive: true, force: true });
      }
    } else {
      // Committed work is kept or pushed first; reconcile is a clean-up, not a place work is lost.
      ctx.log(`reconcile: retiring the abandoned worktree for #${issue}`);
      retireLane(ctx, issue, (m) => ctx.log(`reconcile: ${m}`));
    }
    repaired++;
  }

  if (repaired > 0) ctx.log(`reconcile: cleared ${repaired} abandoned worktree(s) from an earlier run`);
}

/**
 * A closed issue's lane that holds uncommitted work and no pull request. Nothing hands a closed
 * issue to a worker again and parking writes nothing on a closed issue, so a lane kept for
 * inspection would be kept, and logged, on every start. Its uncommitted paths, untracked files
 * included, are committed onto its HEAD through a scratch index (the lane's own index and files are
 * untouched) and kept under `refs/loop/rescued/`, as `resetLane` keeps unpushed commits; then the
 * worktree is removed, and the one line saying where the work went is logged by the run that
 * removed it. Returns false, and the lane is kept as before, when the issue cannot be read as
 * closed, when an open pull request is on the lane's branch or the open pull requests cannot be
 * read, or when the work cannot be saved: removing is the irreversible act.
 */
export function rescueClosedLane(ctx: Context, issue: number, dir: string): boolean {
  const io = trackerIo(ctx);
  try {
    if (io.view(issue)?.state !== 'CLOSED') return false;
    const branch = sh(ctx, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], dir);
    if (branch !== 'HEAD' && io.openPullBranches().includes(branch)) {
      ctx.log(`reconcile: #${issue} is closed, but pull request branch ${branch} is still open; leaving its lane in place`);
      return false;
    }
  } catch (error) {
    if (error instanceof RunStopping || isStopping()) throw error;
    return false;
  }

  let saved: string | null = null;
  let scratch: string | null = null;
  try {
    if (dirtyPaths(ctx, dir).length > 0) {
      const index = join((scratch = mkdtempSync(join(tmpdir(), 'rescue-index-'))), 'index');
      const git = (...args: string[]) => sh(ctx, ['env', `GIT_INDEX_FILE=${index}`, 'git', '-c', 'user.name=fix-github-issue', '-c', 'user.email=fix-github-issue@localhost', ...args], dir);
      git('read-tree', 'HEAD');
      git('add', '-A');
      const tree = git('write-tree');
      const commit = git('commit-tree', tree, '-p', 'HEAD', '-m', `rescued: uncommitted work in the lane for closed issue #${issue}`);
      saved = `refs/loop/rescued/issue-${issue}/${commit.slice(0, 12)}`;
      git('update-ref', saved, commit);
    }
  } catch (error) {
    ctx.log(`reconcile: #${issue} is closed, but the uncommitted work in its lane could not be saved (${(error as Error).message.split('\n')[0]})`);
    return false;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }

  try {
    sh(ctx, ['git', 'worktree', 'remove', '--force', dir]);
  } catch {
    rmSync(dir, { recursive: true, force: true });
  }
  ctx.log(saved
    ? `reconcile: #${issue} is closed; saved the uncommitted work in ${dir} as ${saved} and removed the lane`
    : `reconcile: #${issue} is closed; removed the scratch worktree ${dir}, which held no uncommitted work of its own`);
  return true;
}

/** One worktree under the managed root that belongs to an issue: its own lane, or a scratch sibling beside it. */
export type ManagedLane = {
  issue: number;
  dir: string;
  /** The issue's own lane directory, `issue-<n>`; a sibling's parent, and the lane itself otherwise. */
  parent: string;
  /** A scratch worktree an agent made beside its lane (`issue-1234-evidence`), not the lane itself. */
  sibling: boolean;
  /** Who else holds a live claim on the issue, read once per walk and failing closed (see claimHolder). */
  holder: () => string | null;
};

/**
 * The managed lanes git knows about: every registered worktree under the managed root named for an
 * issue, with the claim rule that decides whether another run holds it.
 *
 * Agents make scratch siblings next to their own worktree (`issue-1234-evidence`) to capture a
 * before state or write to the evidence branch. A pattern anchored on the number alone could not
 * see them, so a crashed lane left them behind permanently; they are listed here with their parent.
 * The claim is read lazily, so a walk that rules a lane out first never asks the tracker about it,
 * and once per issue, so a lane and its siblings share one read.
 */
export function managedLanes(ctx: Context): ManagedLane[] {
  const managed = resolve(ctx.repoRoot, ctx.project.worktreeRoot);
  const holders = new Map<number, string | null>();
  const lanes: ManagedLane[] = [];
  for (const line of sh(ctx, ['git', 'worktree', 'list', '--porcelain']).split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const dir = resolve(line.slice('worktree '.length).trim());
    if (!dir.startsWith(`${managed}/`)) continue;
    const parts = /issue-(\d+)(-[^/]+)?$/.exec(dir);
    if (!parts?.[1]) continue;
    const issue = Number(parts[1]);
    lanes.push({
      issue,
      dir,
      parent: resolve(managed, `issue-${issue}`),
      sibling: Boolean(parts[2]),
      holder: () => claimHolder(ctx, issue, holders),
    });
  }
  return lanes;
}

/** Who else holds a live claim on an issue, if anyone; read once per issue, and fail closed. */
export function claimHolder(ctx: Context, issue: number, cache: Map<number, string | null>): string | null {
  if (!cache.has(issue)) {
    let holder: string | null;
    try {
      holder = liveClaim(readTree(ctx, issue, trackerIo(ctx)), new Date().toISOString(), ctx.runId)?.runId ?? null;
    } catch (error) {
      if (error instanceof RunStopping || isStopping()) throw error;
      holder = `an unreadable claim (${(error as Error).message.split('\n')[0]})`;
    }
    cache.set(issue, holder);
  }
  return cache.get(issue) ?? null;
}

export type LaneJudgement =
  | { kind: 'no-lane' | 'clean-at-head' }
  | { kind: 'dirty' | 'off-head'; reason: string }
  | { kind: 'unreadable'; reason: string };

/** Judge local work before asking the tracker, without publishing or changing the lane. */
export function judgeLane(ctx: Context, issue: number, readHead: () => string): LaneJudgement {
  const dir = resolve(ctx.repoRoot, ctx.project.worktreeRoot, `issue-${issue}`);
  if (!existsSync(dir)) return { kind: 'no-lane' };
  let head: string;
  let reading = 'git status --porcelain';
  try {
    const dirty = dirtyPaths(ctx, dir);
    if (dirty.length > 0) return { kind: 'dirty', reason: `Lane ${dir} holds uncommitted work: ${dirty.join(', ')}` };
    reading = 'git rev-parse HEAD';
    head = sh(ctx, ['git', 'rev-parse', 'HEAD'], dir);
  } catch (error) {
    if (error instanceof RunStopping || isStopping()) throw error;
    return { kind: 'dirty', reason: `Lane ${dir} could not be shown clean: ${reading} failed (${(error as Error).message})` };
  }
  let remoteHead: string;
  try {
    remoteHead = readHead();
  } catch (error) {
    if (error instanceof RunStopping || isStopping()) throw error;
    return { kind: 'unreadable', reason: `Pull request head could not be read: ${(error as Error).message}` };
  }
  if (head !== remoteHead) return { kind: 'off-head', reason: `Lane ${dir} HEAD ${head} differs from pull request head ${remoteHead}. A person inspects the lane before continuing.` };
  return { kind: 'clean-at-head' };
}

/**
 * Pull requests a dead run left behind, paired with the worktree and verdict to resume them from.
 *
 * Selection refuses an issue an open pull request claims, and reconcile deliberately leaves that
 * worktree standing, so without a resume path a crash after PR creation stranded finished work
 * until a human noticed. The worker's verdict file survives in the worktree and carries everything
 * reviewAndLand needs. A stranded worktree without a usable verdict is only reported: that crash
 * window (after the PR, before the verdict) leaves nothing safe to resume from.
 */
export function findStranded(ctx: Context, all: Issue[], skipLabels: string[]): Stranded[] {
  const found: Stranded[] = [];

  for (const lane of managedLanes(ctx)) {
    const { issue: num, dir } = lane;
    if (lane.sibling) continue; // reconcile owns scratch siblings
    if (inFlight.has(num)) continue;

    const issue = all.find((candidate) => candidate.number === num);
    if (!issue) continue; // closed or outside the window; reconcile owns the cleanup question

    // The safety labels that gate selection gate resumption too: a parked, skipped, DLQed, or
    // budget-exhausted issue belongs to a human even when a worktree still remembers it.
    if (isHeldBy(issue.labels, skipLabels)) continue;
    if (reviewCount(issue.labels) >= ctx.knobs.maxReviewRounds) continue;

    // Another run's live claim means its lane is in use: a redrive claims before it lifts its hold,
    // so an issue read without a hold may still be one a person's redrive is about to work.
    const holder = lane.holder();
    if (holder) {
      ctx.log(`#${num}  stranded lane is claimed by ${holder}; leaving it in place`);
      continue;
    }

    const verdict = strandedVerdict(dir);
    if (!verdict || verdict.verdict !== 'fixed' || !verdict.pr) {
      ctx.log(`#${num}  stranded worktree has no usable verdict; leaving it for a human`);
      parkForInspection(ctx, issue.number, `An earlier run died with this issue's lane at ${dir} and left no usable verdict. A person inspects the lane and the pull request, if any.`);
      continue;
    }
    // The verdict is trusted only as far as it can be corroborated: it must name this issue, and
    // the worktree must sit at the pull request's remote head, or the resume would review a tree
    // that is not what would merge.
    if (Number(verdict.issue) !== issue.number) {
      ctx.log(`#${num}  stranded verdict names issue ${verdict.issue}; leaving it for a human`);
      continue;
    }
    const view: { state: string; headRefOid: string } = JSON.parse(
      sh(ctx, ['gh', 'pr', 'view', String(verdict.pr), '--json', 'state,headRefOid']),
    );
    if (view.state !== 'OPEN') continue;
    if (view.headRefOid !== sh(ctx, ['git', 'rev-parse', 'HEAD'], dir)) {
      ctx.log(`#${num}  stranded worktree head is not the pull request head; leaving it for a human`);
      continue;
    }
    found.push({ issue, cwd: dir, result: verdict });
  }
  return found;
}
/**
 * The finished work a dead lane holds, as the pipeline reads it: the prover's ready pull request, or,
 * in a lane an older run left, the single worker's verdict. A coder's answer alone is not finished
 * work; the next attempt places itself from the issue's announcement instead.
 */
function strandedVerdict(dir: string): WorkerResult | null {
  const proof = parseJsonFile<{ issue: number; verdict: string; reason: string; pr?: number; branch?: string; touches?: WorkerResult['touches'] }>(join(dir, PROOF_FILE));
  if (proof) {
    return proof.verdict === 'proved' ? { issue: proof.issue, verdict: 'fixed', reason: proof.reason, pr: proof.pr, branch: proof.branch, touches: proof.touches } : null;
  }
  return parseJsonFile<WorkerResult>(join(dir, VERDICT_FILE));
}

/**
 * What a dead run left behind is a machine's failure, so it is a work dead letter (the machine's
 * "run died with undeclared work"), written once: an issue already held is not commented on again.
 */
export function parkForInspection(ctx: Context, issue: number, reason: string): void {
  if (ctx.dryRun) return;
  try {
    const labels = sh(ctx, ['gh', 'issue', 'view', String(issue), '--json', 'state,labels', '--jq', '[.state, (.labels[].name)] | join(" ")']);
    if (!labels.startsWith('OPEN') || labels.includes('loop/parked') || labels.includes('loop/dlq')) return;
    sendToDlq(ctx, issue, 'work', reason);
  } catch (error) {
    ctx.log(`#${issue}  could not record the dead letter: ${(error as Error).message}`);
  }
}

/**
 * Lands one pull request a dead run left finished: the live gate, a fresh claim, then review and
 * landing from the lane's verdict. The caller runs these in its work pool beside new lanes, so a
 * resume waiting on checks holds one slot, not the run; a lane cut while it waits catches up with
 * the base it moves at its own seams. Returns how the resume settled, or null when it did not start.
 */
export async function resumeOneStranded(
  ctx: Context,
  entry: Stranded,
  maxPoints: number,
  ceiling: number = maxPoints,
): Promise<FixOutcome | null> {
  const { issue } = entry;
  const say = (message: string) => ctx.log(`#${issue.number}  ${message}`);
  // A fresh claim, never the dead run's, and the live gate first: the issue may have been
  // held, paused, carved, or claimed elsewhere since the run died.
  const io = trackerIo(ctx);
  const gate = liveGate(ctx, io, issue.number, ceiling);
  if (!gate.ok) {
    say(`not resuming: ${gate.why}`);
    if (gate.outcome === 'left-alone') parkForInspection(ctx, issue.number, `A dead run's pull request #${entry.result.pr} was not resumed because ${gate.why}. A person decides.`);
    return null;
  }
  const handle = await claim(ctx, io, issue.number, 'working');
  if (handle === 'busy') {
    say('not resuming: another run holds it');
    return null;
  }
  const stopRenewing = keepClaimed(handle, () => {
    // The lease ran out unrenewed: another run may hold the issue now, so this one's agent stops.
    const killed = killAgentsOn(ctx.project.repo, issue.number);
    ctx.log(`#${issue.number}  lost its lease (renewals failed until the claim ran out); stopped ${killed} agent(s)`);
  });
  inFlight.set(issue.number, { dir: entry.cwd, busy: false });
  // The same settlement as a first attempt: a throw is recorded in the queue of the lane it
  // happened in, and the lane is removed whatever the outcome, unless nothing could be recorded.
  let keepLane = false;
  let outcome: FixOutcome;
  try {
    outcome = await reviewAndLand(ctx, issue, entry.cwd, entry.result, maxPoints, say, ceiling);
  } catch (error) {
    const thrown = recordThrow(ctx, issue, error as Error, say, entry.result.pr);
    keepLane = thrown.keepLane;
    outcome = thrown.outcome;
  } finally {
    stopRenewing();
    try {
      handle.release();
    } catch (error) {
      say(`could not release the claim: ${(error as Error).message}`);
    }
    inFlight.delete(issue.number);
    // The same rule as any other exit: a revision that committed and died before its push has
    // its only copy in this lane, and a resume must not be where that goes.
    if (!ctx.dryRun && !keepLane) retireLane(ctx, issue.number, say);
  }
  return outcome;
}

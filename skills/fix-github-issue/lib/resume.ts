/**
 * Picking up after a run that died: clearing the worktrees it abandoned, finding the pull requests
 * it stranded, and putting those back through the review and landing path.
 *
 * Everything durable lives on the forge, so what a dead run leaves behind locally is a worktree
 * with no owner and, sometimes, a finished pull request with a verdict file nobody read.
 */

import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { claim, keepClaimed, liveGate, trackerIo } from '../../carve-github-issue/lib/claims.ts';
import { parseJsonFile, VERDICT_FILE } from './agent.ts';
import type { Context } from './context.ts';
import { parkIssue, reviewCount } from './labels.ts';
import { dirtyPaths, inFlight, removeWorktree } from './lane.ts';
import { type Issue, reviewAndLand, type WorkerResult } from './pipeline.ts';
import { pool } from './pool.ts';
import { sh } from './shell.ts';

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
  const managed = resolve(ctx.repoRoot, ctx.project.worktreeRoot);
  let repaired = 0;

  for (const line of sh(ctx, ['git', 'worktree', 'list', '--porcelain']).split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const dir = resolve(line.slice('worktree '.length).trim());
    if (!dir.startsWith(`${managed}/`)) continue;

    // Agents make scratch siblings next to their own worktree (`issue-1234-evidence`) to capture a
    // before state or write to the evidence branch. A pattern anchored on the number alone could
    // not see them, so a crashed lane left them behind permanently: nothing else walks this root.
    // They belong to the parent issue, so the claimed and dirty rules below judge them by the
    // parent where it still exists, and a sibling's removal takes only the sibling: removing by
    // issue number would also take the parent worktree this same pass may have chosen to keep.
    const parts = /issue-(\d+)(-[^/]+)?$/.exec(dir);
    const issue = parts?.[1];
    if (!issue) continue;
    const parent = resolve(managed, `issue-${issue}`);
    const isSibling = Boolean(parts?.[2]);
    const judged = isSibling && existsSync(parent) ? parent : dir;

    // A pull request means the work reached GitHub and is not ours to throw away; selection already
    // treats the issue as claimed, so leave both alone and let a human or a later round finish it.
    if (claimed.has(Number(issue))) {
      ctx.log(`reconcile: #${issue} has an open pull request; leaving its worktree in place`);
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
      ctx.log(`reconcile: #${issue} has uncommitted work and no pull request; leaving it for inspection`);
      parkForInspection(ctx, Number(issue), `An earlier run left uncommitted work in its lane (${judged}) and no pull request. A person inspects or removes it; the loop will not hand this issue to a fresh worker until the lane is gone.`);
      continue;
    }

    if (isSibling) {
      ctx.log(`reconcile: removing abandoned scratch worktree ${dir}`);
      try {
        sh(ctx, ['git', 'worktree', 'remove', '--force', dir]);
      } catch {
        rmSync(dir, { recursive: true, force: true });
      }
    } else {
      ctx.log(`reconcile: removing abandoned worktree for #${issue}`);
      removeWorktree(ctx, Number(issue));
    }
    repaired++;
  }

  if (repaired > 0) ctx.log(`reconcile: cleared ${repaired} abandoned worktree(s) from an earlier run`);
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
  const managed = resolve(ctx.repoRoot, ctx.project.worktreeRoot);
  const found: Stranded[] = [];

  for (const line of sh(ctx, ['git', 'worktree', 'list', '--porcelain']).split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const dir = resolve(line.slice('worktree '.length).trim());
    if (!dir.startsWith(`${managed}/`)) continue;
    const num = /issue-(\d+)$/.exec(dir)?.[1];
    if (!num) continue;
    if (inFlight.has(Number(num))) continue;

    const issue = all.find((candidate) => candidate.number === Number(num));
    if (!issue) continue; // closed or outside the window; reconcile owns the cleanup question

    // The safety labels that gate selection gate resumption too: a parked, skipped, DLQed, or
    // budget-exhausted issue belongs to a human even when a worktree still remembers it.
    if (issue.labels.some((l) => skipLabels.includes(l.name) || l.name === 'loop/dlq')) continue;
    if (reviewCount(issue.labels) >= ctx.knobs.maxReviewRounds) continue;

    const verdict = parseJsonFile<WorkerResult>(join(dir, VERDICT_FILE));
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
 * Lands what a dead run left finished, before anything new is selected.
 *
 * A stranded pull request is finished work, and landing it first also moves the base before fresh
 * lanes cut their branches from it.
 */
/** Parks an issue a dead run left for inspection, once: a parked issue is not commented on again. */
function parkForInspection(ctx: Context, issue: number, reason: string): void {
  if (ctx.dryRun) return;
  try {
    const labels = sh(ctx, ['gh', 'issue', 'view', String(issue), '--json', 'state,labels', '--jq', '[.state, (.labels[].name)] | join(" ")']);
    if (!labels.startsWith('OPEN') || labels.includes('loop/parked')) return;
    parkIssue(ctx, issue, reason);
  } catch (error) {
    ctx.log(`#${issue}  could not park it for inspection: ${(error as Error).message}`);
  }
}

export async function resumeStranded(
  ctx: Context,
  stranded: Stranded[],
  concurrency: number,
  maxPoints: number,
  ceiling: number = maxPoints,
): Promise<void> {
  if (stranded.length === 0) return;
  ctx.step(`Resuming ${stranded.length} stranded pull request(s) from an earlier run`);
  ctx.log(stranded.map((s) => `#${s.issue.number} (PR #${s.result.pr})`).join(', '));
  await pool(
    stranded.map((s) => s.issue),
    concurrency,
    async (issue) => {
      const entry = stranded.find((s) => s.issue.number === issue.number);
      if (!entry) return;
      const say = (message: string) => ctx.log(`#${issue.number}  ${message}`);
      // A fresh claim, never the dead run's, and the live gate first: the issue may have been
      // held, paused, carved, or claimed elsewhere since the run died.
      const io = trackerIo(ctx);
      const gate = liveGate(ctx, io, issue.number, ceiling);
      if (!gate.ok) {
        say(`not resuming: ${gate.why}`);
        if (gate.outcome === 'left-alone') parkForInspection(ctx, issue.number, `A dead run's pull request #${entry.result.pr} was not resumed because ${gate.why}. A person decides.`);
        return;
      }
      const handle = claim(ctx, io, issue.number, 'working');
      if (handle === 'busy') {
        say('not resuming: another run holds it');
        return;
      }
      const stopRenewing = keepClaimed(handle);
      inFlight.set(issue.number, { dir: entry.cwd, busy: false });
      try {
        await reviewAndLand(ctx, issue, entry.cwd, entry.result, maxPoints, say, ceiling);
      } finally {
        stopRenewing();
        try {
          handle.release();
        } catch (error) {
          say(`could not release the claim: ${(error as Error).message}`);
        }
        inFlight.delete(issue.number);
      }
    },
    (issue) => `#${issue.number}`,
  );
}

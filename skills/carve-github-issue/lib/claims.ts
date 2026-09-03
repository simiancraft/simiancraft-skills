/**
 * Claims and the live gate: the lease a run takes on an issue before it acts, honoured across
 * machines through the tracker, and the read every worker and knife makes immediately before
 * claiming, merging, or closing, so nothing acts on a trunk, a held leaf, or another run's issue.
 */

import type { Context } from '../../fix-github-issue/lib/context.ts';
import { HOLD_LABELS } from '../../fix-github-issue/lib/labels.ts';
import { api, mutate } from '../../fix-github-issue/lib/shell.ts';
import { type Claim, ghIo, liveClaim, pointsOf, readTree, type TrackerIo, type Tree } from './tree.ts';

export const CLAIM_TTL_MS = 30 * 60 * 1000;
export const CLAIM_RENEW_MS = 5 * 60 * 1000;

/** The tracker this context reads: the fake a test supplied, or GitHub. */
export function trackerIo(ctx: Context): TrackerIo {
  const io = ctx.io as Partial<TrackerIo> | undefined;
  return io && typeof io.view === 'function' && typeof io.search === 'function' ? (io as TrackerIo) : ghIo(ctx);
}

export function claimMarker(kind: Claim['kind'], runId: string, at: string, expires: string): string {
  return `<!-- carve-claim kind=${kind} run=${runId} at=${at} expires=${expires} -->`;
}

export type ClaimHandle = { kind: Claim['kind']; commentId: number | null; label: string; renew: () => void; release: (options?: { keepLabel?: boolean }) => void };

/**
 * Posts the claim comment, then the label, then re-reads: if an earlier unreleased, unexpired
 * claim by another run stands, this run posts its own unclaim, removes nothing else, and returns
 * `busy`. Ties go to the lower comment id, which every reader orders the same way.
 *
 * A dry run takes no claim and returns a handle whose writes are no-ops.
 */
export function claim(ctx: Context, io: TrackerIo, issue: number, kind: Claim['kind']): ClaimHandle | 'busy' {
  const label = kind === 'carving' ? 'loop/carving' : 'loop/working';
  if (ctx.dryRun) return { kind, commentId: null, label, renew: () => {}, release: () => {} };

  const before = readTree(ctx, issue, io);
  const standing = liveClaim(before, new Date().toISOString(), ctx.runId);
  if (standing) {
    ctx.log(`  #${issue}  ${standing.kind} claim by ${standing.runId} stands; busy`);
    return 'busy';
  }
  const at = new Date();
  const expires = new Date(at.getTime() + CLAIM_TTL_MS);
  mutate(ctx, `claim #${issue} (${kind})`, ['gh', 'issue', 'comment', String(issue), '--body', claimMarker(kind, ctx.runId, at.toISOString(), expires.toISOString())]);
  mutate(ctx, `label #${issue} ${label}`, ['gh', 'issue', 'edit', String(issue), '--add-label', label]);

  const after = readTree(ctx, issue, io);
  const mine = after.claims.find((c) => c.runId === ctx.runId && c.kind === kind && !c.released) ?? null;
  const winner = liveClaim(after, new Date().toISOString(), ctx.runId);
  if (winner && (mine === null || winner.commentId < mine.commentId)) {
    mutate(ctx, `unclaim #${issue} (${kind}), ${winner.runId} was first`, ['gh', 'issue', 'comment', String(issue), '--body', `<!-- carve-unclaim kind=${kind} run=${ctx.runId} -->`]);
    return 'busy';
  }
  const commentId = mine?.commentId ?? null;
  return {
    kind,
    commentId,
    label,
    renew: () => {
      if (commentId === null) return;
      const now = new Date();
      const body = claimMarker(kind, ctx.runId, now.toISOString(), new Date(now.getTime() + CLAIM_TTL_MS).toISOString());
      try {
        mutate(ctx, `renew claim on #${issue}`, ['gh', 'api', '-X', 'PATCH', `repos/${ctx.project.repo}/issues/comments/${commentId}`, '-f', `body=${body}`]);
      } catch (error) {
        ctx.log(`  #${issue}  could not renew the claim: ${(error as Error).message}`);
      }
    },
    release: (options = {}) => {
      mutate(ctx, `unclaim #${issue} (${kind})`, ['gh', 'issue', 'comment', String(issue), '--body', `<!-- carve-unclaim kind=${kind} run=${ctx.runId} -->`]);
      if (options.keepLabel) return;
      // The label comes off only when no other unreleased claim comment of this kind stands.
      const now = readTree(ctx, issue, io);
      const other = now.claims.some((c) => c.kind === kind && !c.released && c.runId !== ctx.runId && Date.parse(c.expires) > Date.now());
      if (!other) mutate(ctx, `unlabel #${issue} ${label}`, ['gh', 'issue', 'edit', String(issue), '--remove-label', label]);
    },
  };
}

/** The renewal timer for the life of a run; unref'd so it never keeps a process alive. */
export function keepClaimed(handle: ClaimHandle): () => void {
  const timer = setInterval(() => handle.renew(), CLAIM_RENEW_MS);
  timer.unref();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// The live gate
// ---------------------------------------------------------------------------

export type Gate = { ok: true; tree: Tree } | { ok: false; why: string; outcome: 'left-alone' | 'busy'; tree: Tree | null };

/**
 * A trunk by the state table: an unreleased record, an open child, or `loop/released`.
 */
export function isTrunk(tree: Tree): boolean {
  const labels = tree.issue.labels.map((l) => l.name);
  if (labels.includes('loop/released')) return true;
  if (tree.record && tree.record.state !== 'released') return true;
  return tree.children.some((c) => c.state === 'OPEN');
}

/** Why a leaf may not be worked, or null when it may. Reads the tree once. */
export function refusal(tree: Tree, ceiling: number): string | null {
  const issue = tree.issue;
  const labels = issue.labels.map((l) => l.name);
  if (issue.state !== 'OPEN') return `it is ${issue.state.toLowerCase()}`;
  const hold = labels.find((l) => HOLD_LABELS.includes(l));
  if (hold) return `it carries ${hold}`;
  const pausedAncestor = tree.ancestors.find((a) => a.labels.includes('loop/paused'));
  if (pausedAncestor) return `its ancestor #${pausedAncestor.number} is paused`;
  if (isTrunk(tree)) return 'it is a trunk: it has open children or an unreleased carving record';
  const points = pointsOf(issue.labels);
  if (points !== null && points > ceiling) return `it is sized ${points}, over the ceiling of ${ceiling}`;
  for (const blocker of tree.blockers) {
    if (blocker.state === 'CLOSED' && blocker.stateReason === 'COMPLETED') continue;
    return `it is blocked by #${blocker.number}, which is ${blocker.state === 'CLOSED' ? 'closed not planned' : blocker.state.toLowerCase()}`;
  }
  // Edges an ancestor's record commands, even if the tracker edge was removed by hand.
  for (const { via, node } of tree.recordBlockers) {
    if (node.state === 'CLOSED' && node.stateReason === 'COMPLETED') continue;
    return `the record on #${via} says it waits on #${node.number}, which is ${node.state === 'CLOSED' ? 'closed not planned' : node.state.toLowerCase()}`;
  }
  return null;
}

/**
 * Immediately before a claim, a merge, or a close: read the issue and its ancestors and refuse
 * anything the state table says a worker must not touch. `busy` when another run's claim stands.
 */
export function liveGate(ctx: Context, io: TrackerIo, issue: number, ceiling: number): Gate {
  const tree = readTree(ctx, issue, io);
  const why = refusal(tree, ceiling);
  if (why) return { ok: false, why, outcome: 'left-alone', tree };
  const standing = liveClaim(tree, new Date().toISOString(), ctx.runId);
  if (standing) return { ok: false, why: `${standing.kind} claim by ${standing.runId} stands`, outcome: 'busy', tree };
  return { ok: true, tree };
}

/** The `api` helper is re-exported so callers that only need claims do not import shell. */
export { api };

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
/** How long a claim waits for the thread to show it; a test sets the wait to zero. */
export const CLAIM_READBACK = { tries: 3, waitMs: 2_000 };

/** The tracker this context reads: the fake a test supplied, or GitHub. */
export function trackerIo(ctx: Context): TrackerIo {
  const io = ctx.io as Partial<TrackerIo> | undefined;
  return io && typeof io.view === 'function' && typeof io.search === 'function' ? (io as TrackerIo) : ghIo(ctx);
}

export function claimMarker(kind: Claim['kind'], runId: string, at: string, expires: string, token: string): string {
  return `<!-- carve-claim kind=${kind} run=${runId} at=${at} expires=${expires} token=${token} -->`;
}

/**
 * `renew` throws when the lease could not be extended; `expires` is the last expiry the tracker
 * is known to hold, which is the moment another run may take the issue.
 */
export type ClaimHandle = { kind: Claim['kind']; commentId: number | null; label: string; issue: number; key: string; expires: () => number; renew: () => void; release: (options?: { keepLabel?: boolean }) => void };

/** Issues whose lease this process could not keep, by repository and issue. The live gate refuses them. */
const lostLeases = new Set<string>();

/** The claims this process holds and has not released, by repository and issue. */
const heldClaims = new Set<string>();
/**
 * What a stopping run waits for before it exits: every lane to unwind through its own `finally`
 * and release its claim, so none outlives the process that took it. Bounded; the claims still
 * held when the time is up are returned by name, since the exit abandons them.
 */
export async function awaitReleases(graceMs = 30_000, sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms)): Promise<string[]> {
  const deadline = Date.now() + graceMs;
  while (heldClaims.size > 0 && Date.now() < deadline) await sleep(100);
  return [...heldClaims];
}
const leaseKey = (ctx: Context, issue: number) => `${ctx.project?.repo ?? ''}#${issue}`;
export const leaseLost = (ctx: Context, issue: number): boolean => lostLeases.has(leaseKey(ctx, issue));

/**
 * Posts the claim comment, then the label, then re-reads: if an earlier unreleased, unexpired
 * claim by another run stands, this run posts its own unclaim, removes nothing else, and returns
 * `busy`. Ties go to the lower comment id, which every reader orders the same way.
 *
 * A dry run takes no claim and returns a handle whose writes are no-ops.
 */
export async function claim(ctx: Context, io: TrackerIo, issue: number, kind: Claim['kind']): Promise<ClaimHandle | 'busy'> {
  const label = kind === 'carving' ? 'loop/carving' : 'loop/working';
  if (ctx.dryRun) return { kind, commentId: null, label, issue, key: leaseKey(ctx, issue), expires: () => Number.POSITIVE_INFINITY, renew: () => {}, release: () => {} };

  const before = readTree(ctx, issue, io);
  const standing = liveClaim(before, new Date().toISOString(), ctx.runId);
  if (standing) {
    ctx.log(`  #${issue}  ${standing.kind} claim by ${standing.runId} stands; busy`);
    return 'busy';
  }
  const at = new Date();
  const expires = new Date(at.getTime() + CLAIM_TTL_MS);
  const token = crypto.randomUUID();
  mutate(ctx, `claim #${issue} (${kind})`, ['gh', 'issue', 'comment', String(issue), '--body', claimMarker(kind, ctx.runId, at.toISOString(), expires.toISOString(), token)]);
  mutate(ctx, `label #${issue} ${label}`, ['gh', 'issue', 'edit', String(issue), '--add-label', label]);

  // The re-read must show this run's own claim: a claim nobody can see, its owner included, is
  // not a lock, and its lease could never be renewed. The thread can trail the write by a moment,
  // so look again a few times before giving up, and give up closed. It must be the claim just
  // posted, known by its token: a run that claimed, released, and claims again can be shown its
  // first claim by a read that trails the release, and that comment is no lease to renew.
  let after = readTree(ctx, issue, io);
  const own = () => after.claims.find((c) => c.runId === ctx.runId && c.kind === kind && !c.released && c.token === token) ?? null;
  for (let tries = 0; own() === null && tries < CLAIM_READBACK.tries; tries++) {
    // Awaited, not slept through: a claim that blocks the process would stall every other lane's renewals.
    if (CLAIM_READBACK.waitMs > 0) await Bun.sleep(CLAIM_READBACK.waitMs);
    after = readTree(ctx, issue, io);
  }
  const mine = own();
  const winner = liveClaim(after, new Date().toISOString(), ctx.runId);
  if (mine === null || (winner && winner.commentId < mine.commentId)) {
    const why = mine === null ? 'this run could not see its own claim on the thread' : `${winner?.runId} was first`;
    mutate(ctx, `unclaim #${issue} (${kind}), ${why}`, ['gh', 'issue', 'comment', String(issue), '--body', `<!-- carve-unclaim kind=${kind} run=${ctx.runId} -->`]);
    if (mine === null && !winner) mutate(ctx, `unlabel #${issue} ${label}`, ['gh', 'issue', 'edit', String(issue), '--remove-label', label]);
    return 'busy';
  }
  const commentId = mine.commentId;
  lostLeases.delete(leaseKey(ctx, issue));
  let confirmedExpiry = expires.getTime();
  heldClaims.add(leaseKey(ctx, issue));
  return {
    kind,
    commentId,
    label,
    issue,
    key: leaseKey(ctx, issue),
    expires: () => confirmedExpiry,
    // Throws when the write fails: a lease nobody extended is running out, and whoever holds the
    // handle has to know rather than find a line in the log.
    renew: () => {
      const now = new Date();
      const until = now.getTime() + CLAIM_TTL_MS;
      const body = claimMarker(kind, ctx.runId, now.toISOString(), new Date(until).toISOString(), token);
      try {
        mutate(ctx, `renew claim on #${issue}`, ['gh', 'api', '-X', 'PATCH', `repos/${ctx.project.repo}/issues/comments/${commentId}`, '-f', `body=${body}`]);
      } catch (error) {
        ctx.log(`  #${issue}  could not renew the claim: ${(error as Error).message}`);
        throw error;
      }
      confirmedExpiry = until;
    },
    release: (options = {}) => {
      heldClaims.delete(leaseKey(ctx, issue));
      // Releasing is the one write a stopping run still makes, or its claims would outlive it.
      mutate(ctx, `unclaim #${issue} (${kind})`, ['gh', 'issue', 'comment', String(issue), '--body', `<!-- carve-unclaim kind=${kind} run=${ctx.runId} -->`], { whileStopping: true });
      if (options.keepLabel) return;
      // The label comes off only when no other unreleased claim comment of this kind stands.
      const now = readTree(ctx, issue, io);
      const other = now.claims.some((c) => c.kind === kind && !c.released && c.runId !== ctx.runId && Date.parse(c.expires) > Date.now());
      if (!other) mutate(ctx, `unlabel #${issue} ${label}`, ['gh', 'issue', 'edit', String(issue), '--remove-label', label], { whileStopping: true });
    },
  };
}

/** How soon a failed renewal is tried again, and how close to expiry the lease is given up as lost. */
export const CLAIM_RETRY_MS = 60 * 1000;
export const CLAIM_LOSS_MARGIN_MS = 2 * 60 * 1000;

/** Runs `fn` after `ms` and returns its cancel. The default is an unref'd timeout, so it never keeps a process alive. */
export type Schedule = (fn: () => void, ms: number) => () => void;
const timeoutSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

/**
 * The renewal timer for the life of a run. A renewal that fails is tried again every minute. When
 * the last confirmed expiry is about to pass with no renewal confirmed, the lease is lost: another
 * run may now take the issue, so this one is marked, the live gate refuses it from then on (no
 * merge, no close, no claim-dependent write), and `onLost` lets the owner stop whatever it still
 * has running. The mark lasts until the returned stop is called. `clock` and `schedule` are injected so a
 * test can drive the ticks by hand.
 */
export function keepClaimed(handle: ClaimHandle, onLost?: () => void, clock: () => number = () => Date.now(), schedule: Schedule = timeoutSchedule): () => void {
  let cancel: (() => void) | null = null;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    let next = CLAIM_RENEW_MS;
    try {
      handle.renew();
    } catch {
      if (clock() >= handle.expires() - CLAIM_LOSS_MARGIN_MS) {
        lostLeases.add(handle.key);
        stopped = true;
        onLost?.();
        return;
      }
      next = CLAIM_RETRY_MS;
    }
    cancel = schedule(tick, next);
  };
  cancel = schedule(tick, CLAIM_RENEW_MS);
  return () => {
    stopped = true;
    cancel?.();
    // Lost is a fact about this lease, not about the issue: once its holder has stopped, a later
    // visit by this process may gate, claim, and appraise the issue like any other.
    lostLeases.delete(handle.key);
  };
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
  // A lease this process could not keep is no lease: another run may hold the issue by now.
  if (leaseLost(ctx, issue)) return { ok: false, why: 'this run lost its lease on the issue: its renewals failed until the claim ran out', outcome: 'busy', tree: null };
  const tree = readTree(ctx, issue, io);
  const why = refusal(tree, ceiling);
  if (why) return { ok: false, why, outcome: 'left-alone', tree };
  const standing = liveClaim(tree, new Date().toISOString(), ctx.runId);
  if (standing) return { ok: false, why: `${standing.kind} claim by ${standing.runId} stands`, outcome: 'busy', tree };
  return { ok: true, tree };
}

/** The `api` helper is re-exported so callers that only need claims do not import shell. */
export { api };

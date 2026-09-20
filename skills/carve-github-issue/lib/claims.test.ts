import { describe, expect, test } from 'bun:test';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import { CLAIM_LOSS_MARGIN_MS, CLAIM_READBACK, CLAIM_RENEW_MS, CLAIM_RETRY_MS, type ClaimHandle, type Schedule, claim, isTrunk, keepClaimed, leaseLost, liveGate, refusal } from './claims.ts';
import { FakeTracker, fakeIssue } from './fake-tracker.ts';
import { type Record, renderRecord } from './record.ts';
import { readTree } from './tree.ts';

const BOT = 'loop-bot';

function ctxFor(io: FakeTracker, runId = 'host-1-1'): Context {
  return {
    botLogin: BOT,
    runId,
    dryRun: false,
    dryRunLog: [],
    project: { repo: 'o/r' },
    log: () => {},
    io,
  } as unknown as Context;
}

function record(partial: Partial<Record> = {}): Record {
  return {
    generation: 1,
    epoch: 1,
    state: 'live',
    verdict: 'carve',
    reason: '',
    cut: null,
    children: [],
    supersedes: [],
    affected: [],
    ledger: [],
    revisits: 0,
    seen: { title: '', bodyHash: '', size: null, labels: [], holds: [], parent: null, comments: [], children: [], blockers: [] },
    at: '2026-09-03T12:00:00Z',
    ...partial,
  };
}

describe('refusal and isTrunk', () => {
  const alive = () => false;
  function gate(io: FakeTracker, n: number, ceiling = 2) {
    return refusal(readTree(ctxFor(io), n, io), ceiling);
  }
  test('refuses closed, held, paused-by-ancestor, trunk, oversized, blocked; passes a clean leaf', () => {
    const io = new FakeTracker(BOT, [
      fakeIssue(1, { subIssues: [2, 3], labels: [{ name: 'loop/paused' }] }),
      fakeIssue(2, { parentNumber: 1, labels: [{ name: 'size: 1' }] }),
      fakeIssue(3, { parentNumber: 1, state: 'CLOSED', stateReason: 'COMPLETED' }),
      fakeIssue(4, { labels: [{ name: 'size: 3' }] }),
      fakeIssue(5, { labels: [{ name: 'size: 1' }], blockedBy: { nodes: [{ number: 6, state: 'OPEN', stateReason: null }] } }),
      fakeIssue(6, { state: 'CLOSED', stateReason: 'NOT_PLANNED' }),
      fakeIssue(7, { labels: [{ name: 'size: 1' }], blockedBy: { nodes: [{ number: 3, state: 'OPEN', stateReason: null }] } }),
      fakeIssue(8, { labels: [{ name: 'needs-human' }] }),
    ]);
    expect(gate(io, 3)).toMatch(/closed/);
    expect(gate(io, 8)).toMatch(/needs-human/);
    expect(gate(io, 2)).toMatch(/ancestor #1 is paused/);
    expect(gate(io, 1)).toMatch(/paused|trunk/);
    expect(gate(io, 4)).toMatch(/over the ceiling/);
    expect(gate(io, 5)).toMatch(/blocked by #6/);
    expect(gate(io, 7)).toBeNull();
    expect(isTrunk(readTree(ctxFor(io), 1, io))).toBe(true);
    void alive;
  });
  test('an edge in an ancestor record holds even after the tracker edge was removed', () => {
    const rec = record({
      children: [
        { number: 12, piece: 0, kind: 'author', link: 'sub-issue', points: 1, order: 1, orderRung: 'dependency', dependsOn: [], status: 'open', paused: false, role: 'work', title: 'a' },
        { number: 13, piece: 1, kind: 'author', link: 'sub-issue', points: 1, order: 2, orderRung: 'dependency', dependsOn: [0], status: 'open', paused: false, role: 'work', title: 'b' },
      ],
    });
    const io = new FakeTracker(BOT, [
      fakeIssue(10, { subIssues: [12, 13], labels: [{ name: 'loop/carved' }] }),
      fakeIssue(12, { parentNumber: 10, labels: [{ name: 'size: 1' }] }),
      fakeIssue(13, { parentNumber: 10, labels: [{ name: 'size: 1' }] }),
    ]);
    io.comment(10, BOT, renderRecord(rec));
    expect(gate(io, 13)).toMatch(/record on #10 says it waits on #12/);
    io.close(12);
    expect(gate(io, 13)).toBeNull();
    expect(gate(io, 10)).toMatch(/trunk/);
  });
  test('a released trunk with only closed children and a small size is a leaf', () => {
    const io = new FakeTracker(BOT, [fakeIssue(10, { subIssues: [11], labels: [{ name: 'size: 1' }] }), fakeIssue(11, { parentNumber: 10, state: 'CLOSED', stateReason: 'COMPLETED' })]);
    io.comment(10, BOT, renderRecord(record({ state: 'released' })));
    expect(gate(io, 10)).toBeNull();
    io.addLabel(10, 'loop/released');
    expect(gate(io, 10)).toMatch(/trunk/);
  });
});

describe('claim', () => {
  test('posts the comment then the label, wins alone, releases with the label off', async () => {
    const io = new FakeTracker(BOT, [fakeIssue(1)]);
    const ctx = ctxFor(io);
    const handle = await claim(ctx, io, 1, 'working');
    expect(handle).not.toBe('busy');
    if (handle === 'busy') return;
    expect(io.writes.map((w) => w.argv[2])).toEqual(['comment', 'edit']);
    expect(io.view(1)?.labels.map((l) => l.name)).toEqual(['loop/working']);
    handle.release();
    const tree = readTree(ctx, 1, io);
    expect(tree.claims[0].released).toBe(true);
    expect(io.view(1)?.labels).toEqual([]);
  });
  test('the later claimant loses to an earlier live claim and posts its own unclaim; the label stays', async () => {
    const io = new FakeTracker(BOT, [fakeIssue(1)]);
    const first = await claim(ctxFor(io, 'other-host-9-1'), io, 1, 'working');
    expect(first).not.toBe('busy');
    const second = await claim(ctxFor(io, 'other-host-8-2'), io, 1, 'carving');
    expect(second).toBe('busy');
    const tree = readTree(ctxFor(io), 1, io);
    expect(tree.claims.filter((c) => !c.released).map((c) => c.runId)).toEqual(['other-host-9-1']);
    expect(io.view(1)?.labels.map((l) => l.name)).toEqual(['loop/working']);
  });
  test('a claim that raced in between the comment and the re-read is settled by comment order', async () => {
    const io = new FakeTracker(BOT, [fakeIssue(1)]);
    let injected = false;
    io.beforeWrite = (op) => {
      if (!injected && op.argv[2] === 'edit') {
        injected = true;
        io.comment(1, BOT, '<!-- carve-claim kind=working run=other-host-5-5 at=2026-09-03T12:00:00Z expires=2999-01-01T00:00:00Z -->');
      }
    };
    // The other run's comment lands after ours, so ours is earlier and wins.
    expect(await claim(ctxFor(io), io, 1, 'working')).not.toBe('busy');
  });
  test('two claims posted before either re-reads: the earlier comment wins and the later backs off', async () => {
    // The tightest race the protocol admits: both runs pass the first read, both post. The second
    // poster must see the first comment on its re-read and stand down, posting its own unclaim,
    // and the first poster must keep its claim. Nothing here depends on wall-clock timing.
    const io = new FakeTracker(BOT, [fakeIssue(1)]);
    let injected = false;
    io.beforeWrite = (op) => {
      if (!injected && op.argv[2] === 'comment') {
        injected = true;
        io.comment(1, BOT, '<!-- carve-claim kind=working run=other-host-5-5 at=2026-09-03T12:00:00Z expires=2999-01-01T00:00:00Z -->');
      }
    };
    expect(await claim(ctxFor(io), io, 1, 'working')).toBe('busy');
    const tree = readTree(ctxFor(io), 1, io);
    const live = tree.claims.filter((c) => !c.released);
    expect(live.map((c) => c.runId)).toEqual(['other-host-5-5']);
    expect(io.writes.some((w) => w.argv[2] === 'comment' && String(w.argv[w.argv.length - 1]).includes('carve-unclaim kind=working run=host-1-1'))).toBe(true);
  });
  test('liveGate answers busy under a foreign claim and left-alone for a refusal', async () => {
    const io = new FakeTracker(BOT, [fakeIssue(1, { labels: [{ name: 'size: 1' }] })]);
    await claim(ctxFor(io, 'other-host-9-1'), io, 1, 'carving');
    const gate = liveGate(ctxFor(io), io, 1, 2);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.outcome).toBe('busy');
    io.addLabel(1, 'loop/skip');
    const held = liveGate(ctxFor(io), io, 1, 2);
    if (!held.ok) expect(held.outcome).toBe('left-alone');
  });
  test('a run that claims, releases, and claims again holds a real lock the second time', async () => {
    const io = new FakeTracker(BOT, [fakeIssue(1, { labels: [{ name: 'size: 1' }] })]);
    const first = await claim(ctxFor(io), io, 1, 'working');
    if (first === 'busy') throw new Error('the first claim should win');
    first.release();
    const second = await claim(ctxFor(io), io, 1, 'working');
    if (second === 'busy') throw new Error('the second claim should win');
    // Renewable, which needs the claim's own comment, and visible to everyone else as a live claim.
    expect(second.commentId).not.toBeNull();
    expect(second.commentId).not.toBe(first.commentId);
    expect(await claim(ctxFor(io, 'other-host-9-1'), io, 1, 'working')).toBe('busy');
    second.release();
    expect(await claim(ctxFor(io, 'other-host-9-1'), io, 1, 'working')).not.toBe('busy');
  });
  test('a dry run takes no claim', async () => {
    const io = new FakeTracker(BOT, [fakeIssue(1)]);
    const ctx = { ...ctxFor(io), dryRun: true } as Context;
    const handle = await claim(ctx, io, 1, 'working');
    expect(handle).not.toBe('busy');
    expect(io.writes).toEqual([]);
  });
  test('a read that trails the release cannot pass the first claim off as the second', async () => {
    const io = new FakeTracker(BOT, [fakeIssue(1)]);
    const ctx = ctxFor(io);
    CLAIM_READBACK.waitMs = 0;
    const first = await claim(ctx, io, 1, 'working');
    if (first === 'busy') throw new Error('the first claim should succeed');
    const trailing = structuredClone(io.view(1));
    first.release();
    const view = io.view.bind(io);
    io.view = (n) => (n === 1 ? structuredClone(trailing) : view(n));
    expect(await claim(ctx, io, 1, 'working')).toBe('busy');
  });
});

describe('keepClaimed', () => {
  // Lost leases are module state keyed by repo and issue, so every case takes its own issue number.
  function rig(issue: number, renew: () => void, expiresAt = 30 * 60 * 1000) {
    const io = new FakeTracker(BOT, [fakeIssue(issue, { labels: [{ name: 'size: 1' }] })]);
    const ctx = ctxFor(io);
    const pending: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const schedule: Schedule = (fn, ms) => {
      const entry = { fn, ms, cancelled: false };
      pending.push(entry);
      return () => {
        entry.cancelled = true;
      };
    };
    const handle: ClaimHandle = { kind: 'working', commentId: 1, label: 'loop/claimed', issue, key: `o/r#${issue}`, expires: () => expiresAt, renew, release: () => {} };
    const state = { now: 0, lost: 0 };
    const stop = keepClaimed(handle, () => state.lost++, () => state.now, schedule);
    /** Fires the newest scheduled tick the way the timer would: a cancelled one never runs. */
    const fire = () => {
      const entry = pending[pending.length - 1];
      if (!entry.cancelled) entry.fn();
    };
    return { io, ctx, pending, state, stop, fire };
  }

  test('a renewal that succeeds keeps the lease and schedules the next one a full interval out', () => {
    let renewals = 0;
    const r = rig(9001, () => renewals++);
    expect(r.pending.map((p) => p.ms)).toEqual([CLAIM_RENEW_MS]);
    expect(renewals).toBe(0);
    r.fire();
    expect(renewals).toBe(1);
    expect(leaseLost(r.ctx, 9001)).toBe(false);
    expect(r.pending.map((p) => p.ms)).toEqual([CLAIM_RENEW_MS, CLAIM_RENEW_MS]);
  });

  test('a renewal that fails far from expiry is retried in a minute, and the lease stands', () => {
    const r = rig(9002, () => {
      throw new Error('tracker down');
    });
    r.state.now = 30 * 60 * 1000 - CLAIM_LOSS_MARGIN_MS - 1;
    r.fire();
    expect(leaseLost(r.ctx, 9002)).toBe(false);
    expect(r.state.lost).toBe(0);
    expect(r.pending.map((p) => p.ms)).toEqual([CLAIM_RENEW_MS, CLAIM_RETRY_MS]);
  });

  test('a renewal that fails inside the loss margin loses the lease once and schedules nothing more', () => {
    const r = rig(9003, () => {
      throw new Error('tracker down');
    });
    r.state.now = 30 * 60 * 1000 - CLAIM_LOSS_MARGIN_MS;
    r.fire();
    expect(leaseLost(r.ctx, 9003)).toBe(true);
    expect(r.state.lost).toBe(1);
    expect(r.pending).toHaveLength(1);
    // A stray late tick changes nothing.
    r.pending[0].fn();
    expect(r.state.lost).toBe(1);
    expect(r.pending).toHaveLength(1);
  });

  test('stop cancels the pending tick, even mid-retry, and a tick that slips through does nothing', () => {
    let renewals = 0;
    const r = rig(9004, () => {
      renewals++;
      throw new Error('tracker down');
    });
    r.fire();
    expect(r.pending.map((p) => p.ms)).toEqual([CLAIM_RENEW_MS, CLAIM_RETRY_MS]);
    r.stop();
    expect(r.pending[1].cancelled).toBe(true);
    r.pending[1].fn();
    expect(renewals).toBe(1);
    expect(r.pending).toHaveLength(2);
    expect(leaseLost(r.ctx, 9004)).toBe(false);
  });

  test('the live gate refuses an issue whose lease was lost, without reading the tracker', () => {
    const r = rig(9005, () => {
      throw new Error('tracker down');
    });
    expect(liveGate(r.ctx, r.io, 9005, 2).ok).toBe(true);
    r.state.now = 30 * 60 * 1000;
    r.fire();
    const gate = liveGate(r.ctx, r.io, 9005, 2);
    expect(gate).toMatchObject({ ok: false, outcome: 'busy', tree: null });
    expect(gate.ok === false && gate.why).toMatch(/lost its lease/);
  });
});

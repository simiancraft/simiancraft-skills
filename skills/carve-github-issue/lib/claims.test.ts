import { describe, expect, test } from 'bun:test';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import { claim, isTrunk, liveGate, refusal } from './claims.ts';
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
  test('posts the comment then the label, wins alone, releases with the label off', () => {
    const io = new FakeTracker(BOT, [fakeIssue(1)]);
    const ctx = ctxFor(io);
    const handle = claim(ctx, io, 1, 'working');
    expect(handle).not.toBe('busy');
    if (handle === 'busy') return;
    expect(io.writes.map((w) => w.argv[2])).toEqual(['comment', 'edit']);
    expect(io.view(1)?.labels.map((l) => l.name)).toEqual(['loop/working']);
    handle.release();
    const tree = readTree(ctx, 1, io);
    expect(tree.claims[0].released).toBe(true);
    expect(io.view(1)?.labels).toEqual([]);
  });
  test('the later claimant loses to an earlier live claim and posts its own unclaim; the label stays', () => {
    const io = new FakeTracker(BOT, [fakeIssue(1)]);
    const first = claim(ctxFor(io, 'other-host-9-1'), io, 1, 'working');
    expect(first).not.toBe('busy');
    const second = claim(ctxFor(io, 'other-host-8-2'), io, 1, 'carving');
    expect(second).toBe('busy');
    const tree = readTree(ctxFor(io), 1, io);
    expect(tree.claims.filter((c) => !c.released).map((c) => c.runId)).toEqual(['other-host-9-1']);
    expect(io.view(1)?.labels.map((l) => l.name)).toEqual(['loop/working']);
  });
  test('a claim that raced in between the comment and the re-read is settled by comment order', () => {
    const io = new FakeTracker(BOT, [fakeIssue(1)]);
    let injected = false;
    io.beforeWrite = (op) => {
      if (!injected && op.argv[2] === 'edit') {
        injected = true;
        io.comment(1, BOT, '<!-- carve-claim kind=working run=other-host-5-5 at=2026-09-03T12:00:00Z expires=2999-01-01T00:00:00Z -->');
      }
    };
    // The other run's comment lands after ours, so ours is earlier and wins.
    expect(claim(ctxFor(io), io, 1, 'working')).not.toBe('busy');
  });
  test('liveGate answers busy under a foreign claim and left-alone for a refusal', () => {
    const io = new FakeTracker(BOT, [fakeIssue(1, { labels: [{ name: 'size: 1' }] })]);
    claim(ctxFor(io, 'other-host-9-1'), io, 1, 'carving');
    const gate = liveGate(ctxFor(io), io, 1, 2);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.outcome).toBe('busy');
    io.addLabel(1, 'loop/skip');
    const held = liveGate(ctxFor(io), io, 1, 2);
    if (!held.ok) expect(held.outcome).toBe('left-alone');
  });
  test('a dry run takes no claim', () => {
    const io = new FakeTracker(BOT, [fakeIssue(1)]);
    const ctx = { ...ctxFor(io), dryRun: true } as Context;
    const handle = claim(ctx, io, 1, 'working');
    expect(handle).not.toBe('busy');
    expect(io.writes).toEqual([]);
  });
});

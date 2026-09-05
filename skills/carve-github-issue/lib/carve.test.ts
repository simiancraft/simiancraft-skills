import { describe, expect, test } from 'bun:test';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import { FakeTracker, fakeIssue } from './fake-tracker.ts';
import { buildLedger, carryIds, type Ledger, pauseSet, parseRecord, type Record, renderRecord } from './record.ts';
import {
  type Comment,
  claimsOf,
  descendants,
  fingerprint,
  intentsOf,
  liveClaim,
  needsRevisit,
  readTree,
  toNode,
  type Tree,
} from './tree.ts';

const BOT = 'loop-bot';
const NOW = '2026-09-03T12:00:00Z';

function ctxFor(io: FakeTracker): Context {
  return { botLogin: BOT, log: () => {}, io } as unknown as Context;
}

function comment(partial: Partial<Comment> & { body: string }): Comment {
  return { id: `IC_${partial.databaseId ?? 1}`, databaseId: 1, author: BOT, createdAt: NOW, ...partial };
}

function record(partial: Partial<Record> = {}): Record {
  return {
    generation: 1,
    epoch: 1,
    state: 'live',
    verdict: 'carve',
    reason: 'two objects',
    cut: null,
    children: [],
    supersedes: [],
    affected: [],
    ledger: [],
    revisits: 0,
    seen: { title: '', bodyHash: '', size: null, labels: [], holds: [], parent: null, comments: [], children: [], blockers: [] },
    at: NOW,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

describe('parseRecord', () => {
  test('round-trips renderRecord', () => {
    const r = record({ children: [{ number: 12, piece: 0, kind: 'author', link: 'sub-issue', points: 2, order: 1, orderRung: 'dependency', dependsOn: [], status: 'open', paused: false, role: 'work', title: 'a' }], ledger: [{ id: 'A1', text: 'x', owner: 0, status: 'open' }] });
    const parsed = parseRecord(comment({ body: renderRecord(r) }), BOT);
    expect(parsed).toEqual(r);
  });
  test('rejects a wrong author, a missing marker, and malformed json', () => {
    const body = renderRecord(record());
    expect(parseRecord(comment({ body, author: 'person' }), BOT)).toBeNull();
    expect(parseRecord(comment({ body: body.replace('<!-- carve-record', '<!-- carve-recor') }), BOT)).toBeNull();
    expect(parseRecord(comment({ body: body.replace('```json\n{', '```json\n{{') }), BOT)).toBeNull();
    expect(parseRecord(comment({ body: body.replace('state=live', 'state=applying') }), BOT)).toBeNull();
  });
});

describe('carryIds', () => {
  const previous: Ledger = [
    { id: 'A1', text: 'a posts table with title and body', owner: 0, status: 'open' },
    { id: 'A2', text: 'a posts API with create and list', owner: 0, status: 'open' },
    { id: 'A7', text: 'an authors table with a name', owner: 1, status: 'open' },
  ];
  test('keeps ids for equal and lightly edited text, mints new ones otherwise, and drops vanished ones', () => {
    const next = carryIds(previous, [{ text: 'A posts table, with title and body.' }, { text: 'a comments table' }, { text: 'an authors table with the name' }]);
    expect(next.map((c) => c.id)).toEqual(['A1', 'A3', 'A7']);
  });
  test('breaks ties by the earliest old id and never reuses one twice', () => {
    const next = carryIds(previous, [{ text: 'a posts table with title and body' }, { text: 'a posts table with title and body' }]);
    expect(next.map((c) => c.id)).toEqual(['A1', 'A3']);
  });
});

describe('buildLedger', () => {
  const rec = record({
    children: [
      { number: 11, piece: 0, kind: 'author', link: 'sub-issue', points: 2, order: 1, orderRung: 'dependency', dependsOn: [], status: 'open', paused: false, role: 'work', title: 'posts' },
      { number: 12, piece: 1, kind: 'author', link: 'sub-issue', points: 1, order: 2, orderRung: 'risk', dependsOn: [], status: 'open', paused: false, role: 'spike', title: 'which cache' },
    ],
    ledger: [
      { id: 'A1', text: 'posts', owner: 0, status: 'open' },
      { id: 'A2', text: 'cache chosen', owner: null, status: 'deferred', waitsOn: 1 },
      { id: 'A3', text: 'old ask', owner: null, status: 'withdrawn', cite: 'IC_5' },
    ],
  });
  const crit = rec.ledger.map(({ id, text }) => ({ id, text }));
  function treeWith(children: Array<Parameters<typeof fakeIssue>[1]>, trunkComments: Comment[] = []): Tree {
    const io = new FakeTracker(BOT, [
      fakeIssue(10, { subIssues: [11, 12], comments: trunkComments }),
      fakeIssue(11, { parentNumber: 10, ...children[0] }),
      fakeIssue(12, { parentNumber: 10, ...children[1] }),
    ]);
    return readTree(ctxFor(io), 10, io);
  }
  const cite = comment({ id: 'IC_5', databaseId: 5, author: 'person', body: 'drop the old ask' });

  test('a child closed COMPLETED completes; NOT_PLANNED orphans; reopened returns to open', () => {
    expect(buildLedger(rec.ledger, crit, rec, treeWith([{ state: 'CLOSED', stateReason: 'COMPLETED' }, {}], [cite]))[0].status).toBe('completed');
    expect(buildLedger(rec.ledger, crit, rec, treeWith([{ state: 'CLOSED', stateReason: 'NOT_PLANNED' }, {}], [cite]))[0].status).toBe('orphaned');
    const completed: Ledger = [{ ...rec.ledger[0], status: 'completed' }, rec.ledger[1], rec.ledger[2]];
    expect(buildLedger(completed, crit, rec, treeWith([{}, {}], [cite]))[0].status).toBe('open');
  });
  test('a spike closed makes its deferred criterion open and unowned', () => {
    const row = buildLedger(rec.ledger, crit, rec, treeWith([{}, { state: 'CLOSED', stateReason: 'COMPLETED' }], [cite]))[1];
    expect(row).toMatchObject({ status: 'open', owner: null });
  });
  test('a withdrawal stands while its comment does, and reopens when the comment is gone', () => {
    expect(buildLedger(rec.ledger, crit, rec, treeWith([{}, {}], [cite]))[2].status).toBe('withdrawn');
    expect(buildLedger(rec.ledger, crit, rec, treeWith([{}, {}], []))[2].status).toBe('open');
  });
  test('a criterion with no prior row is open and unowned', () => {
    expect(buildLedger(null, crit, null, treeWith([{}, {}]))[0]).toEqual({ id: 'A1', text: 'posts', owner: null, status: 'open' });
  });
});

describe('pauseSet', () => {
  const rec = record({
    children: [
      { number: 11, piece: 0, kind: 'author', link: 'sub-issue', points: 2, order: 1, orderRung: 'dependency', dependsOn: [], status: 'open', paused: false, role: 'work', title: 'a' },
      { number: 12, piece: 1, kind: 'author', link: 'sub-issue', points: 2, order: 2, orderRung: 'dependency', dependsOn: [0], status: 'open', paused: false, role: 'work', title: 'b' },
      { number: 13, piece: 2, kind: 'author', link: 'sub-issue', points: 2, order: 3, orderRung: 'dependency', dependsOn: [1], status: 'open', paused: false, role: 'work', title: 'c' },
      { number: 14, piece: 3, kind: 'reference', link: 'blocker', points: 2, order: 4, orderRung: 'dependency', dependsOn: [0], status: 'open', paused: false, role: 'work', title: 'd' },
      { number: 15, piece: 4, kind: 'author', link: 'sub-issue', points: 2, order: 5, orderRung: 'dependency', dependsOn: [], status: 'open', paused: false, role: 'work', title: 'e' },
    ],
    ledger: [
      { id: 'A1', text: 'x', owner: 0, status: 'open' },
      { id: 'A2', text: 'y', owner: 4, status: 'open' },
    ],
  });
  test('owners, dependents transitively, and descendants; never a blocker-linked reference', () => {
    const desc = (n: number) => (n === 12 ? [120, 121] : []);
    expect(pauseSet(rec, ['A1'], desc)).toEqual([11, 12, 13, 120, 121]);
    expect(pauseSet(rec, ['A2'], desc)).toEqual([15]);
  });
});

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

function markerComment(body: string, databaseId: number, author = BOT): Comment {
  return comment({ id: `IC_${databaseId}`, databaseId, author, body });
}

describe('fingerprint and needsRevisit', () => {
  function tree(mutate: (io: FakeTracker) => void = () => {}): Tree {
    const io = new FakeTracker(BOT, [
      fakeIssue(10, { title: 'trunk', body: 'b', labels: [{ name: 'size: 8' }, { name: 'loop/carved' }, { name: 'bug' }], subIssues: [11], blockedBy: { nodes: [{ number: 20, state: 'OPEN', stateReason: null }] } }),
      fakeIssue(11, { parentNumber: 10, title: 'leaf', comments: [markerComment('hi', 3, 'person')] }),
      fakeIssue(20, {}),
    ]);
    mutate(io);
    return readTree(ctxFor(io), 10, io);
  }
  test('excludes loop labels and bot marker comments; includes holds, comment bodies, child edges, and blocker states', () => {
    const base = fingerprint(tree(), BOT);
    expect(base.labels).toEqual(['bug', 'size: 8']);
    expect(base.holds).toEqual([]);
    const withMarker = fingerprint(tree((io) => io.comment(10, BOT, '<!-- carve-claim kind=carving run=x at=t expires=t -->')), BOT);
    expect(withMarker).toEqual(base);
    const withPerson = fingerprint(tree((io) => io.comment(10, 'person', 'thoughts')), BOT);
    expect(withPerson.comments.length).toBe(1);
    const withHold = fingerprint(tree((io) => io.addLabel(10, 'needs-human')), BOT);
    expect(withHold.holds).toEqual(['needs-human']);
    expect(withHold.labels).toEqual(['bug', 'needs-human', 'size: 8']);
    const blockerClosed = fingerprint(tree((io) => io.close(20)), BOT);
    expect(blockerClosed.blockers[0].state).toBe('CLOSED');
  });
  test('is order-independent', () => {
    const a = fingerprint(tree((io) => { io.issues.get(10)!.subIssues = [11]; }), BOT);
    const io2 = new FakeTracker(BOT, [
      fakeIssue(10, { title: 'trunk', body: 'b', labels: [{ name: 'bug' }, { name: 'loop/carved' }, { name: 'size: 8' }], subIssues: [11], blockedBy: { nodes: [{ number: 20, state: 'OPEN', stateReason: null }] } }),
      fakeIssue(11, { parentNumber: 10, title: 'leaf', comments: [markerComment('hi', 3, 'person')] }),
      fakeIssue(20, {}),
    ]);
    expect(fingerprint(readTree(ctxFor(io2), 10, io2), BOT)).toEqual(a);
  });
  test('names the first differing field, no-record, and nothing for a released record', () => {
    const t = tree();
    const seen = fingerprint(t, BOT);
    expect(needsRevisit(null, t, BOT)).toBe('no-record');
    expect(needsRevisit(record({ seen }), t, BOT)).toBeNull();
    expect(needsRevisit(record({ seen: { ...seen, title: 'other' } }), t, BOT)).toBe('title');
    expect(needsRevisit(record({ seen: { ...seen, holds: ['needs-human'] } }), t, BOT)).toBe('holds');
    expect(needsRevisit(record({ state: 'released', seen: { ...seen, title: 'other' } }), t, BOT)).toBeNull();
    const closedChild = tree((io) => io.close(11));
    expect(needsRevisit(record({ seen }), closedChild, BOT)).toBe('children');
  });
});

describe('claims', () => {
  const claim = (run: string, expires: string, id: number, kind = 'carving') => markerComment(`<!-- carve-claim kind=${kind} run=${run} at=${NOW} expires=${expires} -->`, id);
  const unclaim = (run: string, id: number, kind = 'carving') => markerComment(`<!-- carve-unclaim kind=${kind} run=${run} -->`, id);
  function treeWith(comments: Comment[]): Tree {
    const io = new FakeTracker(BOT, [fakeIssue(10, { comments })]);
    return readTree(ctxFor(io), 10, io);
  }
  const alive = () => false;
  test('the earliest unreleased, unexpired claim not ours wins; released, expired, torn, and tied claims', () => {
    const later = '2026-09-03T12:30:00Z';
    const t = treeWith([claim('a', later, 1), claim('b', later, 2), unclaim('a', 3)]);
    expect(liveClaim(t, NOW, undefined, alive)?.runId).toBe('b');
    expect(liveClaim(treeWith([claim('a', '2026-09-03T11:00:00Z', 1)]), NOW, undefined, alive)).toBeNull();
    expect(liveClaim(treeWith([claim('a', later, 1)]), NOW, 'a', alive)).toBeNull();
    expect(liveClaim(treeWith([claim('a', later, 2), claim('b', later, 1, 'working')]), NOW, undefined, alive)?.runId).toBe('b');
    expect(liveClaim(treeWith([claim('a', later, 1)]), NOW, undefined, () => true)).toBeNull();
    expect(claimsOf(treeWith([claim('a', later, 1, 'other' as 'carving')]).issue, BOT)).toEqual([]);
  });
});

describe('intents', () => {
  const trunk = (labels: string[], comments: Comment[], state: 'OPEN' | 'CLOSED' = 'OPEN', stateReason: string | null = null) =>
    new FakeTracker(BOT, [fakeIssue(10, { labels: labels.map((name) => ({ name })), comments, state, stateReason })]).view(10)!;
  const rec = (state: Record['state'], id: number, gen = 1, verdict = 'carve') => markerComment(renderRecord(record({ state, generation: gen, verdict })), id);

  test('an applying record is finished by a live record of the same generation', () => {
    expect(intentsOf(trunk([], [rec('applying', 1)]), BOT)).toMatchObject([{ kind: 'applying', finished: false }]);
    expect(intentsOf(trunk([], [rec('applying', 1), rec('live', 2)]), BOT)[0].finished).toBe(true);
    expect(intentsOf(trunk([], [rec('applying', 1), rec('live', 2, 2)]), BOT)[0].finished).toBe(false);
  });
  test('a released record is finished by the label, by a size label, by a newer record, or by a close, and a reopen does not revive it', () => {
    expect(intentsOf(trunk([], [rec('released', 1)]), BOT)[0].finished).toBe(false);
    expect(intentsOf(trunk(['loop/released'], [rec('released', 1)]), BOT)[0].finished).toBe(true);
    expect(intentsOf(trunk(['size: 1'], [rec('released', 1)]), BOT)[0].finished).toBe(true);
    expect(intentsOf(trunk([], [rec('released', 1), rec('applying', 2, 2)]), BOT)[0].finished).toBe(true);
  });
  test('a hand-off is finished by a later live record with its verdict; a close by a close with the matching reason', () => {
    const handoff = markerComment('<!-- carve-handoff verdict=too-uncertain gen=1 -->\n```json\n{"reason":"why"}\n```', 1);
    expect(intentsOf(trunk([], [handoff]), BOT)).toMatchObject([{ kind: 'carve-handoff', finished: false, payload: { verdict: 'too-uncertain', reason: 'why' } }]);
    expect(intentsOf(trunk([], [handoff, rec('live', 2, 1, 'too-uncertain')]), BOT)[0].finished).toBe(true);
    const close = markerComment('<!-- loop-close verdict=obsolete by=appraiser -->\nnot needed', 1);
    expect(intentsOf(trunk([], [close]), BOT)[0].finished).toBe(false);
    expect(intentsOf(trunk([], [close], 'CLOSED', 'COMPLETED'), BOT)[0].finished).toBe(false);
    expect(intentsOf(trunk([], [close], 'CLOSED', 'NOT_PLANNED'), BOT)[0].finished).toBe(true);
    const appraise = markerComment('<!-- appraise-handoff verdict=needs-decision -->', 1);
    expect(intentsOf(trunk(['needs-decision'], [appraise]), BOT)[0].finished).toBe(true);
  });
});

describe('toNode', () => {
  const raw = {
    number: 5,
    title: 't',
    author: { login: 'octo' },
    body: 'b',
    state: 'OPEN',
    stateReason: null,
    labels: [],
    createdAt: NOW,
    closedAt: null,
    parent: { number: 1 },
    subIssues: { nodes: [{ number: 7 }, { number: 6 }], totalCount: 2 },
    subIssuesSummary: { total: 2, completed: 0 },
    blockedBy: { nodes: [] },
    comments: [
      { id: 'IC_a', author: { login: BOT }, body: 'x', createdAt: NOW },
      { id: 'IC_b', author: null, body: 'y', createdAt: NOW },
      { id: 'IC_c', author: { login: 'p' }, body: 'z', createdAt: NOW },
    ],
  };
  const rest = [
    { id: 20, node_id: 'IC_b', user: null },
    { id: 10, node_id: 'IC_a', user: { login: BOT } },
  ];
  test('maps gh shapes, joins comments on node_id in databaseId order, drops the unmatched, names a null author ghost', () => {
    const logs: string[] = [];
    const node = toNode(raw, rest, BOT, (m) => logs.push(m));
    expect(node.author).toBe('octo');
    expect(node.subIssues).toEqual([7, 6]);
    expect(node.parent).toEqual({ number: 1 });
    expect(node.comments.map((c) => [c.id, c.databaseId, c.author])).toEqual([
      ['IC_a', 10, BOT],
      ['IC_b', 20, 'ghost'],
    ]);
    expect(logs.some((l) => l.includes('IC_c'))).toBe(true);
  });
});

describe('readTree and descendants', () => {
  test('reads children, blockers, ancestors, depth, generation from the larger of record and label, and epoch', () => {
    const io = new FakeTracker(BOT, [
      fakeIssue(1, { subIssues: [2] }),
      fakeIssue(2, { parentNumber: 1, subIssues: [3], labels: [{ name: 'loop/carve-gen: 3' }], comments: [markerComment(renderRecord(record({ generation: 2, epoch: 4 })), 1)] }),
      fakeIssue(3, { parentNumber: 2, subIssues: [4], blockedBy: { nodes: [{ number: 9, state: 'OPEN', stateReason: null }] } }),
      fakeIssue(4, { parentNumber: 3 }),
    ]);
    const t = readTree(ctxFor(io), 3, io);
    expect(t.depth).toBe(2);
    expect(t.ancestors.map((a) => a.number)).toEqual([2, 1]);
    expect(t.ancestors[0].record?.generation).toBe(2);
    expect(t.blockers[0].state).toBe('DELETED');
    const t2 = readTree(ctxFor(io), 2, io);
    expect(t2.generation).toBe(3);
    expect(t2.epoch).toBe(4);
    expect(descendants(1, io)).toEqual([2, 3, 4]);
  });
});

describe('FakeTracker writes', () => {
  test('interprets create, edit, comment, close, and throws once when told to', () => {
    const io = new FakeTracker(BOT, [fakeIssue(1)]);
    io.write({ description: 'create', argv: ['gh', 'issue', 'create', '--title', 'child', '--body', 'b', '--parent', '1', '--label', 'spike'] });
    const child = io.lastCreated();
    expect(io.view(1)?.subIssues).toEqual([child]);
    expect(io.view(child)?.labels).toEqual([{ name: 'spike' }]);
    io.write({ description: 'edge', argv: ['gh', 'issue', 'edit', String(child), '--add-blocked-by', '1', '--add-label', 'loop/paused'] });
    expect(io.view(child)?.blockedBy?.nodes[0].number).toBe(1);
    io.throwOn = /boom/;
    expect(() => io.write({ description: 'boom', argv: ['gh', 'issue', 'comment', '1', '--body', 'x'] })).toThrow('injected failure');
    io.write({ description: 'boom', argv: ['gh', 'issue', 'comment', '1', '--body', 'x'] });
    expect(io.view(1)?.comments.length).toBe(1);
    io.write({ description: 'close', argv: ['gh', 'issue', 'close', '1', '--reason', 'not planned'] });
    expect(io.view(1)?.stateReason).toBe('NOT_PLANNED');
  });
});

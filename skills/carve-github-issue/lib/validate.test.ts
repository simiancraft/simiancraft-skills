import { describe, expect, test } from 'bun:test';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import { type Carving, depthOf, normalize, validateCarving, validateConfirmation } from './carve.ts';
import { FakeTracker, fakeIssue } from './fake-tracker.ts';
import type { Cut, Piece, Record } from './record.ts';
import { readTree, type Tree } from './tree.ts';

const BOT = 'loop-bot';
const SCALE = [1, 2, 3, 5, 8, 13];
const KNOBS = { ceiling: 2, maxChildren: 8 };

function ctxFor(io: FakeTracker): Context {
  return { botLogin: BOT, log: () => {}, io } as unknown as Context;
}

function trunk(children: number[] = []): { io: FakeTracker; tree: Tree } {
  const io = new FakeTracker(BOT, [
    fakeIssue(10, { title: '[carve-test] big', labels: [{ name: 'size: 8' }], subIssues: children }),
    ...children.map((n) => fakeIssue(n, { parentNumber: 10, title: `child ${n}` })),
    fakeIssue(40, { title: 'elsewhere open' }),
    fakeIssue(41, { title: 'elsewhere done', state: 'CLOSED', stateReason: 'COMPLETED' }),
    fakeIssue(42, { title: 'elsewhere dropped', state: 'CLOSED', stateReason: 'NOT_PLANNED' }),
    fakeIssue(43, { title: 'elsewhere parented', parentNumber: 44 }),
    fakeIssue(44, { subIssues: [43] }),
    fakeIssue(45, { title: 'blocks on trunk', blockedBy: { nodes: [{ number: 10, state: 'OPEN', stateReason: null }] } }),
  ]);
  return { io, tree: readTree(ctxFor(io), 10, io) };
}

const body = '## Scope\nx\n## Acceptance\ny\n## Proof\nz';
function piece(partial: Partial<Piece> = {}): Piece {
  return { kind: 'author', title: 't', body, points: 2, role: 'work', criteria: [], dependsOn: [], order: 1, orderRung: 'dependency', ...partial };
}
function cut(partial: Partial<Cut> = {}): Cut {
  return {
    seam: 'domain',
    higherRungs: [],
    relation: 'layers',
    state: 'complete',
    deferred: [],
    pieces: [piece({ criteria: ['A1'], order: 1 }), piece({ criteria: ['A2'], order: 2, dependsOn: [0] })],
    groundwork: [],
    width: null,
    balance: 'even',
    independence: 'yes',
    ...partial,
  };
}
function carving(partial: Partial<Carving> = {}, c: Partial<Cut> = {}): Carving {
  return {
    issue: 10,
    mode: 'carve',
    verdict: 'carve',
    reason: 'two things',
    criteria: [
      { id: 'A1', text: 'one' },
      { id: 'A2', text: 'two' },
    ],
    ledger: [
      { id: 'A1', text: 'one', owner: 0, status: 'open' },
      { id: 'A2', text: 'two', owner: 1, status: 'open' },
    ],
    chosen: 0,
    cuts: [cut(c)],
    ...partial,
  };
}
function faultsOf(c: unknown, tree: Tree, mode: 'carve' | 'revisit' = 'carve'): string[] {
  const r = validateCarving(c, { mode, knobs: KNOBS, tree, scale: SCALE });
  return r.ok ? [] : r.faults;
}

describe('validateCarving', () => {
  const { tree } = trunk([11]);
  test('accepts a well-formed carve', () => {
    expect(faultsOf(carving(), tree)).toEqual([]);
  });
  test('mode, verdict, issue, reason', () => {
    expect(faultsOf(carving({ mode: 'revisit' }), tree).join()).toMatch(/mode/);
    expect(faultsOf(carving({ verdict: 'still-good' }), tree).join()).toMatch(/verdict/);
    expect(faultsOf(carving({ issue: 11 }), tree).join()).toMatch(/names issue 11/);
    expect(faultsOf(carving({ reason: '' }), tree).join()).toMatch(/no reason/);
  });
  test('bounds: points on the scale and under the ceiling, piece count, fan-out', () => {
    expect(faultsOf(carving({}, { pieces: [piece({ criteria: ['A1', 'A2'], points: 4 }), piece({ criteria: [], order: 2 })] }), tree).join()).toMatch(/on the scale/);
    expect(faultsOf(carving({}, { pieces: [piece({ criteria: ['A1', 'A2'], points: 3 }), piece({ criteria: [], order: 2 })] }), tree).join()).toMatch(/over the ceiling/);
    expect(faultsOf(carving({ ledger: [{ id: 'A1', text: 'one', owner: 0, status: 'open' }, { id: 'A2', text: 'two', owner: 0, status: 'open' }] }, { pieces: [piece({ criteria: ['A1', 'A2'] })] }), tree).join()).toMatch(/at least 2/);
    const many = Array.from({ length: 9 }, (_, i) => piece({ criteria: i === 0 ? ['A1', 'A2'] : [], order: i + 1 }));
    expect(faultsOf(carving({ ledger: [{ id: 'A1', text: 'one', owner: 0, status: 'open' }, { id: 'A2', text: 'two', owner: 0, status: 'open' }] }, { pieces: many }), tree).join()).toMatch(/maxChildren/);
  });
  test('cycles, order consistency, headings, ownership, higher rungs', () => {
    expect(faultsOf(carving({}, { pieces: [piece({ criteria: ['A1'], dependsOn: [1] }), piece({ criteria: ['A2'], order: 2, dependsOn: [0] })] }), tree).join()).toMatch(/cycle/);
    expect(faultsOf(carving({}, { pieces: [piece({ criteria: ['A1'], order: 1, dependsOn: [1] }), piece({ criteria: ['A2'], order: 2 })] }), tree).join()).toMatch(/ordered before/);
    expect(faultsOf(carving({}, { pieces: [piece({ criteria: ['A1'], body: '## Scope\nx' }), piece({ criteria: ['A2'], order: 2 })] }), tree).join()).toMatch(/lacks the heading/);
    expect(faultsOf(carving({}, { pieces: [piece({ criteria: ['A1', 'A2'] }), piece({ criteria: ['A2'], order: 2 })] }), tree).join()).toMatch(/one owner each/);
    expect(faultsOf(carving({ ledger: [{ id: 'A1', text: 'one', owner: 0, status: 'open' }, { id: 'A2', text: 'two', owner: 0, status: 'open' }] }, { pieces: [piece({ criteria: ['A1'] }), piece({ criteria: [], order: 2 })] }), tree).join()).toMatch(/owned by no piece/);
    expect(faultsOf(carving({}, { seam: 'file' }), tree).join()).toMatch(/why domain did not apply/);
    expect(faultsOf(carving({}, { seam: 'file', higherRungs: ['domain', 'tier', 'route', 'area'].map((s) => ({ seam: s as Cut['seam'], why: 'no' })) }), tree)).toEqual([]);
  });
  test('child and reference kinds against the tree; a reference inside the tree is rejected', () => {
    expect(faultsOf(carving({}, { pieces: [piece({ kind: 'child', number: 11, title: undefined, body: undefined, points: null, criteria: ['A1'] }), piece({ criteria: ['A2'], order: 2 })] }), tree)).toEqual([]);
    expect(faultsOf(carving({}, { pieces: [piece({ kind: 'reference', number: 11, criteria: ['A1'] }), piece({ criteria: ['A2'], order: 2 })] }), tree).join()).toMatch(/already a child/);
    expect(faultsOf(carving({}, { pieces: [piece({ kind: 'child', number: 40, criteria: ['A1'] }), piece({ criteria: ['A2'], order: 2 })] }), tree).join()).toMatch(/not a child/);
  });
  test('one adopted child may stand alone when it owns every criterion', () => {
    const one = carving({ ledger: [{ id: 'A1', text: 'one', owner: 0, status: 'open' }, { id: 'A2', text: 'two', owner: 0, status: 'open' }] }, { pieces: [piece({ kind: 'child', number: 11, criteria: ['A1', 'A2'] })] });
    expect(faultsOf(one, tree)).toEqual([]);
    const partial = carving({ ledger: [{ id: 'A1', text: 'one', owner: 0, status: 'open' }, { id: 'A2', text: 'two', owner: null, status: 'orphaned' }] }, { pieces: [piece({ kind: 'child', number: 11, criteria: ['A1'] })] });
    expect(faultsOf(partial, tree).join()).toMatch(/A2 is unowned/);
  });
  test('a partial cut needs a spike; deferred criteria wait on it; a width cut is shards', () => {
    const spiked = carving(
      { ledger: [{ id: 'A1', text: 'one', owner: 0, status: 'open' }, { id: 'A2', text: 'two', owner: null, status: 'deferred', waitsOn: 0 }] },
      { state: 'partial', relation: 'waiting', pieces: [piece({ role: 'spike', criteria: ['A1'] })], deferred: [{ criterion: 'A2', waitsOn: 0 }] },
    );
    expect(faultsOf(spiked, tree)).toEqual([]);
    expect(faultsOf(carving({}, { state: 'partial' }), tree).join()).toMatch(/no spike/);
    expect(faultsOf(carving({}, { width: { instances: ['a', 'b'], perInstance: 'x' } }), tree).join()).toMatch(/shards/);
  });
  test('hand-offs need affected; revisit verdicts carry the right parts; supersedes checks the record', () => {
    expect(faultsOf(carving({ verdict: 'too-uncertain', cuts: undefined, chosen: undefined }), tree).join()).toMatch(/affected/);
    expect(faultsOf(carving({ verdict: 'too-uncertain', cuts: undefined, chosen: undefined, affected: ['A1'] }), tree)).toEqual([]);
    expect(faultsOf(carving({ mode: 'revisit', verdict: 'still-good', cuts: undefined, chosen: undefined }), tree, 'revisit')).toEqual([]);
    expect(faultsOf(carving({ mode: 'revisit', verdict: 'still-good' }), tree, 'revisit').join()).toMatch(/carries no cuts/);
    const withRecord = { ...tree, record: { children: [{ number: 11 }] } as unknown as Record };
    expect(faultsOf(carving({ mode: 'revisit', verdict: 'amend', supersedes: [{ old: 11, replacements: [0], reason: 'r' }] }), withRecord, 'revisit')).toEqual([]);
    expect(faultsOf(carving({ mode: 'revisit', verdict: 'amend', supersedes: [{ old: 12, replacements: [0], reason: 'r' }] }), withRecord, 'revisit').join()).toMatch(/not a child of the latest record/);
  });
  test('depthOf is the ancestor count', () => {
    expect(depthOf(tree)).toBe(0);
  });
});

describe('validateConfirmation', () => {
  const base = { issue: 10, mode: 'carve', agree: true, finding: 'cover', seam: 'agree', seamCase: '', reason: 'ok' };
  test('accepts an agreement and rejects mismatched findings', () => {
    expect(validateConfirmation(base, 'carve').ok).toBe(true);
    expect(validateConfirmation({ ...base, finding: 'gap' }, 'carve').ok).toBe(false);
    expect(validateConfirmation({ ...base, agree: false, finding: 'gap' }, 'carve').ok).toBe(true);
    expect(validateConfirmation({ ...base, agree: true, seam: 'higher-available', seamCase: 'domain' }, 'carve').ok).toBe(false);
    expect(validateConfirmation({ ...base, agree: false, seam: 'higher-available', seamCase: '' }, 'carve').ok).toBe(false);
    expect(validateConfirmation({ ...base, finding: 'still-good' }, 'carve').ok).toBe(false);
    expect(validateConfirmation({ ...base, mode: 'revisit', finding: 'still-good' }, 'revisit').ok).toBe(true);
    expect(validateConfirmation({ ...base, finding: 'hand-off-agree' }, 'carve').ok).toBe(true);
  });
});

describe('normalize', () => {
  test('adopts a child, attaches an open unparented reference, edges a parented one, completes a closed one, refuses not-planned and cycles', () => {
    const { io, tree } = trunk([11]);
    const pieces: Piece[] = [
      piece({ kind: 'child', number: 11, criteria: ['A1'] }),
      piece({ kind: 'reference', number: 40, order: 2 }),
      piece({ kind: 'reference', number: 43, order: 3 }),
      piece({ kind: 'reference', number: 41, order: 4 }),
      piece({ criteria: ['A2'], order: 5 }),
    ];
    const r = normalize(cut({ pieces }), tree, io);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.map((p) => p.action)).toEqual(['adopt', 'attach', 'edge', 'complete', 'author']);
    const bad = normalize(cut({ pieces: [piece({ kind: 'reference', number: 42 }), piece({ kind: 'reference', number: 45, order: 2 }), piece({ kind: 'reference', number: 99, order: 3 })] }), tree, io);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.faults.join('\n')).toMatch(/closed not planned/);
    expect(bad.faults.join('\n')).toMatch(/blocked by #10/);
    expect(bad.faults.join('\n')).toMatch(/does not exist/);
  });
});

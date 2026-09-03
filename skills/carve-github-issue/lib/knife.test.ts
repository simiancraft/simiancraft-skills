import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Context, createContext } from '../../fix-github-issue/lib/context.ts';
import type { ProjectConfig } from '../../fix-github-issue/lib/config.ts';
import { CARVE_DEFAULTS, type CarveKnobs, type Carving, type Confirmation } from './carve.ts';
import { FakeTracker, fakeIssue } from './fake-tracker.ts';
import { carveIssue } from './knife.ts';
import type { Record } from './record.ts';
import { readTree } from './tree.ts';

const BOT = 'loop-bot';
const HERE = import.meta.dir;
let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'knife-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const PROJECT: ProjectConfig = {
  name: 'Test',
  repo: 'o/r',
  remote: 'origin',
  baseBranch: 'main',
  evidenceBranch: 'evidence',
  checkCommand: 'true',
  installCommand: 'true',
  conventionDocs: [],
  sizingScale: 'fib',
  sharedServices: [],
  portBase: 9000,
  portSpan: 10,
  pathAliases: [],
  sourceExtensions: ['.ts'],
  alwaysInvalidates: [],
  touchPaths: { migration: [], ci: [] },
  worktreeRoot: '../wt',
};

function fixture(name: string, answer: unknown): string {
  const path = join(scratch, `${name}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(answer));
  return path;
}

function ctxFor(io: FakeTracker, runId = 'host-1-1'): Context {
  const ctx = createContext({
    project: PROJECT,
    knobs: { autoMerge: 'never', maxReviewRounds: 3, checksTimeoutMinutes: 1, smokeTimeoutMinutes: 1 },
    seats: { worker: { engine: 'fixture' }, reviewer: { engine: 'fixture2' } },
    repoRoot: scratch,
    invokeRoot: scratch,
    promptsDirs: [join(HERE, '..', 'prompts'), join(HERE, '..', '..', 'appraise-github-issues', 'prompts')],
    dryRun: false,
    runDir: join(scratch, 'runs'),
    botLogin: BOT,
    io,
    log: () => {},
    step: () => {},
  });
  ctx.runId = runId;
  return ctx;
}

function knobs(carver: string, confirmer: string, partial: Partial<CarveKnobs> = {}): CarveKnobs {
  return { ceiling: 2, ...CARVE_DEFAULTS, callbacksDir: join(scratch, 'callbacks'), seats: { carver: { engine: 'fixture', model: carver }, confirmer: { engine: 'fixture2', model: confirmer } }, ...partial };
}

const body = '## Scope\nx\n## Acceptance\ny\n## Proof\nz';
const CRIT = [
  { id: 'A1', text: 'a posts table' },
  { id: 'A2', text: 'a posts API' },
  { id: 'A3', text: 'an authors table' },
];
function carving(issue: number, partial: Partial<Carving> = {}): Carving {
  return {
    issue,
    mode: 'carve',
    verdict: 'carve',
    reason: 'two domain objects',
    criteria: CRIT,
    ledger: [
      { id: 'A1', text: 'a posts table', owner: 0, status: 'open' },
      { id: 'A2', text: 'a posts API', owner: 0, status: 'open' },
      { id: 'A3', text: 'an authors table', owner: 1, status: 'open' },
    ],
    chosen: 0,
    cuts: [
      {
        seam: 'domain',
        higherRungs: [],
        relation: 'layers',
        state: 'complete',
        deferred: [],
        pieces: [
          { kind: 'author', title: '[t] posts', body, points: 2, role: 'work', criteria: ['A1', 'A2'], dependsOn: [], order: 1, orderRung: 'source-of-truth' },
          { kind: 'author', title: '[t] authors', body, points: 2, role: 'work', criteria: ['A3'], dependsOn: [0], order: 2, orderRung: 'dependency' },
        ],
        groundwork: [],
        width: null,
        balance: 'two and one',
        independence: 'authors reads nothing from posts',
      },
    ],
    ...partial,
  };
}
function confirmation(issue: number, mode: 'carve' | 'revisit', finding: Confirmation['finding'], agree: boolean): Confirmation {
  return { issue, mode, agree, finding, seam: 'agree', seamCase: '', reason: agree ? 'yes' : 'no: A3 unowned' };
}

function trunk(): FakeTracker {
  return new FakeTracker(BOT, [fakeIssue(10, { title: '[t] big', body: 'Criteria: A1 A2 A3', labels: [{ name: 'size: 8' }] })]);
}
const issue10 = { number: 10, title: '[t] big', createdAt: '2026-09-01T00:00:00Z', labels: [{ name: 'size: 8' }] };
const records = (io: FakeTracker, n: number) => io.view(n)!.comments.filter((c) => c.body.startsWith('<!-- carve-record')).map((c) => /state=(\w+)/.exec(c.body)?.[1]);
const labels = (io: FakeTracker, n: number) => io.view(n)!.labels.map((l) => l.name).sort();

describe('carveIssue', () => {
  test('a full carve: children in delivery order, an edge, no size labels, applying then live, labels, claim released', async () => {
    const io = trunk();
    const ctx = ctxFor(io);
    const out = await carveIssue(ctx, issue10, knobs(fixture('carve', carving(10)), fixture('cover', confirmation(10, 'carve', 'cover', true))), io);
    expect(out.outcome).toBe('carve');
    expect(out.generation).toBe(1);
    const t = readTree(ctx, 10, io);
    expect(t.children.map((c) => c.title)).toEqual(['[t] posts', '[t] authors']);
    expect(t.children[1].blockedBy?.nodes.map((b) => b.number)).toEqual([t.children[0].number]);
    expect(t.children.every((c) => !c.labels.some((l) => l.name.startsWith('size:')))).toBe(true);
    expect(t.children[0].body.startsWith('<!-- carve parent=10 gen=1 piece=0 -->')).toBe(true);
    expect(records(io, 10)).toEqual(['applying', 'live']);
    expect(labels(io, 10)).toEqual(['loop/carve-gen: 1', 'loop/carved', 'size: 8']);
    expect(t.claims.every((c) => c.released)).toBe(true);
    expect(t.record?.children.map((c) => c.number)).toEqual(t.children.map((c) => c.number));
  });

  test('a dispute to the round cap hands off with every open leaf paused and no child created', async () => {
    const io = new FakeTracker(BOT, [fakeIssue(10, { title: '[t] big', labels: [{ name: 'size: 8' }], subIssues: [11] }), fakeIssue(11, { parentNumber: 10, title: 'leaf' })]);
    const ctx = ctxFor(io);
    const out = await carveIssue(ctx, issue10, knobs(fixture('carve', carving(10)), fixture('gap', confirmation(10, 'carve', 'gap', false))), io);
    expect(out.outcome).toBe('indivisible');
    expect(out.reason).toMatch(/disagreed 5 times/);
    expect(labels(io, 10)).toContain('needs-human');
    expect(io.view(10)!.subIssues).toEqual([11]);
    expect(labels(io, 11)).toContain('loop/paused');
    expect(io.view(11)!.comments.some((c) => c.body.includes('carve-pause by=10'))).toBe(true);
    expect(records(io, 10)).toEqual(['live']);
    expect(io.view(10)!.comments.filter((c) => c.body.startsWith('<!-- carve-handoff')).length).toBe(1);
  });

  test('a crash after the first child is finished by the next run without a duplicate', async () => {
    const io = trunk();
    const ctx = ctxFor(io);
    let creates = 0;
    io.beforeWrite = (op) => {
      if (op.argv[2] === 'create' && ++creates === 2) throw new Error('boom');
    };
    const k = knobs(fixture('carve', carving(10)), fixture('cover', confirmation(10, 'carve', 'cover', true)));
    await expect(carveIssue(ctx, issue10, k, io)).rejects.toThrow('boom');
    expect(records(io, 10)).toEqual(['applying']);
    expect(labels(io, 10)).toContain('loop/carving');
    io.beforeWrite = null;
    const again = await carveIssue(ctxFor(io, 'host-2-2'), issue10, k, io);
    expect(again.outcome).toBe('resumed');
    const t = readTree(ctx, 10, io);
    expect(t.children.map((c) => c.title)).toEqual(['[t] posts', '[t] authors']);
    expect(records(io, 10)).toEqual(['applying', 'live']);
    expect(labels(io, 10)).not.toContain('loop/carving');
  });

  test('a second runner on a claimed trunk returns busy', async () => {
    const io = trunk();
    io.comment(10, BOT, '<!-- carve-claim kind=carving run=other-host-7-7 at=2026-09-03T12:00:00Z expires=2999-01-01T00:00:00Z -->');
    const out = await carveIssue(ctxFor(io), issue10, knobs(fixture('carve', carving(10)), fixture('cover', confirmation(10, 'carve', 'cover', true))), io);
    expect(out.outcome).toBe('busy');
  });

  async function carved(): Promise<{ io: FakeTracker; ctx: Context; children: number[] }> {
    const io = trunk();
    const ctx = ctxFor(io);
    const out = await carveIssue(ctx, issue10, knobs(fixture('carve', carving(10)), fixture('cover', confirmation(10, 'carve', 'cover', true))), io);
    return { io, ctx, children: out.children ?? [] };
  }
  const revisit = (issue: number, verdict: Carving['verdict'], partial: Partial<Carving> = {}): Carving => ({ ...carving(issue), mode: 'revisit', verdict, cuts: undefined, chosen: undefined, ...partial });

  test('still-good after a leaf closes: a roll of the ledger and revisits 1', async () => {
    const { io, ctx, children } = await carved();
    io.close(children[0]);
    const ledger = carving(10).ledger.map((r) => (r.owner === 0 ? { ...r, status: 'completed' as const } : r));
    const out = await carveIssue(ctx, issue10, knobs(fixture('sg', revisit(10, 'still-good', { ledger })), fixture('yes', confirmation(10, 'revisit', 'still-good', true))), io);
    expect(out.outcome).toBe('still-good');
    const r = readTree(ctx, 10, io).record as Record;
    expect(r.revisits).toBe(1);
    expect(r.ledger.filter((l) => l.status === 'completed').map((l) => l.id)).toEqual(['A1', 'A2']);
    expect(records(io, 10)).toEqual(['applying', 'live', 'live']);
  });

  test('a question pauses exactly the owner of the affected criterion; removing the hold redrives into a new epoch', async () => {
    const { io, ctx, children } = await carved();
    const out = await carveIssue(ctx, issue10, knobs(fixture('tu', revisit(10, 'too-uncertain', { affected: ['A3'] })), fixture('ho', confirmation(10, 'revisit', 'hand-off-agree', true))), io);
    expect(out.outcome).toBe('too-uncertain');
    expect(labels(io, 10)).toContain('needs-decision');
    expect(labels(io, children[1])).toContain('loop/paused');
    expect(labels(io, children[0])).not.toContain('loop/paused');
    // A revisit while held only snapshots (already recorded) and leaves it.
    const held = await carveIssue(ctx, issue10, knobs(fixture('sg', revisit(10, 'still-good')), fixture('yes', confirmation(10, 'revisit', 'still-good', true))), io);
    expect(held.outcome).toBe('left-alone');
    io.removeLabel(10, 'needs-decision');
    const redriven = await carveIssue(ctx, issue10, knobs(fixture('sg', revisit(10, 'still-good')), fixture('yes', confirmation(10, 'revisit', 'still-good', true))), io);
    expect(redriven.outcome).toBe('still-good');
    const r = readTree(ctx, 10, io).record as Record;
    expect([r.epoch, r.revisits]).toEqual([2, 0]);
    expect(labels(io, children[1])).not.toContain('loop/paused');
  });

  test('exhausted releases: released record, size and trunk labels off, loop/released on', async () => {
    const { io, ctx, children } = await carved();
    for (const c of children) io.close(c);
    const ledger = carving(10).ledger.map((r) => ({ ...r, status: 'completed' as const }));
    const out = await carveIssue(ctx, issue10, knobs(fixture('ex', revisit(10, 'exhausted', { ledger })), fixture('yes', confirmation(10, 'revisit', 'exhausted', true))), io);
    expect(out.outcome).toBe('exhausted');
    expect(labels(io, 10)).toEqual(['loop/released']);
    expect(records(io, 10)).toEqual(['applying', 'live', 'released']);
    // A later visit while released: carve mode, but nothing over the ceiling and no open child.
    const later = await carveIssue(ctx, issue10, knobs(fixture('ex', revisit(10, 'exhausted', { ledger })), fixture('yes', confirmation(10, 'revisit', 'exhausted', true))), io);
    expect(later.outcome).toBe('left-alone');
  });

  test('a dry run with fixture seats lands nothing and logs every write', async () => {
    const io = trunk();
    const ctx = { ...ctxFor(io), dryRun: true } as Context;
    const out = await carveIssue(ctx, issue10, knobs(fixture('carve', carving(10)), fixture('cover', confirmation(10, 'carve', 'cover', true))), io);
    expect(out.outcome).toBe('carve');
    expect(io.writes).toEqual([]);
    expect(io.view(10)!.subIssues).toEqual([]);
    expect(ctx.dryRunLog.some((l) => l.includes('create child'))).toBe(true);
    expect(ctx.dryRunLog.some((l) => l.includes('post the live record'))).toBe(true);
  });
});

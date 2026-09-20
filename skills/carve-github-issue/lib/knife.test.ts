import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Context, createContext } from '../../fix-github-issue/lib/context.ts';
import type { ProjectConfig } from '../../fix-github-issue/lib/config.ts';
import { CARVE_DEFAULTS, type CarveKnobs, type Carving, type Confirmation } from './carve.ts';
import { FakeTracker, fakeIssue } from './fake-tracker.ts';
import { type ClaimHandle, keepClaimed, leaseLost } from './claims.ts';
import { carveIssue } from './knife.ts';
import { renderRecord, type Record } from './record.ts';
import { readTree } from './tree.ts';
import { Carving as CarvingDriver } from '../../burn-down-github-issues/lib/carving.ts';
import { laneState, successors } from '../../burn-down-github-issues/lib/simulate.ts';
import { runAgent } from '../../fix-github-issue/lib/agent.ts';

const BOT = 'loop-bot';
const HERE = import.meta.dir;
let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'knife-'));
});

describe('the carving driver makes only moves the chart allows', () => {
  function makeDriver(ctx: Context, k: CarveKnobs, lanes: string[], appraiser?: string, confirmer?: string) {
    ctx.onLane = e => lanes.push(e.lane);
    return new CarvingDriver({ ctx, knobs: k, appraisal: { seats: { appraiser: { engine: 'fixture', model: appraiser }, confirmer: { engine: 'fixture2', model: confirmer } }, confirmCloses: true, skipLabels: ['needs-human', 'needs-decision', 'loop/skip', 'loop/parked'], maxAppraiseAttempts: 3, sizeCallbackTimeoutMinutes: 1 }, only: null, ageDays: 100, mark: (_n, _t, lane) => lanes.push(lane), log: () => {} });
  }
  function illegal(lanes: string[]) {
    return lanes.slice(1).flatMap((to, i) => lanes[i] === to || successors(laneState(lanes[i]), { ownEventsOnly: true }).has(laneState(to)) ? [] : [`${lanes[i]}->${to}`]);
  }
  for (const failure of ['carver', 'confirmer', 'setup', 'spawn'] as const) {
    test(`first carving ${failure} failure follows chart edges`, async () => {
      const io = trunk(); const ctx = ctxFor(io); const lanes = ['C1'];
      const k = knobs(fixture('carver', failure === 'carver' ? {} : carving(10)), fixture('confirmer', failure === 'confirmer' ? {} : confirmation(10, 'carve', 'cover', true)));
      if (failure === 'setup') ctx.promptsDirs = [];
      if (failure === 'spawn') io.beforeWrite = op => { if (op.argv[2] === 'create' && op.argv[1] === 'issue') throw new Error('create unavailable'); };
      const d = makeDriver(ctx, k, lanes);
      if (failure === 'setup' || failure === 'spawn') await expect(d.revisit(10, 'first carve')).rejects.toThrow();
      else await d.revisit(10, 'first carve');
      
      expect(illegal(lanes)).toEqual([]);
    });
  }
  for (const points of [1, 8]) {
    test(`release resumed after size ${points} was written follows chart edges`, async () => {
      const io = new FakeTracker(BOT, [fakeIssue(10, { labels: [{ name: 'loop/released' }, { name: `size: ${points}` }] })]);
      const ctx = ctxFor(io); const lanes = ['C7'];
      const k = knobs(fixture('carve', carving(10)), fixture('cover', confirmation(10, 'carve', 'cover', true)));
      await makeDriver(ctx, k, lanes).releaseAppraisal(10);
      
      expect(illegal(lanes)).toEqual([]);
    });
  }
  test('a release appraisal that fails after its lease was lost counts nothing', async () => {
    const released = () => new FakeTracker(BOT, [fakeIssue(10, { labels: [{ name: 'loop/released' }] })]);
    const k = knobs(fixture('carve', carving(10)), fixture('cover', confirmation(10, 'carve', 'cover', true)));
    const counted = (io: FakeTracker) => io.view(10)!.labels.some((l) => l.name.startsWith('loop/appraisals'));
    const lost = released(); const ctx = ctxFor(lost);
    ctx.log = (m) => {
      if (!/running appraiser/.test(m) || leaseLost(ctx, 10)) return;
      const handle: ClaimHandle = { kind: 'carving', commentId: 1, label: 'loop/carving', issue: 10, key: 'o/r#10', expires: () => 0, renew: () => { throw new Error('tracker down'); }, release: () => {} };
      keepClaimed(handle, undefined, () => 0, (fn) => (fn(), () => {}));
    };
    await makeDriver(ctx, k, ['C7'], fixture('bad-appraisal', {})).releaseAppraisal(10);
    expect(counted(lost)).toBe(false);
    // With the lease held, the same unusable appraisal is counted.
    const held = released();
    await makeDriver(ctxFor(held), k, ['C7'], fixture('bad-appraisal', {})).releaseAppraisal(10);
    expect(counted(held)).toBe(true);
  });
  test('a trunk with open children but no record enters its first carving along a chart edge', async () => {
    const io = new FakeTracker(BOT, [fakeIssue(10, { subIssues: [11] }), fakeIssue(11, { parentNumber: 10 })]);
    const ctx = ctxFor(io); const lanes = ['C5'];
    await makeDriver(ctx, knobs(fixture('bad', {}), fixture('bad2', {})), lanes).revisit(10, 'open child, no record');
    expect(illegal(lanes)).toEqual([]);
  });
  test('a resumed release with the new carving already recorded has a chart edge', async () => {
    const io = trunk(); const ctx = ctxFor(io);
    const k = knobs(fixture('carve', carving(10)), fixture('cover', confirmation(10, 'carve', 'cover', true)));
    await carveIssue(ctx, issue10, k, io);
    io.addLabel(10, 'loop/released');
    const lanes = ['C7']; await makeDriver(ctx, k, lanes).releaseAppraisal(10);
    expect(illegal(lanes)).toEqual([]);
  });
  test('lifting a carve dead letter reaches Revisiting along a chart edge', async () => {
    const io = trunk(); const ctx = ctxFor(io);
    await carveIssue(ctx, issue10, knobs(fixture('carve', carving(10)), fixture('cover', confirmation(10, 'carve', 'cover', true))), io);
    const answer = { ...carving(10), mode: 'revisit', verdict: 'still-good', cuts: undefined, chosen: undefined };
    const k = knobs(fixture('still-good', answer), fixture('agree', confirmation(10, 'revisit', 'still-good', true)), { maxRevisitsPerGeneration: 0 });
    expect((await carveIssue(ctx, issue10, k, io)).outcome).toBe('dlq');
    io.removeLabel(10, 'loop/dlq: carve');
    const lanes = ['Q2']; await makeDriver(ctx, k, lanes).revisit(10, 'person lifted carve DLQ');
    expect(readTree(ctx, 10, io).record!.epoch).toBe(2);
    expect(illegal(lanes)).toEqual([]);
  });
  test('an oversized release whose confirmer fails follows chart edges', async () => {
    const io = new FakeTracker(BOT, [fakeIssue(10, { labels: [{ name: 'loop/released' }, { name: 'size: 8' }] })]);
    const lanes = ['C7']; const ctx = ctxFor(io);
    await makeDriver(ctx, knobs(fixture('carve', carving(10)), fixture('invalid-confirmation', {})), lanes).releaseAppraisal(10);
    
    expect(illegal(lanes)).toEqual([]);
  });
  test('an interrupted applying record resumes in its own lane', async () => {
    const io = trunk(); const ctx = ctxFor(io);
    const k = knobs(fixture('carve', carving(10)), fixture('cover', confirmation(10, 'carve', 'cover', true)));
    io.beforeWrite = op => { if (op.argv[1] === 'issue' && op.argv[2] === 'create') throw new Error('interrupted'); };
    await expect(carveIssue(ctx, issue10, k, io)).rejects.toThrow();
    io.beforeWrite = null;
    const lanes = ['C4']; await makeDriver(ctx, k, lanes).revisit(10, 'finish applying');
    
    expect(illegal(lanes)).toEqual([]);
  });
  for (const oldSizeStillPresent of [true, false]) test(`interrupted release retains its outcome (old size present: ${oldSizeStillPresent})`, async () => {
    const io = trunk(); const ctx = ctxFor(io);
    const k = knobs(fixture('carve', carving(10)), fixture('cover', confirmation(10, 'carve', 'cover', true)));
    await carveIssue(ctx, issue10, k, io);
    for (const child of io.view(10)!.subIssues) io.close(child);
    const record = readTree(ctx, 10, io).record!;
    io.comment(10, BOT, renderRecord({ ...record, state: 'released', verdict: 'exhausted' }));
    if (!oldSizeStillPresent) io.removeLabel(10, 'size: 8');
    const lanes = ['C7'];
    await makeDriver(ctx, k, lanes, fixture('remainder', { issue: 10, verdict: 'valid', points: 1, reason: 'small remainder' })).revisit(10, 'finish release');
    
    expect(lanes.at(-1)).toBe('B1');
    expect(labels(io, 10)).not.toContain('loop/released');
  });
  for (const when of ['appraising', 'confirming'] as const) {
    test(`release appraisal reconciles a hold added while ${when}`, async () => {
      const io = new FakeTracker(BOT, [fakeIssue(10, { labels: [{ name: 'loop/released' }] })]);
      const ctx = ctxFor(io); const lanes = ['C7'];
      const k = knobs('', '');
      const d = makeDriver(ctx, k, lanes, fixture('appraisal', { issue: 10, verdict: 'obsolete', reason: 'no longer needed' }), fixture('close', { issue: 10, agree: true, reason: 'agreed' }));
      if (when === 'appraising') {
        // A person posts the hold after the preflight read and before the verdict is applied.
        const original = io.view.bind(io); let reads = 0;
        io.view = n => { if (n === 10 && ++reads === 5) io.addLabel(10, 'needs-human'); return original(n); };
      } else ctx.onLane = e => { lanes.push(e.lane); if (e.lane === 'A3') io.addLabel(10, 'needs-human'); };
      await d.releaseAppraisal(10);
      expect(io.view(10)!.state).toBe('OPEN');
      expect(labels(io, 10)).toContain('needs-human');
      
      expect(lanes.at(-1)).toBe('H2');
    });
  }
  test('the fixture engine supports the reproof seat used by resumes', async () => {
    const ctx = ctxFor(trunk());
    const result = await runAgent(ctx, 'worker-reprove', 10, join(scratch, 'reproof'), { engine: 'fixture', model: fixture('fixed', { issue: 10, verdict: 'fixed', pr: 7, reason: 'proved' }) }, 'reprove');
    expect(result.exitCode).toBe(0);
  });
  test('an applying record cannot hide a human hold and foreign claim on the board', async () => {
    const io = trunk(); const ctx = ctxFor(io);
    const k = knobs(fixture('carve', carving(10)), fixture('cover', confirmation(10, 'carve', 'cover', true)));
    io.beforeWrite = op => { if (op.argv[1] === 'issue' && op.argv[2] === 'create') throw new Error('interrupted'); };
    await expect(carveIssue(ctx, issue10, k, io)).rejects.toThrow();
    io.beforeWrite = null;
    io.addLabel(10, 'needs-human');
    io.comment(10, BOT, '<!-- carve-claim kind=carving run=other-host-2-2 at=2026-01-01T00:00:00Z expires=2999-01-01T00:00:00Z -->');
    const lanes: string[] = [];
    await makeDriver(ctx, k, lanes).revisit(10, 'busy held trunk');
    expect(labels(io, 10)).toContain('needs-human');
    expect(labels(io, 10)).toContain('loop/carving');
    expect(lanes.at(-1)).toBe('H2');
  });
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
  test('a knife that loses its lease mid-carve stops writing, counts nothing, and resumes on the next visit', async () => {
    const io = trunk();
    const ctx = ctxFor(io);
    const k = knobs(fixture('carve', carving(10)), fixture('cover', confirmation(10, 'carve', 'cover', true)));
    // The lease is lost the way it is in a run: a renewal fails with the expiry already past. The
    // first child is being created when it happens, so that write lands and the next one must not.
    const loseLease = () => {
      const handle: ClaimHandle = { kind: 'carving', commentId: 1, label: 'loop/carving', issue: 10, key: 'o/r#10', expires: () => 0, renew: () => { throw new Error('tracker down'); }, release: () => {} };
      keepClaimed(handle, undefined, () => 0, (fn) => (fn(), () => {}));
    };
    io.beforeWrite = (op) => {
      if (op.argv[1] === 'issue' && op.argv[2] === 'create' && !leaseLost(ctx, 10)) loseLease();
    };
    const out = await carveIssue(ctx, issue10, k, io);
    expect(out).toMatchObject({ outcome: 'busy', reason: expect.stringMatching(/lost its lease/) });
    const written = io.writes.length;
    expect(io.view(10)!.subIssues).toHaveLength(1);
    expect(labels(io, 10).some((l) => l.startsWith('loop/carves'))).toBe(false);
    expect(records(io, 10)).toEqual(['applying']);

    // The announced generation is finished by the next visit, whose fresh claim clears the loss.
    io.beforeWrite = null;
    const again = await carveIssue(ctx, issue10, k, io);
    expect(again.outcome).toBe('resumed');
    expect(io.writes.length).toBeGreaterThan(written);
    expect(io.view(10)!.subIssues).toHaveLength(2);
    expect(records(io, 10)).toEqual(['applying', 'live']);
  });
  test('a carver that fails after the lease was lost is not counted: the count is a write too', async () => {
    const io = trunk();
    const ctx = ctxFor(io);
    const k = knobs(fixture('carve', {}), fixture('cover', confirmation(10, 'carve', 'cover', true)));
    // Lost while the carver runs, which then hands back an answer the knife cannot use.
    ctx.log = (m) => {
      if (!/running carver/.test(m) || leaseLost(ctx, 10)) return;
      const handle: ClaimHandle = { kind: 'carving', commentId: 1, label: 'loop/carving', issue: 10, key: 'o/r#10', expires: () => 0, renew: () => { throw new Error('tracker down'); }, release: () => {} };
      keepClaimed(handle, undefined, () => 0, (fn) => (fn(), () => {}));
    };
    const out = await carveIssue(ctx, issue10, k, io);
    expect(out.outcome).toBe('busy');
    expect(labels(io, 10).some((l) => l.startsWith('loop/carves'))).toBe(false);
    // With the lease held, the same failed turn is counted.
    ctx.log = () => {};
    expect((await carveIssue(ctx, issue10, k, io)).outcome).toBe('failed');
    expect(labels(io, 10)).toContain('loop/carves: 1');
  });
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

  test('the knife moves its own card: Carving, Confirming cut, Spawning children, in that order', async () => {
    const io = trunk();
    const ctx = ctxFor(io);
    const lanes: string[] = [];
    ctx.onLane = (event) => {
      lanes.push(event.lane);
    };
    await carveIssue(ctx, issue10, knobs(fixture('carve', carving(10)), fixture('cover', confirmation(10, 'carve', 'cover', true))), io);
    expect(lanes).toEqual(['C2', 'C3', 'C4']);
  });

  test('a dispute to the round cap is a carve dead letter, with every open leaf paused and no child created', async () => {
    const io = new FakeTracker(BOT, [fakeIssue(10, { title: '[t] big', labels: [{ name: 'size: 8' }], subIssues: [11] }), fakeIssue(11, { parentNumber: 10, title: 'leaf' })]);
    const ctx = ctxFor(io);
    const out = await carveIssue(ctx, issue10, knobs(fixture('carve', carving(10)), fixture('gap', confirmation(10, 'carve', 'gap', false))), io);
    // Two engines that never agreed is the machine giving up, not an opinion about the issue.
    expect(out.outcome).toBe('dlq');
    expect(out.reason).toMatch(/disagreed 5 times/);
    expect(labels(io, 10)).toContain('loop/dlq: carve');
    expect(labels(io, 10)).not.toContain('needs-human');
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

  test('lifting a carve DLQ at the revisit cap starts a fresh epoch', async () => {
    const { io, ctx } = await carved();
    const k = knobs(fixture('sg', revisit(10, 'still-good')), fixture('yes', confirmation(10, 'revisit', 'still-good', true)), { maxRevisitsPerGeneration: 0 });
    const capped = await carveIssue(ctx, issue10, k, io);
    expect(capped.outcome).toBe('dlq');
    expect(readTree(ctx, 10, io).record!.seen.holds).toContain('loop/dlq: carve');
    io.removeLabel(10, 'loop/dlq: carve');
    const resumed = await carveIssue(ctx, issue10, k, io);
    expect(resumed.outcome).toBe('still-good');
    expect(readTree(ctx, 10, io).record!.epoch).toBe(2);
    expect(readTree(ctx, 10, io).record!.revisits).toBe(0);
  });

  test('a confirmed indivisible opinion follows legal board edges', async () => {
    const io = trunk(); const ctx = ctxFor(io); const lanes: string[] = [];
    ctx.onLane = e => lanes.push(e.lane);
    const k = knobs(fixture('indivisible', carving(10, { verdict: 'indivisible', cuts: undefined, chosen: undefined, affected: [] })), fixture('agree', confirmation(10, 'carve', 'hand-off-agree', true)));
    const d = new CarvingDriver({ ctx, knobs: k, appraisal: { seats: { appraiser: { engine: 'fixture' }, confirmer: { engine: 'fixture2' } }, confirmCloses: true, skipLabels: [], maxAppraiseAttempts: 3, sizeCallbackTimeoutMinutes: 1 }, only: null, ageDays: 100, mark: (_n, _t, l) => lanes.push(l), log: () => {} });
    await d.revisit(10, 'first carving');
    expect(lanes.at(-1)).toBe('H2');
    const illegal = lanes.slice(1).flatMap((to, index) => {
      const from = lanes[index];
      return from === to || successors(laneState(from), { ownEventsOnly: true }).has(laneState(to)) ? [] : [`${from}->${to}`];
    });
    expect(illegal).toEqual([]);
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

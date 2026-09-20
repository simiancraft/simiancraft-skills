import '../../../test/no-real-gh.preload.ts';
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Card, fire, laneKey, laneState, successors } from './simulate.ts';
import { Carving, type CarvingDeps } from './carving.ts';
import { LANES } from './lanes.ts';
import { awaitGreenChecks } from '../../fix-github-issue/lib/pipeline.ts';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import { CLAIM_READBACK, claim } from '../../carve-github-issue/lib/claims.ts';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import { readTree } from '../../carve-github-issue/lib/tree.ts';
import { CARVE_DEFAULTS } from '../../carve-github-issue/lib/carve.ts';
import { placeByFacts } from './board-writer.ts';

const scratch = mkdtempSync(join(tmpdir(), 'pressure-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const bot = 'loop-bot';
const noop = () => {};
function context(io: FakeTracker): Context {
  return {
    botLogin: bot, runId: 'review-host-1-1', dryRun: false, dryRunLog: [], io,
    repoRoot: scratch, invokeRoot: scratch, runDir: join(scratch, 'runs'), promptsDirs: [],
    project: { repo: 'o/r', baseBranch: 'main', remote: 'origin', worktreeRoot: '../wt' },
    knobs: { checks: 'auto', checksTimeoutMinutes: 10, maxWorkerAttempts: 3, pointScale: [1, 2, 3, 5, 8] },
    seats: { worker: { engine: 'fixture' }, reviewer: { engine: 'fixture2' } }, log: noop, step: noop,
  } as unknown as Context;
}
function driver(io: FakeTracker, lanes: string[], overrides: Partial<CarvingDeps['knobs']> = {}) {
  const ctx = context(io);
  ctx.onLane = e => lanes.push(e.lane);
  return new Carving({ ctx, knobs: { ...CARVE_DEFAULTS, ceiling: 2, callbacksDir: join(scratch, 'absent'), seats: { carver: { engine: 'fixture' }, confirmer: { engine: 'fixture2' } }, ...overrides }, appraisal: { seats: { appraiser: { engine: 'fixture' }, confirmer: { engine: 'fixture2' } }, confirmCloses: true, skipLabels: [], maxAppraiseAttempts: 1, sizeCallbackTimeoutMinutes: 1 }, only: null, ageDays: 100, mark: (_n, _t, lane) => lanes.push(lane), log: noop });
}

// All facts below come from this card's branch, tracker, counters, and check observations.
class World {
  base: string[][] = [];
  head = 0;
  pr: 'none' | 'ready' | 'draft' = 'ready';
  verdict: 'none' | 'merge' | 'reject' = 'none';
  result = 'fixed';
  workerClose = false;
  check = 'green';
  smokeExit = 0;
  hold = '';
  attempts = 0;
  refreshes = 0;
  redrives = 0;
  decision = '';
  resuming = false;
  incoming() { return this.base.slice(this.head).flat(); }
  facts = (g: string): boolean => {
    switch (g) {
      case 'behindBase': return this.head < this.base.length;
      case 'resuming': return this.resuming;
      case 'prExists': return this.pr !== 'none';
      case 'noOpenPr': return this.pr === 'none';
      case 'draftPr': return this.pr === 'draft';
      case 'readyPr': return this.pr === 'ready';
      case 'standingVerdictMerge': return this.verdict === 'merge';
      case 'standingVerdictRejection': return this.verdict === 'reject';
      case 'noVerdictYet': return this.verdict === 'none';
      case 'movementOutsideClosure': return !this.incoming().some(f => ['leaf.ts', 'shared.ts', 'bun.lock'].includes(f));
      case 'netChangeIntact': return !this.incoming().includes('leaf.ts');
      case 'refreshesUnderCap': return this.refreshes < 2;
      case 'attemptsUnderCap': return this.attempts < 3;
      case 'reviewRoundsUnderCap': return true;
      case 'redrivesUnderCap': return this.redrives < 3;
      case 'appraisalsUnderCap': return this.attempts < 3;
      case 'closeByWorker': return this.workerClose;
      case 'checksGreen': return this.check === 'green';
      case 'smokePassed': return this.smokeExit === 0;
      case 'smokeConfigured': return true;
      case 'holdIsNeedsHuman': return this.hold === 'needs-human';
      case 'holdIsNeedsDecision': return this.hold === 'needs-decision';
      case 'holdIsParked': return this.hold === 'parked';
      case 'verdictIsClose': return this.result === 'close';
      case 'verdictFixed': return this.result === 'fixed';
      case 'verdictNeedsHuman': return this.result === 'needs-human';
      case 'verdictNeedsDecision': return this.result === 'needs-decision';
      case 'verdictOutOfBandOverCeiling': return this.result === 'out-of-band';
      case 'decisionRetry': return this.decision === 'retry';
      case 'decisionRerunReviewer': return this.decision === 'rerun-reviewer';
      case 'decisionDesignObjection': return this.decision === 'design';
      case 'sizedWithinCeiling': return true;
      default: return false;
    }
  };
}

describe('interpreter combinations', () => {
  for (const initial of ['E1', 'D3']) {
    it(`${initial}: resume conflicts into landing DLQ`, () => {
      const w = new World(); w.base.push(['leaf.ts']);
      const c = new Card('resume', laneState(initial)); c.send('RESUMED', w.facts).send('CONFLICT', w.facts);
      expect(c.lane).toBe('Q5');
    });
    for (const terminal of ['close', 'needs-human', 'needs-decision', 'out-of-band']) {
      it(`${initial}: resumed proof reports ${terminal}`, () => {
        const w = new World(); w.result = terminal;
        const c = new Card('resume', laneState(initial)); c.send('RESUMED', w.facts).send('WORKER_VERDICT', w.facts);
        expect(c.lane).toBe(({ close: 'A3', 'needs-human': 'H2', 'needs-decision': 'H1', 'out-of-band': 'C1' })[terminal]!);
      });
    }
  }
  for (const lane of ['H3', 'Q3', 'Q4', 'Q5']) for (const pr of ['none', 'ready', 'draft'] as const) {
    it(`${lane}: a human redrive with spent refresh budget and ${pr} PR`, () => {
      const w = new World(); w.refreshes = 2; w.pr = pr; w.verdict = 'reject'; w.base.push(['shared.ts']);
      const c = new Card('redrive', laneState(lane)); c.send('REDRIVEN', w.facts);
      if (pr === 'none') expect(c.lane).toBe('B1');
      else { expect(c.lane).toBe('F2'); w.head = w.base.length; c.send('CAUGHT_UP', w.facts); expect(c.lane).toBe('D4'); }
    });
  }
  it('A revokes B approval while B is in Smoke', () => {
    const w = new World(); w.verdict = 'merge';
    const b = new Card('B', laneState('F3')); b.send('CHECKS', w.facts); expect(b.lane).toBe('F4');
    w.base.push(['shared.ts']); b.send('SMOKE', w.facts); expect(b.lane).toBe('F2');
    const old = w.facts('movementOutsideClosure'); w.head = w.base.length;
    // CAUGHT_UP describes the completed merge, including the overlap measured before it.
    b.send('CAUGHT_UP', g => g === 'movementOutsideClosure' ? old : w.facts(g)); expect(b.lane).toBe('E1');
  });
  it('a human hold in F2 makes the later catch-up completion inert', () => {
    const w = new World(); w.hold = 'needs-human'; const c = new Card('held', laneState('F2'));
    c.send('HOLD_ADDED_BY_PERSON', w.facts); expect(c.lane).toBe('H2'); expect(fire(c.state, 'CAUGHT_UP', w.facts)).toBeNull();
  });
  for (const pr of ['none', 'ready'] as const) for (const attempts of [1, 3]) {
    it(`worker close confirmer failure, PR=${pr}, attempts=${attempts}`, () => {
      const w = new World(); w.workerClose = true; w.pr = pr; w.attempts = attempts;
      expect(laneKey(fire(laneState('A3'), 'AGENT_FAILED', w.facts)!.state)).toBe(pr === 'none' && attempts < 3 ? 'B1' : 'Q3');
    });
  }
  it('a failed triage stays stopped, including its entry actions', () => {
    const restarted: string[] = [];
    for (const lane of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']) {
      const c = new Card('triage', laneState(lane)); const w = new World();
      for (let n = 0; n < 3; n++) {
        const r = fire(c.state, 'AGENT_FAILED', w.facts)!; expect(laneKey(r.state)).toBe(lane);
        if (r.actions.slice(r.actions.indexOf('stopTriage') + 1).includes('runTriage')) restarted.push(lane);
        c.state = r.state;
      }
    }
    expect(restarted).toEqual([]);
  });
  it('Q4 automatic retry cannot start a stale revision', () => {
    const w = new World(); w.decision = 'retry'; w.verdict = 'reject'; w.base.push(['shared.ts']);
    expect(fire(laneState('Q4'), 'TRIAGED', w.facts)!.actions).not.toContain('runWorkerRevision');
  });
  it('the original unrestricted stale-Merging predicate still finds no entry in this chart', () => {
    const w = new World(); w.base.push(['shared.ts']);
    for (const l of LANES) for (const event of ['CHECKS', 'SMOKE', 'FRONT_OF_QUEUE', 'TRIAGED', 'RESUMED', 'REDRIVEN']) {
      const r = fire(l.state, event, w.facts); if (r) expect(laneKey(r.state)).not.toBe('F5');
    }
  });
});

describe('tracker and checks pressure', () => {
  it('checks registering after the grace period still must be observed', async () => {
    let clock = 0; const ctx = context(new FakeTracker(bot));
    const io = { now: () => clock, sleep: async (ms: number) => { clock += ms; }, read: () => JSON.stringify({ headRefOid: 'h', statusCheckRollup: clock >= 120_000 ? [{ name: 'ci', conclusion: 'FAILURE' }] : [] }) };
    const result = await awaitGreenChecks(ctx, 1, noop, { sha: 'h' }, io);
    console.log(`late CI: result=${result}, elapsed=${clock}`); expect(result).not.toBeNull();
  });
  it('one fast green check cannot conceal a second scheduled check', async () => {
    let clock = 0; const ctx = context(new FakeTracker(bot)); ctx.knobs.checks = 'required';
    const scheduled = [{ name: 'lint', conclusion: 'SUCCESS' }, { name: 'integration', conclusion: 'FAILURE' }];
    const io = { now: () => clock, sleep: async (ms: number) => { clock += ms; }, read: () => JSON.stringify({ headRefOid: 'h', statusCheckRollup: clock >= 30_000 ? scheduled : scheduled.slice(0, 1) }) };
    expect(await awaitGreenChecks(ctx, 1, noop, { sha: 'h' }, io)).not.toBeNull();
  });
  it('auto registration wait respects the configured timeout', async () => {
    let clock = 0; const ctx = context(new FakeTracker(bot)); ctx.knobs.checksTimeoutMinutes = 0.5;
    const io = { now: () => clock, sleep: async (ms: number) => { clock += ms; }, read: () => JSON.stringify({ headRefOid: 'h', statusCheckRollup: [] }) };
    await awaitGreenChecks(ctx, 1, noop, { sha: 'h' }, io); expect(clock).toBeLessThanOrEqual(30_000);
  });
  it('legacy foreign claims block acquisition; renewals preserve the acquisition token', async () => {
    const io = new FakeTracker(bot, [fakeIssue(1)]); const ctx = context(io);
    io.comment(1, bot, '<!-- carve-claim kind=working run=foreign-host-7-7 at=2026-01-01T00:00:00Z expires=2999-01-01T00:00:00Z -->');
    expect(await claim(ctx, io, 1, 'working')).toBe('busy');
    io.comment(1, bot, '<!-- carve-unclaim kind=working run=foreign-host-7-7 -->');
    const h = await claim(ctx, io, 1, 'working'); if (h === 'busy') throw new Error('claim should win');
    const token = readTree(ctx, 1, io).claims.find(c => c.commentId === h.commentId)!.token;
    h.renew(); expect(readTree(ctx, 1, io).claims.find(c => c.commentId === h.commentId)!.token).toBe(token); expect(token).not.toBeNull(); h.release();
  });
  function interrupted() {
    const io = new FakeTracker(bot, [fakeIssue(10, { labels: [{ name: 'size: 8' }], subIssues: [11] }), fakeIssue(11, { parentNumber: 10 })]);
    io.comment(10, bot, '<!-- carve-handoff verdict=indivisible gen=0 -->\n```json\n' + JSON.stringify({ verdict: 'indivisible', deadLetter: true, reason: 'disagreement cap', affected: [], pauseSet: [11], opinions: [] }) + '\n```');
    return io;
  }
  it('an interrupted carve DLQ returns to Q2 on the board', async () => {
    const io = interrupted(); const lanes: string[] = []; await driver(io, lanes).revisit(10, 'resume interrupted hand-off');
    expect(io.view(10)!.labels.map(l => l.name)).toContain('loop/dlq: carve'); expect(lanes.at(-1)).toBe('Q2');
  });
  it('an interrupted carve DLQ preserves its announced pause set', async () => {
    const io = interrupted(); await driver(io, []).revisit(10, 'resume interrupted hand-off');
    expect(io.view(11)!.labels.map(l => l.name)).toContain('loop/paused');
  });
  it('a released trunk appraisal throw is counted and settled at the cap', async () => {
    const io = new FakeTracker(bot, [fakeIssue(10, { labels: [{ name: 'loop/released' }] })]); const lanes: string[] = [];
    // An absent prompt is a real setup failure, before any fixture process is started.
    await expect(driver(io, lanes).releaseAppraisal(10)).rejects.toThrow();
    expect(io.view(10)!.labels.map(l => l.name)).toContain('loop/dlq: appraisal'); expect(lanes.at(-1)).toBe('Q1');
  });
});

// Actual private functions are evaluated in memory with explicit fake dependencies. No import
// of loop.ts, subprocess, source edit, or live tracker is involved.
function loadFunctions(path: string, names: string[], deps: Record<string, unknown>, prefix = ''): any {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const parts = names.map(name => {
    const match = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm').exec(source);
    if (!match) throw new Error(`missing ${name}`);
    return source.slice(match.index, source.indexOf('\n}', match.index) + 2).replace(/^export /, '');
  });
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(prefix + parts.join('\n'));
  return new Function(...Object.keys(deps), `${js}\nreturn {${names.join(',')}};`)(...Object.values(deps));
}
describe('private failure routing, loaded in memory', () => {
  it('an unreadable objection is unknown, not evidence that nobody objected', () => {
    const api = loadFunctions('../loop.ts', ['lastObjection'], { ctx: { botLogin: bot }, sh: () => { throw new Error('tracker unavailable'); } });
    expect(() => api.lastObjection(1)).toThrow();
  });
  it('placement from tracker honors a live foreign claim', () => {
    const io = new FakeTracker(bot, [fakeIssue(1, { labels: [{ name: 'size: 1' }] })]); const ctx = context(io);
    io.comment(1, bot, '<!-- carve-claim kind=working run=foreign-host-7-7 at=2026-01-01T00:00:00Z expires=2999-01-01T00:00:00Z -->');
    const placements: string[] = [];
    const api = loadFunctions('../loop.ts', ['placeFromTracker'], { DRY_RUN: false, ctx, trackerIo: () => io, readTree, placeByFacts, pullsNaming: () => [], pointsFromLabels: () => 1, MAX_POINTS: 2, place: (_n: unknown, _t: unknown, l: string) => placements.push(l), log: noop });
    api.placeFromTracker(1, 'issue', 'claim appeared'); expect(placements).toEqual(['W3']);
  });
  it('lastLane cannot mix the same issue number across repository contexts', () => {
    const routes: string[] = [];
    const api = loadFunctions('../../fix-github-issue/lib/pipeline.ts', ['phaseOfLane', 'move', 'recordThrow'], {
      deadLetter: (_ctx: unknown, _issue: unknown, phase: string) => { routes.push(phase); return { outcome: 'dlq' }; },
      openPullFor: () => 7, countFailure: () => { throw new Error('unexpected counter'); },
    }, 'const lastLane = new Map();\nconst laneKeyOf = (ctx, issue) => `${ctx.project?.repo ?? ""}#${issue}`;\n');
    const a = { project: { repo: 'a/r' } }; const b = { project: { repo: 'b/r' } }; const issue = { number: 1 };
    api.move(a, issue, 'F3'); api.move(b, issue, 'E2'); api.recordThrow(a, issue, new Error('checks read'), noop, 7);
    expect(routes).toEqual(['landing']);
  });
  it('a worker that crashes after opening a PR cannot be returned to Ready', async () => {
    const remote = { pr: 7 }; let actual: string | undefined;
    const api = loadFunctions('../../fix-github-issue/lib/pipeline.ts', ['workIssue'], {
      runWorker: async () => ({ verdict: 'failed', reason: 'process exited 1' }),
      countFailure: (_ctx: unknown, _issue: unknown, _reason: unknown, _say: unknown, pr?: number) => { actual = pr ? 'Q3' : 'B1'; return { outcome: 'failed' }; },
      openPullFor: () => remote.pr,
    });
    await api.workIssue({}, { number: 1 }, '/fake', 2, 2, noop); expect(actual).toBe('Q3');
  });
  it('dirty ready-for-review work has an enabled chart route to its runtime DLQ', async () => {
    const api = loadFunctions('../../fix-github-issue/lib/pipeline.ts', ['review'], { isDraft: () => false, dirtyPaths: () => ['uncommitted.ts'] });
    const result = await api.review({}, { number: 1 }, 7, '/fake', noop, 1); expect(result.dlq).toBe('work');
    expect(successors(laneState('E1'), { ownEventsOnly: true }).has(laneState('Q3'))).toBe(true);
  });
});

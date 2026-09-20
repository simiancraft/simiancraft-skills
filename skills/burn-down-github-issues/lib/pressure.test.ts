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
    knobs: { checks: 'required', checksTimeoutMinutes: 10, maxWorkerAttempts: 3, pointScale: [1, 2, 3, 5, 8] },
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
    expect(() => api.lastObjection(1, 7)).toThrow();
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
    }, 'const lastLane = new Map();\n' + readFileSync(new URL('../../fix-github-issue/lib/pipeline.ts', import.meta.url), 'utf8').match(/^const laneKeyOf = .*;$/m)![0] + '\n');
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

describe('incomplete observations are not permission', () => {
  for (const suites of ['unreadable', 'zero-runs', 'late-suite'] as const) {
    it(`does not outrun the integration job when suites are ${suites}`, async () => {
      let clock = 0;
      const ctx = context(new FakeTracker(bot));
      const io = {
        now: () => clock, sleep: async (ms: number) => { clock += ms; },
        read: (argv: string[]) => {
          if (argv[1] === 'api') {
            if (suites === 'unreadable') throw new Error('suite read unavailable');
            // Execute the filter requested by the production function on a modeled suite.
            const suite = { status: 'queued', latest_check_runs_count: 0 };
            if (suites === 'late-suite') return '0';
            const excludesEmpty = argv.at(-1)!.includes('.latest_check_runs_count > 0');
            return String(suite.status !== 'completed' && (!excludesEmpty || suite.latest_check_runs_count > 0) ? 1 : 0);
          }
          return JSON.stringify({ headRefOid: 'h', statusCheckRollup: [
            { name: 'lint', conclusion: 'SUCCESS' },
            ...(clock >= 60_000 ? [{ name: 'integration', conclusion: 'FAILURE' }] : []),
          ] });
        },
      };
      const result = await awaitGreenChecks(ctx, 1, noop, { sha: 'h' }, io);
      
      expect(result).not.toBeNull();
    });
  }
  it('does not exceed a fractional timeout by rounding the final wait up', async () => {
    let clock = 0; const ctx = context(new FakeTracker(bot)); ctx.knobs.checksTimeoutMinutes = 0.501;
    await awaitGreenChecks(ctx, 1, noop, { sha: 'h' }, {
      now: () => clock, sleep: async ms => { clock += ms; },
      read: () => JSON.stringify({ headRefOid: 'h', statusCheckRollup: [] }),
    });
    expect(clock).toBeLessThanOrEqual(30_060);
  });
  it('keeps a card in place when its PR list cannot be read', () => {
    const io = new FakeTracker(bot, [fakeIssue(1, { labels: [{ name: 'size: 1' }] })]);
    const placements: string[] = [];
    const api = loadFunctions('../loop.ts', ['placeFromTracker', 'pullsNaming'], {
      DRY_RUN: false, ctx: context(io), trackerIo: () => io, readTree, placeByFacts,
      sh: () => { throw new Error('PR list unavailable'); }, pointsFromLabels: () => 1, MAX_POINTS: 2,
      place: (_n: unknown, _t: unknown, lane: string) => placements.push(lane), log: noop,
    });
    api.placeFromTracker(1, 'existing PR', 'changed while appraising');
    expect(placements).toEqual([]);
  });
});

describe('runtime moves and settlement', () => {
  const pipeline = '../../fix-github-issue/lib/pipeline.ts';
  const legal = (a: string, b: string) => a === b || successors(laneState(a), { ownEventsOnly: true }).has(laneState(b));
  for (const initial of ['E1', 'D3']) it(`a resumed ${initial} card with a historical objection has a chart route to its revision`, async () => {
    let lane = initial; const edges: string[] = [];
    const api = loadFunctions(pipeline, ['redriveIssue'], {
      DEFAULT_MAX_POINTS: 2, assertDistinctEngines: noop, trackerIo: noop, liveGate: () => ({ ok: true }),
      claim: async () => ({ release: noop }), keepClaimed: () => noop, worktreeAtPullRequest: () => '/fake',
      inFlight: new Map(), isDraft: () => true, sh: () => 'h', catchUp: () => null,
      runWorker: async (_c: unknown, _i: unknown, _cwd: unknown, _max: unknown, _feedback: unknown, reproof: boolean) => {
        const next = reproof ? 'D2' : 'D4'; if (!legal(lane, next)) edges.push(`${lane}->${next}`); lane = next;
        return { verdict: 'failed', reason: 'stop after recording the seat' };
      }, countFailure: () => ({ outcome: 'dlq' }), removeWorktree: noop,
    });
    await api.redriveIssue(context(new FakeTracker(bot)), { number: 1, title: 'issue' }, { number: 7, branch: 'fix-1' }, 'An old bot park comment from before this PR');
    expect(edges).toEqual([]);
  });
  it('a stale rejection at the last review round has a legal DLQ edge', async () => {
    let lane = 'E1'; const edges: string[] = [];
    const move = (_ctx: unknown, _issue: unknown, next: string) => { if (!legal(lane, next)) edges.push(`${lane}->${next}`); lane = next; };
    const ctx = context(new FakeTracker(bot)); ctx.knobs.maxReviewRounds = 3;
    const api = loadFunctions(pipeline, ['reviewAndLand'], {
      reviewCount: () => 2, sh: () => 'h', catchUp: () => null, move,
      review: async () => { move(null, null, 'E2'); return { review: { decision: 'block', blocking: ['fix defect'] }, reviewedSha: 'h' }; },
      serializePullMaster: (_ctx: unknown, action: () => unknown) => action(),
      land: async () => { move(null, null, 'F2'); return 'revise'; },
      recordReview: () => 3,
      deadLetter: (_ctx: unknown, _issue: unknown, phase: string) => { move(null, null, phase === 'review' ? 'Q4' : 'Q5'); return { outcome: 'dlq' }; },
    });
    await api.reviewAndLand(ctx, { number: 1, labels: [] }, '/fake', { pr: 7 }, 2, noop);
    expect(edges).toEqual([]);
  });
  it('an exhausted review budget is a machine DLQ even on re-entry', async () => {
    let parked = false; const ctx = context(new FakeTracker(bot)); ctx.knobs.maxReviewRounds = 3;
    const api = loadFunctions(pipeline, ['reviewAndLand'], {
      reviewCount: () => 3, parkIssue: () => { parked = true; }, mutate: noop, move: noop,
      deadLetter: () => ({ outcome: 'dlq' }),
    });
    const result = await api.reviewAndLand(ctx, { number: 1, labels: [{ name: 'loop/reviews: 3' }] }, '/fake', { pr: 7 }, 2, noop);
    expect({ outcome: result.outcome, parked }).toEqual({ outcome: 'dlq', parked: false });
  });
  it('the first worker passes its existing PR to terminal settlement', async () => {
    let pr: number | undefined;
    const api = loadFunctions(pipeline, ['workIssue'], {
      runWorker: async () => ({ verdict: 'obsolete', reason: 'now obsolete', pr: 7 }),
      settleTerminalVerdict: async (_ctx: unknown, _issue: unknown, _result: unknown, _ceiling: unknown, _say: unknown, known?: number) => { pr = known; return { outcome: 'closed' }; },
    });
    await api.workIssue({}, { number: 1 }, '/fake', 2, 2, noop); expect(pr).toBe(7);
  });
  it('a first worker close with no PR in its verdict still discovers a PR before failed-confirmation settlement', async () => {
    let pr: number | undefined;
    const api = loadFunctions(pipeline, ['workIssue'], {
      runWorker: async () => ({ verdict: 'obsolete', reason: 'now obsolete' }),
      settleTerminalVerdict: async () => ({ outcome: 'failed', reason: 'no usable confirmer' }),
      openPullFor: () => 7,
      countFailure: (_ctx: unknown, _issue: unknown, _reason: unknown, _say: unknown, known?: number) => { pr = known; return { outcome: known ? 'dlq' : 'failed' }; },
    });
    await api.workIssue({}, { number: 1 }, '/fake', 2, 2, noop); expect(pr).toBe(7);
  });
  it('a disputed worker close reports the human lane', () => {
    const lanes: string[] = [];
    const api = loadFunctions(pipeline, ['parkWithBothOpinions'], { mutate: noop, move: (_ctx: unknown, _issue: unknown, lane: string) => lanes.push(lane) });
    api.parkWithBothOpinions({}, { number: 1 }, { verdict: 'obsolete', reason: 'worker' }, { reason: 'confirmer disagrees' }, noop);
    expect(lanes).toEqual(['H2']);
  });
  it('revision proof reports are chart events, too', () => {
    const prompt = readFileSync(new URL('../../fix-github-issue/prompts/triage-and-fix.md', import.meta.url), 'utf8');
    expect(prompt).toContain('{{CARD_PROVING}}');
    expect(legal('D4', 'D2')).toBe(true);
  });
  it('work DLQ retry with an existing stale ready PR never starts a first worker', () => {
    const w = new World(); w.base.push(['shared.ts']); w.decision = 'retry';
    const result = fire(laneState('Q3'), 'TRIAGED', w.facts)!;
    expect(result.actions).not.toContain('runWorker');
    expect(laneKey(result.state)).toBe('F2');
  });
  it('a resumed card reported in E1 keeps its phase when the first fetch throws', () => {
    const routes: string[] = [];
    const api = loadFunctions(pipeline, ['phaseOfLane', 'recordThrow'], {
      deadLetter: (_ctx: unknown, _issue: unknown, phase: string) => { routes.push(phase); return { outcome: 'dlq' }; },
      openPullFor: () => 7, isDraft: () => false,
    }, 'const lastLane = new Map();\n' + readFileSync(new URL(pipeline, import.meta.url), 'utf8').match(/^const laneKeyOf = .*;$/m)![0] + '\n');
    const ctx = context(new FakeTracker(bot));
    let actualLane = 'E1'; ctx.onLane = event => { actualLane = event.lane; };
    // loop.ts places a stranded card without calling pipeline.move().
    ctx.onLane({ issue: 1, title: 'resuming', lane: 'E1' });
    api.recordThrow(ctx, { number: 1 }, new Error('fetch failed before the first pipeline move'), noop, 7);
    expect(actualLane).toBe('E1'); expect(routes).toEqual(['review']);
  });
  it('a tracker exception after a confirmed merge cannot return the card to Ready', () => {
    const lanes: string[] = [];
    const api = loadFunctions(pipeline, ['phaseOfLane', 'move', 'countFailure', 'recordThrow'], {
      openPullFor: () => undefined, recordAttempt: () => 1, attemptCount: () => 0,
    }, 'const lastLane = new Map();\n' + readFileSync(new URL(pipeline, import.meta.url), 'utf8').match(/^const laneKeyOf = .*;$/m)![0] + '\n');
    const ctx = context(new FakeTracker(bot)); ctx.onLane = event => lanes.push(event.lane);
    const issue = { number: 1, title: 'merged but not closed yet', labels: [] };
    api.move(ctx, issue, 'T1');
    api.recordThrow(ctx, issue, new Error('the post-merge live gate could not read the issue'), noop);
    expect(lanes).toEqual(['T1']);
  });
  it('the post-merge diagnostic uses the base actually checked, not a later shared-ref value', async () => {
    const checkedBase = 'A'; const landedOn = 'B'; let reported: string | undefined;
    const ctx = context(new FakeTracker(bot)); ctx.afterMerge = event => { reported = event.unseenBase; };
    const sh = (_ctx: unknown, argv: string[]) => {
      if (argv[1] === 'rev-list') { expect(argv.at(-1)).toBe(`HEAD..${checkedBase}`); return '0'; }
      if (argv[1] === 'rev-parse') return argv.at(-1) === 'origin/main' ? landedOn : 'h';
      if (argv.includes('mergedAt')) return '2026-09-20T00:00:00Z';
      if (argv.includes('mergeCommit')) return 'merge-sha';
      if (argv.at(-1) === '.parents[0].sha') return landedOn;
      return '';
    };
    const { behindBase } = loadFunctions('../../fix-github-issue/lib/staleness.ts', ['behindBase'], { sh, fetchBase: () => checkedBase });
    const api = loadFunctions(pipeline, ['land', 'landedOnUnseenBase'], {
      DEFAULT_MAX_POINTS: 2, MAX_BASE_REFRESHES: 2, effectiveTouches: () => ['code'], mergeAllowed: () => true,
      sh, catchUp: () => null, pullRequestMatchesReview: async () => null, behindBase, fetchBase: () => checkedBase, checkNamesOn: () => ['ci'], requiredStatusChecks: () => ['ci'],
      awaitGreenChecks: async () => null, move: noop, liveGate: () => ({ ok: true }), trackerIo: noop,
      mutate: noop, followBase: noop, removeWorktree: noop, closeIssue: async () => {},
    });
    expect(await api.land(ctx, { number: 1 }, 7, ['code'], { review: { decision: 'merge' }, reviewedSha: 'h' }, '/fake', noop)).toBe('merged');
    expect(reported).toBe(landedOn);
  });
});

describe('safety pressure', () => {
  const pipeline = '../../fix-github-issue/lib/pipeline.ts';
  it('an objection thread read failure still propagates after the PR creation time was read', () => {
    let reads = 0;
    const api = loadFunctions('../loop.ts', ['lastObjection'], {
      ctx: { botLogin: bot }, sh: () => { if (++reads === 1) return '2026-09-20T00:00:00Z'; throw new Error('thread unreadable'); },
    });
    expect(() => api.lastObjection(1, 7)).toThrow('thread unreadable'); expect(reads).toBe(2);
  });
  it('a fast review cannot turn its partially registered check list into the complete expected set', async () => {
    let clock = 0;
    const ctx = context(new FakeTracker(bot));
    const { checkNamesOn } = loadFunctions(pipeline, ['checkNamesOn'], {
      sh: (_ctx: unknown, argv: string[]) => argv.some(a => a.endsWith('/check-runs')) ? '["lint"]' : '[]',
    });
    // Review finished at t=0. A second workflow registers at t=60s on this same head.
    const names = checkNamesOn(ctx, 'h');
    const result = await awaitGreenChecks(ctx, 7, noop, { sha: 'h', names }, {
      now: () => clock, sleep: async ms => { clock += ms; },
      read: argv => argv[1] === 'api' ? '0' : JSON.stringify({ headRefOid: 'h', statusCheckRollup: [
        { name: 'lint', conclusion: 'SUCCESS' },
        ...(clock >= 60_000 ? [{ name: 'integration', conclusion: 'FAILURE' }] : []),
      ] }),
    });
    
    expect(result).not.toBeNull();
  });
  for (const suites of ['unreadable', 'zero-runs'] as const) {
    it(`actually waits on ${suites} suite data with a nonempty expected set`, async () => {
      let clock = 0; let reads = 0; const ctx = context(new FakeTracker(bot));
      const result = await awaitGreenChecks(ctx, 7, noop, { sha: 'h', required: ['lint'] }, {
        now: () => clock, sleep: async ms => { clock += ms; },
        read: argv => {
          reads++;
          if (argv[1] === 'api') {
            if (suites === 'unreadable') throw new Error('unavailable');
            return argv.at(-1)!.includes('latest_check_runs_count > 0') ? '0' : '1';
          }
          return JSON.stringify({ headRefOid: 'h', statusCheckRollup: [{ name: 'lint', conclusion: 'SUCCESS' }] });
        },
      });
      expect(reads).toBeGreaterThan(1); expect(clock).toBe(600_000); expect(result).not.toBeNull();
    });
  }
  it('terminal first-worker settlement cannot close a foreign PR selected only by numeric suffix', async () => {
    const closed: number[] = [];
    const api = loadFunctions(pipeline, ['openPullFor', 'workIssue', 'settleTerminalVerdict'], {
      runWorker: async () => ({ verdict: 'needs-human', reason: 'access unavailable' }),
      sh: () => JSON.stringify([{ number: 88, headRefName: 'person/release-1', author: { login: 'someone-else' }, body: 'Refs #999' }]),
      mutate: (_ctx: unknown, _why: unknown, argv: string[]) => { if (argv[1] === 'pr' && argv[2] === 'close') closed.push(Number(argv[3])); },
      move: noop, removeWorktree: noop,
    });
    await api.workIssue(context(new FakeTracker(bot)), { number: 1, title: 'unrelated issue', labels: [] }, '/fake', 2, 2, noop);
    expect(closed).toEqual([]);
  });
  it('failed renewals cannot leave an active worker running after another run acquires its expired claim', async () => {
    const io = new FakeTracker(bot, [fakeIssue(1)]); const a = context(io); const b = context(io); b.runId = 'other-host-2-2';
    const first = await claim(a, io, 1, 'working'); if (first === 'busy') throw new Error('first claim failed');
    io.throwOn = /renew claim/;
    // The driver is still awaiting its worker. A renewal fails; it neither throws nor reports loss.
    let lossReported = false; try { first.renew(); } catch { lossReported = true; }
    // Advance the durable lease into the past without replacing the global clock used by other tests.
    const posted = io.issues.get(1)!.comments.find(c => c.databaseId === first.commentId)!;
    posted.body = posted.body.replace(/expires=\S+/, 'expires=2000-01-01T00:00:00Z');
    const second = await claim(b, io, 1, 'working');
    try { expect(second === 'busy' || lossReported).toBe(true); }
    finally { if (second !== 'busy') second.release(); first.release(); }
  });
});

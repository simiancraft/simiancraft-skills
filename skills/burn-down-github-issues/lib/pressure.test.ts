import '../../../test/no-real-gh.preload.ts';
import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Card, fire, laneKey, laneState, successors } from './simulate.ts';
import { Carving, type CarvingDeps } from './carving.ts';
import { LANES } from './lanes.ts';
import { issueRefs } from './refs.ts';
import { RunStopping } from '../../fix-github-issue/lib/shell.ts';
import { isHostFaultKind, settleOutsideStop } from '../../fix-github-issue/lib/environment-fault.ts';
import { awaitGreenChecks } from '../../fix-github-issue/lib/pipeline.ts';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import { CLAIM_READBACK, claim } from '../../carve-github-issue/lib/claims.ts';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import { readTree } from '../../carve-github-issue/lib/tree.ts';
import { CARVE_DEFAULTS } from '../../carve-github-issue/lib/carve.ts';
import { allOpenIssues } from '../../appraise-github-issues/lib/appraise.ts';
import type { Issue } from '../../fix-github-issue/lib/pipeline.ts';
import { placeByFacts } from './board-writer.ts';
import { INCIDENT_LABEL, incidentHold } from './floor/incident.ts';
import { boundaryWaived, landBlocker } from '../../fix-github-issue/lib/land.ts';
import { heldComment, loopHoldStands, objectionAfter, proofHeldComment, standingApproval, standingStop, stopComment, stopIn } from '../../fix-github-issue/lib/stop-record.ts';
import { LOOP_NOTE, loopNote } from '../../fix-github-issue/lib/note.ts';

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

describe('placement of a work-whole issue', () => {
  it('is Ready at any size once the knife judged it one piece', () => {
    expect(placeByFacts({ state: 'OPEN', labels: ['size: 8', 'loop/work-whole'], pulls: [], points: 8, ceiling: 2 }).lane).toBe('B1');
    expect(placeByFacts({ state: 'OPEN', labels: ['size: 8'], pulls: [], points: 8, ceiling: 2 }).lane).toBe('C1');
  });
});

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
/** `recordMerge` with every tracker write left out: the card move, the floor hand-off, and the lane's removal run. */
async function fakeRecordMerge(ctx: Context, merge: { sha: string }, record: { place: (note: string) => void; note: string; beforeClose?: () => void }) {
  record.place(record.note);
  if (merge.sha) ctx.afterMerge?.(merge as never);
  record.beforeClose?.();
  return 'closed';
}
function loadFunctions(path: string, names: string[], deps: Record<string, unknown>, prefix = ''): any {
  // Every settlement asks whether the run is stopping, whether an environment fault ended it, and whether its lease stands; here none is in doubt.
  // Nor does any pull request carry a person's hold, unless a test says so.
  deps = { pullHolds: () => [], preserveLaneWork: () => true, retireLane: () => {}, isStopping: () => false, environmentFaultOf: () => null, settleOutsideStop: () => ({ charged: false, reason: '' }), clearLaneForRerun: () => {}, rememberFaultMarkers: () => {}, RunStopping: class extends Error {}, recordMerge: fakeRecordMerge, approvedAtHead: async () => null, leaseLost: () => false, LeaseLostError: class extends Error {}, holdLease: () => {}, isFinishing: () => false, yieldToStop: async () => {}, finishDespiteStop: (record: () => unknown) => record(), loopNote: (body: string) => body, ...deps };
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
  it('backlog placement waits for every board write before returning', async () => {
    let release!: () => void;
    let waiting = false;
    let returned = false;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const api = loadFunctions('../loop.ts', ['placeBacklog'], {
      BOARD: { snapshot: () => new Map(), settled: () => { waiting = true; return pending; } },
      CONFIG: { ageDays: 100 }, ONLY: null, ctx: {}, sh: () => '[]',
      mergedPullRequests: () => [], log: noop, DRY_RUN: false,
    });
    const result = api.placeBacklog([]).then(() => { returned = true; });
    await Bun.sleep(0);
    expect(waiting).toBe(true);
    expect(returned).toBe(false);
    release();
    await result;
    expect(returned).toBe(true);
  });

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

describe('an approval is recorded on the thread', () => {
  const approve = async (decision: string) => {
    const writes: string[][] = [];
    const lanes: string[] = [];
    const api = loadFunctions('../../fix-github-issue/lib/pipeline.ts', ['review'], {
      isDraft: () => false, dirtyPaths: () => [], sh: () => 'a'.repeat(40), stopComment,
      validTouches: loadFunctions('../../fix-github-issue/lib/pipeline.ts', ['validTouches'], { TOUCH_KINDS: ['code', 'data', 'migration', 'stored-string', 'ci'] }).validTouches,
      move: (_ctx: unknown, _issue: unknown, lane: string) => lanes.push(lane),
      runReviewer: async () => ({ decision, blocking: [], adequacy: 'the receipts show it', touches: ['migration'] }),
      mutate: (_ctx: unknown, _d: unknown, argv: string[]) => writes.push(argv),
    });
    const result = await api.review(context(new FakeTracker(bot)), { number: 1 }, 7, '/fake', noop, 1, ['code']);
    return { result, writes, lanes };
  };
  it('a merge verdict writes an approved stop naming the reviewed head and the pull request', async () => {
    const { result, writes } = await approve('merge');
    expect(result.reviewedSha).toBe('a'.repeat(40));
    const body = writes.find((argv) => argv[1] === 'issue' && argv[2] === 'comment')?.at(-1) ?? '';
    expect(standingStop([{ author: bot, body }], bot)).toEqual({ kind: 'approved', sha: 'a'.repeat(40) });
    expect(stopIn(body)?.fields.pr).toBe('7');
    // Both seats' classification, so a landing of the same head can rest on the record.
    expect(stopIn(body)?.fields.touches).toBe('code,migration');
  });
  it('a rejection writes none', async () => {
    expect((await approve('block')).writes).toEqual([]);
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
    const api = loadFunctions(pipeline, ['claimLane', 'withLane', 'redriveIssue'], {
      DEFAULT_MAX_POINTS: 2, ceilingFor: (_l: unknown, _p: unknown, c: number) => c, labelPoints: () => null, assertDistinctEngines: noop, trackerIo: noop, liveGate: () => ({ ok: true }),
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
      serializePullMaster: (_ctx: unknown, _issue: unknown, _say: unknown, action: () => unknown) => action(),
      land: async () => { move(null, null, 'F2'); return 'revise'; },
      recordReview: () => 3,
      deadLetter: (_ctx: unknown, _issue: unknown, phase: string) => { move(null, null, phase === 'review' ? 'Q4' : 'Q5'); return { outcome: 'dlq' }; },
    });
    await api.reviewAndLand(ctx, { number: 1, labels: [] }, '/fake', { pr: 7 }, 2, noop);
    expect(edges).toEqual([]);
  });
  it('a base that moved into the work at the merge gate sends the proof back to be reacquired', async () => {
    const ctx = context(new FakeTracker(bot)); ctx.knobs.maxReviewRounds = 3;
    const reproofs: boolean[] = [];
    let landings = 0;
    const api = loadFunctions(pipeline, ['reviewAndLand'], {
      reviewCount: () => 0, sh: () => 'h', catchUp: () => null, move: noop, mutate: noop, MAX_BASE_REFRESHES: 3,
      review: async () => ({ review: { decision: 'merge', blocking: [] }, reviewedSha: 'h' }),
      serializePullMaster: (_ctx: unknown, _issue: unknown, _say: unknown, action: () => unknown) => action(),
      land: async () => (landings++ === 0 ? { reproof: { before: 'a', after: 'b', overlap: ['src/x.ts'], netChangeIntact: true } } : 'merged'),
      runWorker: async (_c: unknown, _i: unknown, _cwd: unknown, _max: unknown, _feedback: unknown, reproof: boolean) => {
        reproofs.push(reproof);
        return { verdict: 'fixed', pr: 7, reason: 'proof reacquired' };
      },
      settleTerminalVerdict: async () => null,
    });
    const result = await api.reviewAndLand(ctx, { number: 1, labels: [] }, '/fake', { pr: 7 }, 2, noop);
    expect(reproofs).toEqual([true]);
    expect(result.outcome).toBe('merged');
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
  it('a card says where its brief came from, so a redrive does not claim a review that never happened', () => {
    const notes: string[] = [];
    const api = loadFunctions(pipeline, ['runWorker', 'laneBranch'], {
      move: (_ctx: unknown, _issue: unknown, _lane: string, note?: string) => notes.push(note ?? ''),
      runCode: async () => ({ verdict: 'failed', reason: 'stub' }),
      runProve: async () => ({ verdict: 'failed', reason: 'stub' }),
      holdLease: noop,
      resetLane: noop,
      ctx: {},
    });
    const ctx = { seats: { worker: {} }, knobs: { pointScale: [1] }, dryRun: true, log: noop } as never;
    const issue = { number: 1, title: 't', labels: [] } as never;
    const review = (confidence: string, decision = 'gather-more') => ({ pr: 1, decision, adequacy: 'a', confidence, blocking: ['x'] }) as never;
    return Promise.all([
      api.runWorker(ctx, issue, '/tmp', 2, review('redrive')),
      api.runWorker(ctx, issue, '/tmp', 2, review('resume')),
      api.runWorker(ctx, issue, '/tmp', 2, review('round 1')),
      api.runWorker(ctx, issue, '/tmp', 2, review('round 1', 'block')),
    ]).then(() => {
      expect(notes[0]).toContain('a person asked for it to be continued');
      expect(notes[1]).toContain('it lost its driver');
      expect(notes[2]).toBe('more evidence after a review');
      expect(notes[3]).toBe('revision after a review');
    });
  });
  it('a reviewer asking for evidence reaches the prover alone, and an objection to the code the coder first', () => {
    const seats: string[] = [];
    const api = loadFunctions(pipeline, ['runWorker', 'laneBranch'], {
      move: noop,
      runCode: async () => { seats.push('coder'); return { verdict: 'failed', reason: 'stub' }; },
      runProve: async () => { seats.push('prover'); return { verdict: 'failed', reason: 'stub' }; },
      holdLease: noop,
      resetLane: noop,
      ctx: {},
    });
    const ctx = { seats: { worker: {} }, knobs: { pointScale: [1] }, dryRun: true, log: noop } as never;
    const issue = { number: 1, title: 't', labels: [] } as never;
    const review = (decision: string) => ({ pr: 1, decision, adequacy: 'a', confidence: 'round 1', blocking: ['x'] }) as never;
    return api.runWorker(ctx, issue, '/tmp', 2, review('gather-more'))
      .then(() => api.runWorker(ctx, issue, '/tmp', 2, review('block')))
      .then(() => expect(seats).toEqual(['prover', 'coder']));
  });
  it('a first attempt placed at Proving by an earlier announcement runs the prover alone', async () => {
    const seats: string[] = [];
    const api = loadFunctions(pipeline, ['runWorker'], {
      move: noop, holdLease: noop, resetLane: noop,
      placeWork: () => ({ kind: 'prove', sha: 'abc', handoff: 'changed x', coded: { branch: 'fix/x-1', gated: 'abc', touches: ['code'] } }),
      runCode: async () => { seats.push('coder'); return { verdict: 'failed', reason: 'stub' }; },
      runProve: async (_c: unknown, _i: unknown, _cwd: unknown, _coded: unknown, brief: { kind: string; text: string }) => { seats.push(`prover:${brief.kind}:${brief.text}`); return { verdict: 'proved', reason: 'ok', pr: 9 }; },
    });
    const ctx = { seats: { worker: {} }, knobs: { pointScale: [1], maxWorkerAttempts: 3 }, dryRun: true, log: noop } as never;
    const result = await api.runWorker(ctx, { number: 1, title: 't', labels: [] }, '/tmp', 2);
    expect(seats).toEqual(['prover:handoff:changed x']);
    expect(result).toMatchObject({ verdict: 'fixed', pr: 9, branch: 'fix/x-1', touches: ['code'] });
  });
  it('a refused proof spends one attempt and codes again with what could not be shown, then proves afresh', async () => {
    const seats: string[] = [];
    const attempts: number[] = [];
    let proofs = 0;
    const api = loadFunctions(pipeline, ['runWorker'], {
      move: noop, holdLease: noop, resetLane: noop, attemptCount: () => 0,
      recordAttempt: (_c: unknown, _n: unknown, previous: number) => { attempts.push(previous + 1); return previous + 1; },
      placeWork: () => ({ kind: 'code', brief: { kind: 'first' } }),
      runCode: async (_c: unknown, _i: unknown, _cwd: unknown, _m: unknown, brief: { kind: string; text?: string }) => {
        seats.push(`coder:${brief.kind}${brief.text ? `:${brief.text}` : ''}`);
        return { verdict: 'coded', reason: 'pushed', branch: 'fix/x-1', sha: 'abc', gated: 'abc', handoff: 'h', touches: ['code'] };
      },
      runProve: async () => {
        seats.push('prover');
        proofs += 1;
        return proofs === 1 ? { verdict: 'unprovable', reason: 'no', brief: 'empty list throws' } : { verdict: 'proved', reason: 'ok', pr: 9, touches: ['ci'] };
      },
    });
    const ctx = { seats: { worker: {} }, knobs: { pointScale: [1], maxWorkerAttempts: 3 }, dryRun: true, log: noop } as never;
    const issue = { number: 1, title: 't', labels: [] as Array<{ name: string }> };
    const result = await api.runWorker(ctx, issue, '/tmp', 2);
    expect(seats).toEqual(['coder:first', 'prover', 'coder:unproved:empty list throws', 'prover']);
    expect(attempts).toEqual([1]);
    expect(issue.labels).toEqual([{ name: 'loop/attempts: 1' }]);
    expect(result).toMatchObject({ verdict: 'fixed', pr: 9, touches: ['code', 'ci'] });
  });
  it('a catch-up at the seam announces the head it pushed, so a prover killed after it is proved again', async () => {
    const bodies: string[] = [];
    const api = loadFunctions(pipeline, ['runWorker'], {
      move: noop, holdLease: noop, resetLane: noop,
      placeWork: () => ({ kind: 'code', brief: { kind: 'first' } }),
      runCode: async () => ({ verdict: 'coded', reason: 'pushed', branch: 'fix/x-1', sha: 'coded1', gated: 'coded1', handoff: 'h' }),
      seamCatchUp: () => 'caught-up',
      sh: () => 'merged2',
      codedComment: (_run: unknown, coded: { sha: string; gated: string }) => `coded sha=${coded.sha} gated=${coded.gated}`,
      mutate: (_ctx: unknown, _d: unknown, argv: string[]) => bodies.push(argv[argv.length - 1]),
      runProve: async () => ({ verdict: 'proved', reason: 'ok', pr: 9 }),
    });
    const ctx = { seats: { worker: {} }, knobs: { pointScale: [1], maxWorkerAttempts: 3 }, dryRun: false, log: noop, runId: 'r' } as never;
    await api.runWorker(ctx, { number: 1, title: 't', labels: [] }, '/tmp', 2);
    expect(bodies).toEqual(['coded sha=coded1 gated=coded1', 'coded sha=merged2 gated=coded1']);
  });
  it('a refused proof on the last attempt is left for the caller to count, never counted twice', async () => {
    const recorded: number[] = [];
    const api = loadFunctions(pipeline, ['runWorker'], {
      move: noop, holdLease: noop, resetLane: noop, attemptCount: () => 2,
      recordAttempt: () => { recorded.push(1); return 3; },
      placeWork: () => ({ kind: 'code', brief: { kind: 'first' } }),
      runCode: async () => ({ verdict: 'coded', reason: 'pushed', branch: 'fix/x-1', sha: 'abc', gated: 'abc', handoff: 'h' }),
      runProve: async () => ({ verdict: 'unprovable', reason: 'no', brief: 'still wrong' }),
    });
    const ctx = { seats: { worker: {} }, knobs: { pointScale: [1], maxWorkerAttempts: 3 }, dryRun: true, log: noop } as never;
    const result = await api.runWorker(ctx, { number: 1, title: 't', labels: [] }, '/tmp', 2);
    expect(recorded).toEqual([]);
    expect(result).toMatchObject({ verdict: 'failed', reason: 'the change could not be proved: still wrong' });
  });
  it('a disputed worker close reports the human lane', () => {
    const lanes: string[] = [];
    const api = loadFunctions(pipeline, ['parkWithBothOpinions'], { mutate: noop, move: (_ctx: unknown, _issue: unknown, lane: string) => lanes.push(lane) });
    api.parkWithBothOpinions({}, { number: 1 }, { verdict: 'obsolete', reason: 'worker' }, { reason: 'confirmer disagrees' }, noop);
    expect(lanes).toEqual(['H2']);
  });
  it('a revision is proved like a first attempt, by a seat that never moves its own card', () => {
    const prompts = ['../../code-github-issue/prompts/code.md', '../../prove-github-issue/prompts/prove.md'].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));
    for (const prompt of prompts) expect(prompt).not.toMatch(/card\.ts|\{\{CARD_/);
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
    const api = loadFunctions(pipeline, ['land', 'mergeCommitOf', 'landedOnUnseenBase'], {
      DEFAULT_MAX_POINTS: 2, MAX_BASE_REFRESHES: 2, effectiveTouches: () => ['code'], mergeAllowed: () => true,
      sh, catchUp: () => null, pullRequestMatchesReview: async () => null, behindBase, behindBeyondNoise: behindBase, requiresUpToDate: () => true, fetchBase: () => checkedBase, checksOn: () => ({ names: ['ci'], passed: ['ci'] }), requiredStatusChecks: () => ['ci'],
      awaitGreenChecks: async () => null, move: noop, liveGate: () => ({ ok: true }), trackerIo: noop,
      mutate: noop, followBase: noop, removeWorktree: noop, closeIssue: async () => {},
    });
    expect(await api.land(ctx, { number: 1 }, 7, ['code'], { review: { decision: 'merge' }, reviewedSha: 'h' }, '/fake', noop)).toBe('merged');
    expect(reported).toBe(landedOn);
  });
  it('a base that moved only by release noise lands without a catch-up, unless protection wants an up-to-date branch', async () => {
    const base = 'A';
    const sh = (_ctx: unknown, argv: string[]) => {
      if (argv[1] === 'rev-parse') return argv.at(-1) === 'origin/main' ? base : 'h';
      if (argv.includes('mergedAt')) return '2026-09-20T00:00:00Z';
      if (argv.includes('mergeCommit')) return 'merge-sha';
      if (argv.at(-1) === '.parents[0].sha') return base;
      return '';
    };
    const landWith = (strict: boolean) => {
      const ctx = context(new FakeTracker(bot));
      const api = loadFunctions(pipeline, ['land', 'mergeCommitOf', 'landedOnUnseenBase'], {
        DEFAULT_MAX_POINTS: 2, MAX_BASE_REFRESHES: 2, effectiveTouches: () => ['code'], mergeAllowed: () => true, boundaryWaived: () => false,
        sh, catchUp: () => null, pullRequestMatchesReview: async () => null,
        // The lane is behind by a changelog alone, on every look.
        behindBase: () => ['changelog/1.0.1.md'], behindBeyondNoise: () => [], requiresUpToDate: () => strict,
        commitsBehind: () => [{ sha: 'c'.repeat(40), author: 'someone', subject: 'land the changelog' }], describeCommits: (c: { subject: string }[]) => c.map(x => x.subject).join(', '),
        MAX_NOISE_REFRESHES: 6,
        fetchBase: () => base, checksOn: () => ({ names: ['ci'], passed: ['ci'] }), requiredStatusChecks: () => ['ci'],
        awaitGreenChecks: async () => null, move: noop, liveGate: () => ({ ok: true }), trackerIo: noop,
        mutate: noop, followBase: noop, removeWorktree: noop, closeIssue: async () => {},
      });
      return api.land(ctx, { number: 1 }, 7, ['code'], { review: { decision: 'merge' }, reviewedSha: 'h' }, '/fake', noop);
    };
    expect(await landWith(false)).toBe('merged');
    // Strict protection keeps the old rule: never fresh while behind, so the refresh cap is reached.
    expect(await landWith(true)).toEqual({ dlq: expect.stringMatching(/the base moved \d+ times/) });
  });
  describe('base moves made only of release noise', () => {
    type Mover = { sha: string; author: string; subject: string };
    /** One look upstream: the commits that moved the base, and whether every file they changed is release noise. */
    type Move = { commits: Mover[]; noise: boolean };
    const feature = (n: number): Move => ({ commits: [{ sha: `h${n}`.padEnd(40, '0'), author: 'someone', subject: `merge feature ${n}` }], noise: false });
    const release = (n: number): Move => ({ commits: [{ sha: `r${n}`.padEnd(40, '0'), author: 'release-bot', subject: `chore(release): 1.0.${n} [skip ci]` }], noise: true });
    /** Lands with the base moving by `moves` in turn, one per look upstream, then holding still; protection wants an up-to-date branch. */
    const landThrough = (moves: Move[] | (() => Move | undefined)) => {
      const next = typeof moves === 'function' ? moves : () => moves.shift();
      let current: Move | undefined;
      const sh = (_ctx: unknown, argv: string[]) => {
        if (argv[1] === 'rev-parse') return argv.at(-1) === 'origin/main' ? 'A' : 'h';
        if (argv.includes('mergedAt')) return '2026-09-20T00:00:00Z';
        if (argv.includes('mergeCommit')) return 'merge-sha';
        if (argv.at(-1) === '.parents[0].sha') return 'A';
        return '';
      };
      const ctx = context(new FakeTracker(bot));
      const api = loadFunctions(pipeline, ['land', 'mergeCommitOf', 'landedOnUnseenBase'], {
        DEFAULT_MAX_POINTS: 2, MAX_BASE_REFRESHES: 2, MAX_NOISE_REFRESHES: 6, effectiveTouches: () => ['code'], mergeAllowed: () => true, boundaryWaived: () => false,
        sh, catchUp: () => null, pullRequestMatchesReview: async () => null,
        fetchBase: () => { current = next(); return 'A'; },
        behindBase: () => (current ? ['some/file'] : []), behindBeyondNoise: () => (current && !current.noise ? ['some/file'] : []), requiresUpToDate: () => true,
        commitsBehind: () => current?.commits ?? [],
        describeCommits: (commits: Mover[]) => commits.map(commit => `${commit.sha.slice(0, 10)} "${commit.subject}" (${commit.author})`).join(', '),
        checksOn: () => ({ names: ['ci'], passed: ['ci'] }), requiredStatusChecks: () => ['ci'],
        awaitGreenChecks: async () => null, move: noop, liveGate: () => ({ ok: true }), trackerIo: noop,
        mutate: noop, followBase: noop, removeWorktree: noop, closeIssue: async () => {},
      });
      return api.land(ctx, { number: 1 }, 7, ['code'], { review: { decision: 'merge' }, reviewedSha: 'h' }, '/fake', noop);
    };

    it('are caught up on without spending the refresh cap', async () => {
      // Two merges, each followed by two release commits: six moves, two counted.
      expect(await landThrough([feature(1), release(1), release(2), feature(2), release(3), release(4)])).toBe('merged');
    });

    it('count by what changed, never by who made the commit', async () => {
      // A release bot's commit that changed code, and a skip-CI subject on it, are movement like any other.
      const botCode = (n: number): Move => ({ commits: [{ sha: `b${n}`.padEnd(40, '0'), author: 'release-bot', subject: `write back ${n} [skip ci]` }], noise: false });
      const result = await landThrough([botCode(1), release(1), botCode(2), botCode(3)]);
      expect(result).toEqual({ dlq: expect.stringContaining('the base moved 4 times while this landing waited on its gates (3 beyond release noise)') });
    });

    it('name every commit that moved the base in the dead letter', async () => {
      const result = (await landThrough([feature(1), release(1), feature(2), feature(3)])) as { dlq: string };
      for (const move of [feature(1), release(1), feature(2), feature(3)]) expect(result.dlq).toContain(move.commits[0].subject);
      expect(result.dlq).toContain('(someone)');
    });

    it('cannot loop forever: an endless stream of them reaches a bound of its own', async () => {
      let n = 0;
      const result = await landThrough(() => release(++n));
      expect(result).toEqual({ dlq: expect.stringContaining('the base moved 7 times while this landing waited on its gates (7 only by release noise, past that bound of 6)') });
      expect(n).toBe(7);
    });
  });
});

describe('a floor incident at the merge boundary', () => {
  const pipeline = '../../fix-github-issue/lib/pipeline.ts';
  const incident = { number: 9, title: 'floor: item absent', labels: [{ name: INCIDENT_LABEL }] };
  const landWith = (holdAtBoundary: Context['holdAtBoundary'], landPastBoundary?: number) => {
    const parks: string[][] = [];
    const ctx = context(new FakeTracker(bot));
    ctx.knobs.autoMerge = 'code-only';
    ctx.holdAtBoundary = holdAtBoundary;
    ctx.landPastBoundary = landPastBoundary;
    const sh = (_ctx: unknown, argv: string[]) => {
      if (argv[1] === 'rev-parse') return argv.at(-1) === 'origin/main' ? 'A' : 'h';
      if (argv.includes('mergedAt')) return '2026-09-20T00:00:00Z';
      if (argv.includes('mergeCommit')) return 'merge-sha';
      if (argv.at(-1) === '.parents[0].sha') return 'A';
      return '';
    };
    const api = loadFunctions(pipeline, ['land', 'mergeCommitOf', 'landedOnUnseenBase', 'mergeAllowed'], {
      DEFAULT_MAX_POINTS: 2, MAX_BASE_REFRESHES: 2, effectiveTouches: () => ['code'], boundaryWaived, waiverNoted: new Set(),
      sh, catchUp: () => null, pullRequestMatchesReview: async () => null,
      behindBase: () => [], behindBeyondNoise: () => [], requiresUpToDate: () => false,
      fetchBase: () => 'A', checksOn: () => ({ names: ['ci'], passed: ['ci'] }), requiredStatusChecks: () => ['ci'],
      awaitGreenChecks: async () => null, move: noop, liveGate: () => ({ ok: true }), trackerIo: noop,
      mutate: (_ctx: unknown, _what: string, argv: string[]) => { if (argv.includes('loop/parked')) parks.push(argv); },
      followBase: noop, removeWorktree: noop, closeIssue: async () => {},
    });
    return api.land(ctx, incident, 7, ['code'], { review: { decision: 'merge' }, reviewedSha: 'h' }, '/fake', noop).then((outcome: unknown) => ({ outcome, parks }));
  };
  it('without a hold, autoMerge alone decides', async () => {
    expect((await landWith(undefined)).outcome).toBe('merged');
  });
  const reverting: Context['holdAtBoundary'] = (issue) => incidentHold(issue, () => 'undoes #12 (abc1234567): puts back lines it removed from src/a.ts');
  const forward: Context['holdAtBoundary'] = (issue) => incidentHold(issue, () => null);
  it('lands an incident fix that repairs forward without a person', async () => {
    const { outcome, parks } = await landWith(forward);
    expect(outcome).toBe('merged');
    expect(parks).toHaveLength(0);
  });
  it('parks an incident fix that undoes a recent merge, with a reason --land accepts', async () => {
    const { outcome, parks } = await landWith(reverting);
    expect(outcome).toEqual({ park: expect.stringMatching(/^autoMerge is code-only and the change touches code; a floor\/incident fix that undoes #12/), boundary: true });
    expect(parks).toHaveLength(1);
    const body = (outcome as { park: string }).park;
    expect(landBlocker(['loop/parked'], [{ body, createdAt: '2026-09-20T00:00:00Z' }], '2026-09-20T00:00:01Z')).toBeNull();
  });
  it('a person who clears it with --land lands it', async () => {
    expect((await landWith(reverting, incident.number)).outcome).toBe('merged');
  });
  it('holds only incidents, asks about a revert only for one, and the loop asks it at every merge', () => {
    let asked = 0;
    const ask = () => {
      asked += 1;
      return 'reverts #12 (abc1234567)';
    };
    expect(incidentHold({ number: 1, labels: [{ name: 'bug' }] }, ask)).toBeNull();
    expect(asked).toBe(0);
    expect(incidentHold(incident, ask)).toContain('live environment');
    expect(readFileSync(new URL('../loop.ts', import.meta.url), 'utf8')).toContain('holdAtBoundary: (issue, change) => incidentHold(issue, () => revertOf(change.cwd, change.base, recentMerges(ctx, issue.number, FLOOR_DIR))),');
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
    const { checksOn } = loadFunctions(pipeline, ['checksOn', 'reviewedChecks'], {
      sh: (_ctx: unknown, argv: string[]) => argv.some(a => a.includes('/check-runs')) ? '{"name":"lint","verdict":"success"}' : '',
    });
    // Review finished at t=0. A second workflow registers at t=60s on this same head.
    const { names } = checksOn(ctx, 'h');
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
      move: noop, removeWorktree: noop, heldComment,
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


describe('blocker close reasons', () => {
  for (const reason of ['COMPLETED', 'NOT_PLANNED', 'DUPLICATE']) {
    it(`enriches gh blockers before placement and the ${reason} sweep`, async () => {
      const leaf = fakeIssue(3698, { labels: [{ name: 'size: 1' }] });
      const io = new FakeTracker(bot, [leaf]);
      const ctx = context(io);
      const blocker = { id: 'I_blocker', number: 3697, state: 'CLOSED', title: 'blocker', url: 'https://github.com/o/r/issues/3697' };
      const calls: string[][] = [];
      const spawn = spyOn(Bun, 'spawnSync').mockImplementation(((argv: string[]) => {
        calls.push(argv);
        let answer: unknown;
        if (argv[1] === 'issue' && argv[2] === 'list') {
          answer = [{ ...leaf, blockedBy: { nodes: [blocker] } }, { ...leaf, number: 3699, blockedBy: [blocker] }];
        } else {
          expect(argv.slice(0, 3)).toEqual(['gh', 'api', 'graphql']);
          expect(argv).toContain('owner=o');
          expect(argv).toContain('name=r');
          expect(argv.find((a) => a.startsWith('query='))?.match(/issue\(number: 3697\)/g)).toHaveLength(1);
          answer = { data: { repository: { i3697: { number: 3697, state: 'CLOSED', stateReason: reason } } } };
        }
        return { exitCode: 0, stdout: Buffer.from(JSON.stringify(answer)), stderr: Buffer.from('') };
      }) as typeof Bun.spawnSync);
      let issues: Issue[];
      try {
        issues = allOpenIssues(ctx);
      } finally {
        spawn.mockRestore();
      }
      expect(calls).toHaveLength(2);
      expect(issues[1].blockedBy?.nodes[0].stateReason).toBe(reason);
      const blocked = (issues[0].blockedBy?.nodes ?? []).some((b) => !(b.state === 'CLOSED' && b.stateReason === 'COMPLETED'));
      expect(placeByFacts({ state: 'OPEN', labels: ['size: 1'], pulls: [], points: 1, ceiling: 2, blocked }).lane).toBe(reason === 'COMPLETED' ? 'B1' : 'W1');
      await driver(io, []).sweep([issues[0]]);
      if (reason === 'COMPLETED') expect(io.writes).toHaveLength(0);
      else {
        expect(io.view(3698)?.labels.map((l) => l.name)).toContain('needs-human');
        expect(io.view(3698)?.comments.some((c) => c.body.includes('Blocked by #3697, which is closed not planned'))).toBe(true);
      }
    });
  }

  for (const reason of [undefined, null]) {
    it(`does not hand off an unknown close reason (${reason})`, async () => {
      const leaf = fakeIssue(3698, { labels: [{ name: 'size: 1' }], blockedBy: { nodes: [{ number: 3697, state: 'CLOSED', stateReason: reason }] } });
      const io = new FakeTracker(bot, [leaf]);
      await driver(io, []).sweep([leaf]);
      expect(io.writes).toHaveLength(0);
    });
  }
});

describe('an unreadable thread during the sweep', () => {
  it('costs that issue this sweep and lets the sweep reach the rest', async () => {
    const unreadable = fakeIssue(1, { labels: [{ name: 'loop/working' }] });
    const stale = fakeIssue(2, { labels: [{ name: 'loop/working' }] });
    const io = new FakeTracker(bot, [unreadable, stale]);
    const view = io.view.bind(io);
    io.view = (n: number) => {
      if (n === 1) throw new Error('could not list the comments on #1 through the REST api');
      return view(n);
    };
    await driver(io, []).sweep([unreadable, stale]);
    expect(view(2)?.labels.map((l) => l.name)).not.toContain('loop/working');
    expect(view(1)?.labels.map((l) => l.name)).toContain('loop/working');
  });
});

describe('pauses left by a closed trunk', () => {
  let id = 9000;
  const pause = (by: number) => ({ id: `c${id}`, databaseId: id++, author: bot, body: `<!-- carve-pause by=${by} gen=1 -->\nPaused by #${by}.`, createdAt: '2026-09-01T00:00:00Z' });
  const labelsOf = (io: FakeTracker, n: number) => io.view(n)!.labels.map((l) => l.name);
  // A (1) closed, B (2) open under it, C (3) under B.
  const world = (cPausedBy: number[]) => {
    const a = fakeIssue(1, { state: 'CLOSED', stateReason: 'COMPLETED', subIssues: [2] });
    const b = fakeIssue(2, { parentNumber: 1, subIssues: [3], labels: [{ name: 'loop/paused' }], comments: [pause(1)] });
    const c = fakeIssue(3, { parentNumber: 2, labels: [{ name: 'loop/paused' }], comments: cPausedBy.map(pause) });
    return { io: new FakeTracker(bot, [a, b, c]), open: [b, c] };
  };

  it("releases only the closed trunk's marker, and keeps the label while another trunk's pause stands", async () => {
    const { io, open } = world([1, 2]);
    await driver(io, []).sweep(open);
    expect(labelsOf(io, 3)).toContain('loop/paused');
    expect(io.view(3)!.comments.some((c) => c.body.startsWith('<!-- carve-unpause by=1 '))).toBe(true);
    expect(io.view(3)!.comments.some((c) => c.body.startsWith('<!-- carve-unpause by=2 '))).toBe(false);
    expect(labelsOf(io, 2)).not.toContain('loop/paused');
  });

  it('finishes on the next sweep a release whose write failed partway', async () => {
    const { io, open } = world([1]);
    io.throwOn = /unpause #3/;
    await driver(io, []).sweep(open);
    expect(labelsOf(io, 3)).toContain('loop/paused');
    await driver(io, []).sweep(open.map((i) => ({ ...i, labels: io.view(i.number)!.labels })));
    expect(labelsOf(io, 3)).not.toContain('loop/paused');
  });
});

describe('resume dispatch judges the lane under the claim before continuing', () => {
  const entry = { issue: { number: 92, title: 'resume', labels: [] }, pull: { number: 100, branch: 'fix/resume-92' } };
  function dispatch(kind: string, overrides: Record<string, unknown> = {}) {
    const calls: string[] = [];
    let holder: string | null = null;
    const api = loadFunctions('../loop.ts', ['resumePull'], {
      ctx: {}, MAX_POINTS: 2, SEATS: { confirmer: 'confirmer' }, isHostFaultKind,
      waitForGo: async () => { calls.push('wait'); },
      judgeLane: (_ctx: unknown, issue: number, readHead: () => string) => {
        calls.push('judge'); expect(issue).toBe(92); expect(readHead()).toBe('remote-head');
        return { kind, reason: 'lane reason' };
      },
      sh: (_ctx: unknown, args: string[]) => {
        expect(args).toEqual(['gh', 'pr', 'view', '100', '--json', 'headRefOid']);
        return JSON.stringify({ headRefOid: 'remote-head' });
      },
      parkForInspection: (_ctx: unknown, issue: number, reason: string) => {
        expect(issue).toBe(92); expect(reason).toBe('lane reason'); calls.push('park');
      },
      log: () => calls.push('log'), place: (...args: unknown[]) => { calls.push('place'); expect(args).toEqual([92, 'resume', 'W3', 'claim by elsewhere stands']); },
      lastObjection: (issue: number, pull: number) => { expect([issue, pull]).toEqual([92, 100]); calls.push('objection'); return 'revise'; },
      // The redrive as withLane runs it: the claim, then the caller's judgement under it, then the work.
      redriveIssue: async (_ctx: unknown, issue: unknown, pull: unknown, objection: string, options: { admit?: () => { outcome: string } | null }) => {
        expect([issue, pull, objection]).toEqual([entry.issue, entry.pull, 'revise']);
        calls.push('claim');
        if (holder) return { outcome: 'busy', reason: holder };
        const refused = options.admit?.();
        if (refused) return refused;
        calls.push('redrive'); return { outcome: 'merged' };
      },
      ...overrides,
    });
    return { run: () => api.resumePull(entry), calls, hold: (by: string) => { holder = by; } };
  }
  for (const kind of ['dirty', 'off-head', 'unreadable']) {
    for (const fails of [false, true]) it(`${kind} never continues, including a failed dead-letter write (${fails})`, async () => {
      const d = dispatch(kind, fails ? { parkForInspection: () => { throw new Error('write failed'); } } : {});
      await d.run();
      expect(d.calls.slice(0, 4)).toEqual(['wait', 'objection', 'claim', 'judge']);
      expect(d.calls).not.toContain('redrive');
      if (kind === 'unreadable') { expect(d.calls).not.toContain('park'); expect(d.calls).toContain('log'); }
      else if (!fails) expect(d.calls).toContain('park');
    });
  }
  for (const kind of ['no-lane', 'clean-at-head']) it(`${kind} continues with the objection`, async () => {
    const d = dispatch(kind);
    await d.run();
    expect(d.calls).toEqual(['wait', 'objection', 'claim', 'judge', 'redrive']);
  });
  it('queues a resume a host fault left unjudged to run again, as a host fault readmits Ready work', async () => {
    const reruns: unknown[] = [];
    const d = dispatch('clean-at-head', { RERUNS: reruns, redriveIssue: async () => ({ outcome: 'unjudged', reason: 'ENOSPC', fault: 'ENOSPC' }) });
    await d.run();
    expect(reruns).toEqual([{ kind: 'driverless', issue: entry.issue, pull: entry.pull }]);
    const stopped = dispatch('clean-at-head', { RERUNS: reruns, redriveIssue: async () => ({ outcome: 'unjudged', reason: 'stop', fault: 'stopped' }) });
    await stopped.run();
    expect(reruns).toHaveLength(1);
  });
  it('runs a stranded resume again after a host fault: from its kept lane after go, or as a driverless resume once the lane is gone', async () => {
    const stranded = { kind: 'stranded', issue: entry.issue, entry: { issue: entry.issue, cwd: '/kept', result: { issue: 92, verdict: 'fixed', reason: 'r', pr: 100, branch: 'fix/resume-92' } } };
    const run = async (lane: boolean, fault: string, item: Record<string, unknown> = stranded) => {
      const reruns: unknown[] = [];
      const calls: string[] = [];
      const api = loadFunctions('../loop.ts', ['resumeStranded'], {
        ctx: {}, MAX_POINTS: 2, RERUNS: reruns, log: noop, existsSync: () => lane, isHostFaultKind,
        waitForGo: async () => { calls.push('wait'); },
        resumeOneStranded: async () => { calls.push('resume'); return { outcome: 'unjudged', reason: 'r', fault }; },
      });
      await api.resumeStranded(item);
      return { reruns, calls };
    };
    expect((await run(true, 'ENOSPC')).reruns).toEqual([{ ...stranded, rerun: true }]);
    expect((await run(false, 'ENOMEM')).reruns).toEqual([{ kind: 'driverless', issue: entry.issue, pull: entry.pull }]);
    expect((await run(true, 'stopped')).reruns).toEqual([]);
    // A transport failure is the next run's, not a loop in this one while the tracker is down.
    expect((await run(true, 'transport')).reruns).toEqual([]);
    expect((await run(true, 'ENOSPC')).calls).toEqual(['resume']);
    expect((await run(true, 'ENOSPC', { ...stranded, rerun: true })).calls).toEqual(['wait', 'resume']);
  });
  it("does not judge or park a lane another run's claim holds; the card waits in W3", async () => {
    const d = dispatch('dirty');
    d.hold('claim by elsewhere stands');
    await d.run();
    expect(d.calls).toEqual(['wait', 'objection', 'claim', 'place']);
  });
  it('does not swallow a stop from judgeLane; the redrive settles it under its claim', async () => {
    const stop = new Error('stopping');
    const d = dispatch('dirty', { judgeLane: () => { throw stop; } });
    await expect(d.run()).rejects.toThrow(stop);
    expect(d.calls).not.toContain('park');
    expect(d.calls).not.toContain('redrive');
  });
});

it('claim and head read errors during a stop propagate even without RunStopping', () => {
  const stop = new Error('read interrupted');
  const deps = {
    isStopping: () => true, resolve: () => 'lane', existsSync: () => true,
    dirtyPaths: () => [], sh: () => 'head', trackerIo: () => ({}),
    readTree: () => { throw stop; }, liveClaim: noop,
  };
  const api = loadFunctions('../../fix-github-issue/lib/resume.ts', ['claimHolder', 'judgeLane'], deps);
  expect(() => api.claimHolder({}, 92, new Map())).toThrow(stop);
  expect(() => api.judgeLane({ project: {} }, 92, () => { throw stop; })).toThrow(stop);
});


describe('catch-up stop boundaries', () => {
  const pipeline = '../../fix-github-issue/lib/pipeline.ts';
  for (const name of ['catchUp', 'seamCatchUp']) {
    for (const stopAt of [1, 2, 3, 0]) it(`${name} refuses at gate ${stopAt}, or preserves a conflict without a stop`, async () => {
      let gates = 0;
      const acts: string[] = [];
      const api = loadFunctions(pipeline, [name], {
        yieldToStop: async () => { if (++gates === stopAt) throw new RunStopping('stop'); },
        fetchBase: () => { acts.push('fetch'); return 'base'; }, behindBase: () => ['file.ts'], behindOnlyByNoise: () => false,
        staleAgainstBase: () => [], sh: () => 'head', netChangeId: () => 'patch',
        move: () => acts.push('F2'), updateFromBase: () => { acts.push('merge'); return false; },
      });
      const args = [context(new FakeTracker(bot)), { number: 1 }, '/fake'];
      const result = name === 'catchUp' ? api[name](...args, 'head', noop, 'test') : api[name](...args, noop, 'test');
      if (stopAt) await expect(result).rejects.toBeInstanceOf(RunStopping);
      else expect(await result).toBe('conflict');
      expect(acts.includes('fetch')).toBe(stopAt !== 1);
      expect(acts.includes('merge')).toBe(stopAt === 0 || stopAt === 3);
      expect(acts.includes('F2')).toBe(name === 'catchUp' && (stopAt === 0 || stopAt === 3));
    });
    for (const behind of [false, true]) it(`${name} preserves ${behind ? 'pushed' : 'current'} results without a trailing yield`, async () => {
      let gates = 0;
      const api = loadFunctions(pipeline, [name], {
        yieldToStop: async () => { if (++gates > 2) throw new RunStopping('after push'); },
        fetchBase: () => 'base', behindBase: () => behind ? ['file.ts'] : [], behindOnlyByNoise: () => false,
        staleAgainstBase: () => [], sh: () => 'head', netChangeId: () => 'patch', move: noop, updateFromBase: () => true,
      });
      const args = [context(new FakeTracker(bot)), { number: 1 }, '/fake'];
      const result = await (name === 'catchUp' ? api[name](...args, 'head', noop, 'test') : api[name](...args, noop, 'test'));
      expect(result).toEqual(name === 'seamCatchUp' ? (behind ? 'caught-up' : 'current') : behind ? { before: 'head', after: 'head', overlap: [], netChangeIntact: true } : null);
      expect(gates).toBe(behind ? 2 : 1);
    });
  }
  for (const stopped of [true, false]) it(`a review conflict ${stopped ? 'stops before' : 'reaches'} the dead letter`, async () => {
    const acts: string[] = [];
    let gates = 0;
    const api = loadFunctions(pipeline, ['reviewAndLand', 'catchUp'], {
      reviewCount: () => 0, sh: () => 'head', fetchBase: () => 'base', behindBase: () => ['file.ts'], behindOnlyByNoise: () => false,
      staleAgainstBase: () => [], netChangeId: () => 'patch', move: noop, updateFromBase: () => false,
      yieldToStop: async () => { if (++gates === 3 && stopped) throw new RunStopping('stop'); },
      deadLetter: () => acts.push('deadLetter'), mutate: () => acts.push('ready'),
    });
    const ctx = context(new FakeTracker(bot)); ctx.knobs.maxReviewRounds = 3;
    const result = api.reviewAndLand(ctx, { number: 1, labels: [] }, '/fake', { pr: 7 }, 2, noop);
    if (stopped) await expect(result).rejects.toBeInstanceOf(RunStopping);
    else await result;
    expect(acts).toEqual(stopped ? [] : ['deadLetter']);
  });
  it('a conflict stop unwinds a rejected landing before the ready flip', async () => {
    const acts: string[] = [];
    let gates = 0;
    const api = loadFunctions(pipeline, ['land', 'catchUp'], {
      DEFAULT_MAX_POINTS: 2, sh: () => 'head', fetchBase: () => 'base', behindBase: () => ['file.ts'], behindOnlyByNoise: () => false,
      staleAgainstBase: () => [], netChangeId: () => 'patch', move: noop, updateFromBase: () => false,
      yieldToStop: async () => { if (++gates === 3) throw new RunStopping('stop'); },
      mutate: (_ctx: unknown, _why: string, argv: string[]) => acts.push(argv.includes('--undo') ? 'draft' : 'ready'),
    });
    await expect(api.land(context(new FakeTracker(bot)), { number: 1 }, 7, [], { review: { decision: 'block' }, reviewedSha: 'head' }, '/fake', noop)).rejects.toBeInstanceOf(RunStopping);
    expect(acts).toEqual(['draft']);
  });
  it('a seam conflict stop returns no worker failure and counts no attempt', async () => {
    let gates = 0;
    const acts: string[] = [];
    const api = loadFunctions(pipeline, ['runWorker', 'seamCatchUp'], {
      placeWork: () => ({ kind: 'prove', coded: { branch: 'fix/x', sha: 'head', gated: 'head' }, sha: 'head', handoff: 'h' }),
      fetchBase: () => 'base', behindBase: () => ['file.ts'], updateFromBase: () => false, behindOnlyByNoise: () => false,
      yieldToStop: async () => { if (++gates === 3) throw new RunStopping('stop'); },
      recordAttempt: () => acts.push('attempt'), runProve: () => acts.push('prove'), move: noop,
    });
    await expect(api.runWorker(context(new FakeTracker(bot)), { number: 1, title: 't', labels: [] }, '/fake', 2)).rejects.toBeInstanceOf(RunStopping);
    expect(acts).toEqual([]);
  });
});

describe('release noise at every catch-up', () => {
  const pipeline = '../../fix-github-issue/lib/pipeline.ts';
  // A release commit: a configured changelog and a version-only package.json bump. `beyond` is what `behindBeyondNoise` leaves.
  const load = (name: string, beyond: string[], upToDateRequired: boolean, merges: string[]) =>
    loadFunctions(pipeline, [name, 'behindOnlyByNoise'], {
      fetchBase: () => 'base', behindBase: () => ['CHANGELOG.md', 'package.json'], behindBeyondNoise: () => beyond,
      requiresUpToDate: () => upToDateRequired, staleAgainstBase: () => [], sh: () => 'head', netChangeId: () => 'patch', move: noop,
      updateFromBase: () => { merges.push('merge'); return true; },
    });
  const run = (api: any, name: string, options?: { skipNoise?: boolean }) => {
    const args = [context(new FakeTracker(bot)), { number: 1 }, '/fake'];
    return name === 'catchUp' ? api.catchUp(...args, 'head', noop, 'before the redrive', options) : api.seamCatchUp(...args, noop, 'before proving');
  };

  for (const name of ['catchUp', 'seamCatchUp']) {
    it(`${name} pushes no head for a base moved only by release noise`, async () => {
      const merges: string[] = [];
      expect(await run(load(name, [], false, merges), name)).toEqual(name === 'catchUp' ? null : 'current');
      expect(merges).toEqual([]);
    });
    it(`${name} catches up on release noise when the base requires an up-to-date branch`, async () => {
      const merges: string[] = [];
      await run(load(name, [], true, merges), name);
      expect(merges).toEqual(['merge']);
    });
    it(`${name} catches up when the release commit also changed a dependency`, async () => {
      const merges: string[] = [];
      await run(load(name, ['package.json'], false, merges), name);
      expect(merges).toEqual(['merge']);
    });
  }
  it('a landing that already read the protection does not read it again', async () => {
    const merges: string[] = [];
    let reads = 0;
    const api = loadFunctions(pipeline, ['catchUp', 'behindOnlyByNoise'], {
      fetchBase: () => 'base', behindBase: () => ['CHANGELOG.md'], behindBeyondNoise: () => [],
      requiresUpToDate: () => { reads += 1; return true; }, staleAgainstBase: () => [], sh: () => 'head', netChangeId: () => 'patch', move: noop,
      updateFromBase: () => { merges.push('merge'); return true; },
    });
    expect(await run(api, 'catchUp', { skipNoise: true })).toBeNull();
    await run(api, 'catchUp', { skipNoise: false });
    expect(merges).toEqual(['merge']);
    expect(reads).toBe(0);
  });
});

describe("an incident's owner after its fix ran", () => {
  const handle = (outcome: string, labels: string[]) => {
    let reads = 0;
    const api = loadFunctions('./floor/incident.ts', ['handleIncident', 'ownedNow'], {
      gather: () => ({ lastGood: undefined, suspects: [], logs: '' }),
      openIncidentFor: () => (++reads === 1 ? null : { number: 31, withAPerson: labels.length > 0 }),
      causeOf: () => 'in-repository', incidentTitle: () => 'floor: x is absent', renderSuspects: () => '', ensureIncidentLabel: noop, ensureLabels: noop,
      INCIDENT_LABEL, sh: (_ctx: unknown, argv: string[]) => (argv[2] === 'create' ? 'https://github.com/o/r/issues/31' : '{"number":31,"labels":[]}'),
      enrichBlockers: noop, parkIssue: noop,
      fixIssue: async () => ({ outcome, reason: 'r' }),
    });
    const entry = { itemId: 'pull-request:7', checkedAt: '2026-11-20T00:00:00Z', rung: 'exercise', verdict: 'absent', reason: 'r' };
    return api.handleIncident(context(new FakeTracker(bot)), { entry, maxPoints: 2, diagnosis: { culprit: null, confidence: 'likely', error: '', remedy: 'fix-forward', summary: 's' } });
  };

  it('is with a person only when the tracker says so, never because the fix did not merge', async () => {
    for (const outcome of ['unjudged', 'busy', 'stopped']) expect((await handle(outcome, [])).withAPerson).toBe(false);
    expect((await handle('handed-off', ['needs-human'])).withAPerson).toBe(true);
    expect((await handle('dlq', ['loop/dlq'])).withAPerson).toBe(true);
    expect((await handle('merged', [])).withAPerson).toBe(false);
  });
});

describe('a prover that needs a person', () => {
  const pipeline = '../../fix-github-issue/lib/pipeline.ts';
  const legal = (a: string, b: string) => a === b || successors(laneState(a), { ownEventsOnly: true }).has(laneState(b));
  const settle = (seat: 'coder' | 'prover', pr: number | undefined, extra: Record<string, unknown> = {}) => {
    const writes: string[][] = [];
    const lanes: string[] = [];
    const api = loadFunctions(pipeline, ['settleTerminalVerdict', 'holdForAPerson'], {
      mutate: (_ctx: unknown, _d: unknown, argv: string[]) => writes.push(argv),
      move: (_ctx: unknown, _issue: unknown, lane: string) => lanes.push(lane),
      proofHeldComment, heldComment, loopNote, liveGate: () => ({ ok: true }), settleOutsideStop,
    });
    // The settlement writes through the context's tracker, into the same list.
    const ctx = { ...context(new FakeTracker(bot)), io: { write: (op: { argv: string[] }) => writes.push(op.argv) }, dryRun: false, runId: 'run-1' };
    const result = { issue: 1, verdict: 'needs-human', reason: 'the signed-in probe needs the shared test credentials', branch: 'fix/probe-1', pr, seat, ...extra };
    return api.settleTerminalVerdict(ctx, { number: 1, title: 't', labels: [] }, result, 2, noop, pr).then((outcome: unknown) => ({ outcome, writes, lanes }));
  };

  it('leaves the pull request open, labels it and the issue needs-human, and says on the issue how the hold comes off', async () => {
    const { outcome, writes, lanes } = await settle('prover', 7);
    expect(outcome).toEqual({ outcome: 'handed-off', reason: 'the signed-in probe needs the shared test credentials' });
    expect(writes.filter((argv: string[]) => argv[1] === 'pr' && argv[2] === 'close')).toEqual([]);
    expect(writes).toContainEqual(['gh', 'issue', 'edit', '1', '--add-label', 'needs-human']);
    expect(writes).toContainEqual(['gh', 'pr', 'edit', '7', '--add-label', 'needs-human']);
    const hold = writes.find((argv: string[]) => argv[1] === 'issue' && argv[2] === 'comment')?.at(-1) ?? '';
    expect(standingStop([{ author: bot, body: hold }], bot)).toEqual({ kind: 'proof-held' });
    expect(hold).toContain('pull request #7 stays open');
    expect(hold).toContain('the shared test credentials');
    // The pointer on the pull request is the loop's word, marked as such.
    const pointer = writes.find((argv: string[]) => argv[1] === 'pr' && argv[2] === 'comment' && argv[3] === '7')?.at(-1) ?? '';
    expect(pointer.startsWith(LOOP_NOTE)).toBe(true);
    expect(pointer).toContain('#1');
    expect(lanes).toEqual(['H2']);
    expect(legal('D2', 'H2')).toBe(true);
  });

  it('with no pull request opened, holds the issue alone and names the coded branch', async () => {
    const { writes, lanes } = await settle('prover', undefined);
    expect(writes.filter((argv: string[]) => argv[1] === 'pr')).toEqual([]);
    expect(writes).toContainEqual(['gh', 'issue', 'edit', '1', '--add-label', 'needs-human']);
    expect(writes.find((argv: string[]) => argv[2] === 'comment')?.at(-1)).toContain('the coded commit stays on `fix/probe-1`');
    expect(lanes).toEqual(['H2']);
  });

  it("holds a coder's needs-human on a pull request it was continuing open, as a draft, instead of closing it", async () => {
    const { outcome, writes, lanes } = await settle('coder', 7);
    expect(outcome).toEqual({ outcome: 'handed-off', reason: 'the signed-in probe needs the shared test credentials' });
    expect(writes.filter((argv: string[]) => argv[1] === 'pr' && argv[2] === 'close')).toEqual([]);
    expect(writes).toContainEqual(['gh', 'pr', 'ready', '7', '--undo']);
    expect(writes).toContainEqual(['gh', 'pr', 'edit', '7', '--add-label', 'needs-human']);
    expect(writes).toContainEqual(['gh', 'issue', 'edit', '1', '--add-label', 'needs-human']);
    const record = writes.find((argv: string[]) => argv[1] === 'issue' && argv[2] === 'comment')?.at(-1) ?? '';
    const stop = standingStop([{ author: bot, body: record }], bot);
    expect(stop).toMatchObject({ kind: 'outside', cause: 'needs-person', seat: 'coder' });
    // Lifting the hold continues the work: the hold is the loop's, and the coder gets its words back.
    expect(loopHoldStands(stop)).toBe(true);
    expect(objectionAfter(stop)).toContain('the shared test credentials');
    expect(lanes).toEqual(['H2']);
  });

  it('names a gate that fails on the untouched base as the cause', async () => {
    const { writes } = await settle('coder', 7, { outside: 'base' });
    const record = writes.find((argv: string[]) => argv[1] === 'issue' && argv[2] === 'comment')?.at(-1) ?? '';
    expect(stopIn(record)?.fields.cause).toBe('base');
    expect(record).toContain('untouched base');
  });

  it("closes nothing and holds the issue alone for a coder's needs-human with no pull request", async () => {
    const { writes, lanes } = await settle('coder', undefined);
    expect(writes.filter((argv: string[]) => argv[1] === 'pr')).toEqual([]);
    expect(standingStop([{ author: bot, body: writes.find((argv: string[]) => argv[2] === 'comment')?.at(-1) ?? '' }], bot)?.kind).toBe('held');
    expect(lanes).toEqual(['H2']);
  });

  it("reads a coder's needs-human after a held proof as the standing stop, so a redrive lifts no needs-human", async () => {
    const held = (await settle('prover', 7)).writes.find((argv: string[]) => argv[2] === 'comment')?.at(-1) ?? '';
    const asked = (await settle('coder', undefined)).writes.find((argv: string[]) => argv[1] === 'issue' && argv[2] === 'comment')?.at(-1) ?? '';
    const stop = standingStop([{ author: bot, body: held }, { author: bot, body: asked }], bot);
    expect(stop?.kind).toBe('held');
    expect(loopHoldStands(stop)).toBe(false);
    expect(standingStop([{ author: bot, body: asked }, { author: bot, body: held }], bot)?.kind).toBe('proof-held');
  });

  it('is proved again on the same pull request once a person lifts the hold: the burndown reads no objection', () => {
    const thread = [
      { author: bot, body: 'Moved to the work dead-letter queue.\n\nan older stop' },
      { author: bot, body: proofHeldComment('run-1', { branch: 'fix/probe-1', pr: 7 }, 'needs the shared test credentials; parked until then') },
    ];
    let reads = 0;
    const api = loadFunctions('../loop.ts', ['lastObjection'], {
      ctx: { botLogin: bot }, standingStop, objectionAfter,
      sh: () => (++reads === 1 ? '2026-09-20T00:00:00Z' : JSON.stringify(thread)),
    });
    expect(api.lastObjection(1, 7)).toBeNull();
    reads = 0;
    thread.push({ author: bot, body: 'Parked: the merge boundary refused it.' });
    expect(api.lastObjection(1, 7)).toBe('Parked: the merge boundary refused it.');
  });

  it('a lifted hold puts the card back with its pull request, and the resume reaches Proving', () => {
    const lane = placeByFacts({ state: 'OPEN', labels: ['size: 1'], pulls: [{ number: 7, isDraft: true, merged: false }], ceiling: 2 });
    expect(lane.lane).toBe('D3');
    const card = new Card('held', laneState('D2'));
    card.send('WORKER_VERDICT', (g: string) => g === 'verdictNeedsHuman');
    expect(card.lane).toBe('H2');
    expect(card.actions).toContain('labelPrHold');
    card.send('HOLD_REMOVED', (g: string) => g === 'draftPr');
    expect(card.lane).toBe('D3');
    card.send('RESUMED', () => false);
    expect(card.lane).toBe('D2');
    expect(card.actions.slice(-4)).toEqual(['liftPrHoldMirror', 'prToDraft', 'runProver', 'moveCard']);
  });

  const redrive = (thread: Array<{ author: string; body: string; createdAt?: string }>, opened = 'h') => {
    const writes: string[][] = [];
    const reproofs: boolean[] = [];
    const api = loadFunctions(pipeline, ['claimLane', 'withLane', 'redriveIssue'], {
      DEFAULT_MAX_POINTS: 2, ceilingFor: (_l: unknown, _p: unknown, c: number) => c, labelPoints: () => null, assertDistinctEngines: noop, liveGate: () => ({ ok: true }),
      trackerIo: () => ({ view: () => ({ comments: thread }) }), standingStop, loopHoldStands, pullHolds: () => ['needs-human'],
      claim: async () => ({ release: noop }), keepClaimed: () => noop, worktreeAtPullRequest: () => '/fake',
      inFlight: new Map(), isDraft: () => true, sh: (_ctx: unknown, argv: string[]) => (argv.includes('createdAt') ? opened : 'h'), catchUp: () => null,
      mutate: (_ctx: unknown, _d: unknown, argv: string[]) => writes.push(argv),
      runWorker: async (_c: unknown, _i: unknown, _cwd: unknown, _max: unknown, _feedback: unknown, reproof: boolean) => {
        reproofs.push(reproof);
        return { verdict: 'failed', reason: 'stop after recording the seat' };
      }, countFailure: () => ({ outcome: 'dlq' }), removeWorktree: noop,
    });
    return api.redriveIssue(context(new FakeTracker(bot)), { number: 1, title: 'issue' }, { number: 7, branch: 'fix/probe-1' }, null).then(() => ({ writes, reproofs }));
  };

  it("takes the pull request's needs-human off with the issue's when the held proof is the standing stop, and proves", async () => {
    const { writes, reproofs } = await redrive([{ author: bot, body: proofHeldComment('run-1', { branch: 'fix/probe-1', pr: 7 }, 'needs credentials') }]);
    expect(writes).toContainEqual(['gh', 'pr', 'edit', '7', '--remove-label', 'needs-human']);
    expect(reproofs).toEqual([true]);
  });

  it('reads the stop since the pull request opened: a held proof from an earlier attempt lifts nothing', async () => {
    const { writes } = await redrive([{ author: bot, body: proofHeldComment('run-1', { branch: 'fix/probe-1' }, 'needs credentials'), createdAt: '2026-09-01T00:00:00Z' }], '2026-09-02T00:00:00Z');
    expect(writes.filter((argv: string[]) => argv.includes('--remove-label'))).toEqual([]);
  });

  it("leaves a person's needs-human on the pull request when something else stopped the work last", async () => {
    const { writes } = await redrive([
      { author: bot, body: proofHeldComment('run-1', { branch: 'fix/probe-1', pr: 7 }, 'needs credentials') },
      { author: bot, body: 'Parked: pull request #7 carries `needs-human`.' },
    ]);
    expect(writes.filter((argv: string[]) => argv.includes('--remove-label'))).toEqual([]);
  });

  it('refuses the merge while needs-human is on the pull request, whatever the issue carries', async () => {
    const writes: string[][] = [];
    const ctx = context(new FakeTracker(bot));
    const api = loadFunctions(pipeline, ['land', 'mergeCommitOf', 'landedOnUnseenBase'], {
      DEFAULT_MAX_POINTS: 2, MAX_BASE_REFRESHES: 2, effectiveTouches: () => ['code'], mergeAllowed: () => true, boundaryWaived: () => false,
      sh: (_ctx: unknown, argv: string[]) => (argv[1] === 'rev-parse' ? (argv.at(-1) === 'origin/main' ? 'A' : 'h') : ''),
      catchUp: () => null, pullRequestMatchesReview: async () => null,
      behindBase: () => [], behindBeyondNoise: () => [], requiresUpToDate: () => false,
      fetchBase: () => 'A', checksOn: () => ({ names: ['ci'], passed: ['ci'] }), requiredStatusChecks: () => ['ci'],
      awaitGreenChecks: async () => null, move: noop, liveGate: () => ({ ok: true }), trackerIo: noop,
      pullHolds: () => ['needs-human'],
      mutate: (_ctx: unknown, _d: unknown, argv: string[]) => writes.push(argv), followBase: noop, removeWorktree: noop, closeIssue: async () => {},
    });
    const outcome = await api.land(ctx, { number: 1 }, 7, ['code'], { review: { decision: 'merge' }, reviewedSha: 'h' }, '/fake', noop);
    expect(outcome).toEqual({ park: expect.stringContaining('pull request #7 carries `needs-human`') });
    expect(writes.filter((argv: string[]) => argv[2] === 'merge')).toEqual([]);
    expect(successors(laneState('F5'), { ownEventsOnly: true }).has(laneState('H3'))).toBe(true);
  });
});

describe('a pull request merged while its landing watched', () => {
  const pipeline = '../../fix-github-issue/lib/pipeline.ts';
  it('ends the wait, merges nothing itself, and records the merge once: the card, the floor, and the close', async () => {
    const writes: string[][] = [];
    const lanes: string[] = [];
    const floor: Array<[number, string]> = [];
    const closes: number[] = [];
    const ctx = context(new FakeTracker(bot));
    ctx.afterMerge = (event) => floor.push([event.pr, event.sha]);
    const { recordMerge } = loadFunctions('../../fix-github-issue/lib/record-merge.ts', ['recordMerge'], {
      closeIssue: async (_ctx: unknown, issue: number) => { closes.push(issue); }, parkIssue: noop,
    });
    const api = loadFunctions(pipeline, ['land', 'mergeCommitOf', 'landedOnUnseenBase'], {
      DEFAULT_MAX_POINTS: 2, MAX_BASE_REFRESHES: 2, effectiveTouches: () => ['code'], mergeAllowed: () => true, boundaryWaived: () => false,
      sh: (_ctx: unknown, argv: string[]) => (argv[1] === 'rev-parse' ? (argv.at(-1) === 'origin/main' ? 'A' : 'h') : argv.includes('mergedAt') ? '2026-11-21T11:11:04Z' : argv.includes('mergeCommit') ? 'm'.repeat(40) : ''),
      catchUp: () => null, pullRequestMatchesReview: async () => null,
      behindBase: () => [], behindBeyondNoise: () => [], requiresUpToDate: () => false,
      fetchBase: () => 'A', checksOn: () => ({ names: ['ci'], passed: ['ci'] }), requiredStatusChecks: () => ['ci'],
      // A person merged it by hand while a third-party check sat queued.
      awaitGreenChecks: async () => ({ ended: 'MERGED', head: 'h' }),
      move: (_ctx: unknown, _issue: unknown, lane: string) => lanes.push(lane), liveGate: () => ({ ok: true }), trackerIo: noop,
      mutate: (_ctx: unknown, _d: unknown, argv: string[]) => writes.push(argv), followBase: noop, removeWorktree: noop, recordMerge,
    });
    const outcome = await api.land(ctx, { number: 1, title: 'a fix' }, 7, ['code'], { review: { decision: 'merge' }, reviewedSha: 'h' }, '/fake', noop);
    expect(outcome).toBe('merged');
    expect(writes.filter((argv) => argv[1] === 'pr' && argv[2] === 'merge')).toEqual([]);
    expect(lanes.at(-1)).toBe('T1');
    // The floor watches the merge commit a deploy on push builds, not the pull request's head.
    expect(floor).toEqual([[7, 'm'.repeat(40)]]);
    expect(closes).toEqual([1]);
    // The next run start finds the issue closed and records nothing twice.
    const again = await recordMerge(ctx, { issue: 1, title: 'a fix', pr: 7, sha: 'h', mergedAt: '', paths: [] }, { place: noop, note: '', by: 'reconcile', comment: '', reason: '', isOpen: () => false });
    expect(again).toBe('already-closed');
    expect(closes).toEqual([1]);
  });

  it('parks a pull request closed while its checks were waited on', async () => {
    const ctx = context(new FakeTracker(bot));
    const api = loadFunctions(pipeline, ['land', 'mergeCommitOf', 'landedOnUnseenBase'], {
      DEFAULT_MAX_POINTS: 2, MAX_BASE_REFRESHES: 2, effectiveTouches: () => ['code'], mergeAllowed: () => true, boundaryWaived: () => false,
      sh: (_ctx: unknown, argv: string[]) => (argv[1] === 'rev-parse' ? (argv.at(-1) === 'origin/main' ? 'A' : 'h') : ''),
      catchUp: () => null, pullRequestMatchesReview: async () => null,
      behindBase: () => [], behindBeyondNoise: () => [], requiresUpToDate: () => false,
      fetchBase: () => 'A', checksOn: () => ({ names: ['ci'], passed: ['ci'] }), requiredStatusChecks: () => ['ci'],
      awaitGreenChecks: async () => ({ ended: 'CLOSED', head: 'h' }), move: noop, liveGate: () => ({ ok: true }), trackerIo: noop, mutate: noop,
    });
    expect(await api.land(ctx, { number: 1 }, 7, ['code'], { review: { decision: 'merge' }, reviewedSha: 'h' }, '/fake', noop)).toEqual({ park: 'pull request #7 was closed while its checks were waited on' });
  });

  it('is found at the next run start when it references its issue with Refs, as the loop\'s own pull requests do', async () => {
    const recorded: Array<{ issue: number; pr: number; by: string }> = [];
    const issue = { number: 42, title: 'a leaf', labels: [{ name: 'size: 1' }], blockedBy: { nodes: [] } };
    const merged = (over: Record<string, unknown>) => ({ number: 70, title: 'fix: a leaf', body: 'Refs #42', headRefName: 'fix/a-leaf-42', mergedAt: '2026-11-21T11:00:00Z', mergeCommit: { oid: 'm'.repeat(40) }, files: [{ path: 'src/a.ts' }], author: { login: bot }, ...over });
    const run = async (pulls: unknown[]) => {
      recorded.length = 0;
      const api = loadFunctions('../loop.ts', ['reconcileMergedPullRequests', 'resolvedBy', 'notALeafLabel'], {
        ctx: { botLogin: bot }, mergedPullRequests: () => pulls, log: noop, trackerIo: noop, issueRefs,
        isHeldBy: () => false, HOLD_LABELS: [], CONFIG: { skipLabels: [] }, looksLikeTrunk: () => false, pointsFromLabels: () => 1,
        DRY_RUN: false, threadOf: () => ({}), refusal: () => null, NOT_A_LEAF: [], MAX_POINTS: 2, place: noop,
        recordMerge: async (_ctx: unknown, merge: { issue: number; pr: number }, record: { by: string }) => { recorded.push({ issue: merge.issue, pr: merge.pr, by: record.by }); return 'closed'; },
      });
      await api.reconcileMergedPullRequests([issue]);
      return recorded.slice();
    };
    expect(await run([merged({})])).toEqual([{ issue: 42, pr: 70, by: 'reconcile' }]);
    // Somebody else's pull request that only refers to the issue did not resolve it.
    expect(await run([merged({ author: { login: 'someone' } })])).toEqual([]);
    // A closing keyword still counts, whoever opened it.
    expect(await run([merged({ author: { login: 'someone' }, body: 'Fixes #42', headRefName: 'patch' })])).toEqual([{ issue: 42, pr: 70, by: 'reconcile' }]);
  });
});

describe('a landing on an approval that still stands at the head', () => {
  const pipeline = '../../fix-github-issue/lib/pipeline.ts';
  const approved = (sha: string, touches = 'code') => ({ author: bot, body: stopComment('approved', { sha, pr: 7, touches }, `**Approved** at \`${sha}\` on pull request #7; landing next.`), createdAt: '2026-11-21T02:02:00Z' });
  const boundary = { author: bot, body: stopComment('boundary', {}, 'autoMerge is code-only and the change touches migration'), createdAt: '2026-11-21T02:03:00Z' };
  /** A redrive with no objection (`--land`, or a continuation) of PR #7, whose lane and remote head are `head`. */
  const land = async (thread: Array<{ author: string; body: string; createdAt?: string }>, over: { head?: string; behind?: string[]; checks?: string | null; draft?: boolean } = {}) => {
    const writes: string[][] = [];
    const seats: string[] = [];
    let standing: { reviewedSha: string; review: { touches?: string[] } } | undefined;
    const head = over.head ?? 'H';
    const sh = (_ctx: unknown, argv: string[]) => {
      if (argv.includes('createdAt')) return '2026-11-21T00:23:00Z';
      if (argv.includes('headRefOid,isDraft')) return JSON.stringify({ headRefOid: head, isDraft: over.draft ?? false });
      return head;
    };
    const { validTouches } = loadFunctions(pipeline, ['validTouches'], { TOUCH_KINDS: ['code', 'data', 'migration', 'stored-string', 'ci'] });
    const api = loadFunctions(pipeline, ['claimLane', 'withLane', 'redriveIssue', 'approvedAtHead'], {
      DEFAULT_MAX_POINTS: 2, ceilingFor: (_l: unknown, _p: unknown, c: number) => c, labelPoints: () => null, assertDistinctEngines: noop, liveGate: () => ({ ok: true }),
      trackerIo: () => ({ view: () => ({ comments: thread }) }), standingStop, standingApproval, loopHoldStands, validTouches,
      claim: async () => ({ release: noop }), keepClaimed: () => noop, worktreeAtPullRequest: () => '/fake',
      inFlight: new Map(), isDraft: () => over.draft ?? false, sh, catchUp: () => null, move: noop,
      fetchBase: () => 'B', requiresUpToDate: () => false, behindBase: () => over.behind ?? [], behindBeyondNoise: () => over.behind ?? [],
      checksOn: () => ({ names: ['ci'], passed: ['ci'] }), requiredStatusChecks: () => ['ci'],
      awaitGreenChecks: async () => (over.checks === undefined ? null : over.checks),
      mutate: (_ctx: unknown, _d: unknown, argv: string[]) => writes.push(argv),
      runWorker: async () => { seats.push('prover'); return { verdict: 'failed', reason: 'stop after recording the seat' }; },
      countFailure: () => ({ outcome: 'dlq' }), removeWorktree: noop,
      reviewAndLand: async (_c: unknown, _i: unknown, _cwd: unknown, _first: unknown, _max: unknown, _say: unknown, _ceiling: unknown, given?: typeof standing) => { standing = given; return { outcome: 'merged', reason: 'merged' }; },
    });
    const ctx = context(new FakeTracker(bot));
    await api.redriveIssue(ctx, { number: 1, title: 'a migration', labels: [] }, { number: 7, branch: 'fix/migration-1' }, null, { landing: true });
    return { writes, seats, standing, undrafted: writes.some((argv) => argv.join(' ') === 'gh pr ready 7 --undo') };
  };

  it('goes straight to the landing: no draft, no proof, no review', async () => {
    const { undrafted, seats, standing } = await land([approved('H'), boundary]);
    expect(undrafted).toBe(false);
    expect(seats).toEqual([]);
    expect(standing).toMatchObject({ reviewedSha: 'H', review: { decision: 'merge', touches: ['code'] } });
  });

  it('stands through an outside stop that reruns the work, as a transport failure in the landing', async () => {
    const outside = { author: bot, body: stopComment('outside', { cause: 'transport', seat: 'landing' }, 'stopped'), createdAt: '2026-11-21T03:29:00Z' };
    expect((await land([approved('H'), outside])).standing?.reviewedSha).toBe('H');
  });

  for (const [what, thread, over] of [
    ['the head moved since the approval', [approved('H')], { head: 'H2' }],
    ['the approval is for another commit', [approved('G')], {}],
    ['the base moved beyond release noise', [approved('H')], { behind: ['src/a.ts'] }],
    ['the checks are not green by any run', [approved('H')], { checks: 'checks failed: ci (FAILURE)' }],
    ['the pull request is a draft', [approved('H')], { draft: true }],
    ['the approval named no classification', [approved('H', '')], {}],
    ['a dead letter came after the approval', [approved('H'), { author: bot, body: stopComment('dead-letter', { phase: 'landing' }, 'checks failed'), createdAt: '2026-11-21T03:00:00Z' }], {}],
  ] as const) {
    it(`keeps the usual path when ${what}`, async () => {
      const { undrafted, seats, standing } = await land(thread as never, over as never);
      expect(standing).toBeUndefined();
      // Back to draft for the proof, unless it already was one.
      expect(undrafted).toBe(!(over as { draft?: boolean }).draft);
      expect(seats).toEqual(['prover']);
    });
  }
});

describe('a landing on a standing approval with the review budget spent', () => {
  const pipeline = '../../fix-github-issue/lib/pipeline.ts';
  const run = (standing?: unknown) => {
    const ctx = context(new FakeTracker(bot)); ctx.knobs.maxReviewRounds = 3;
    const calls: string[] = [];
    const api = loadFunctions(pipeline, ['reviewAndLand'], {
      reviewCount: () => 3, sh: () => 'h', catchUp: () => null, move: noop, mutate: noop, MAX_BASE_REFRESHES: 3,
      review: async () => { calls.push('review'); return { review: { decision: 'merge', blocking: [] }, reviewedSha: 'h' }; },
      serializePullMaster: (_ctx: unknown, _issue: unknown, _say: unknown, action: () => unknown) => action(),
      land: async () => { calls.push('land'); return 'merged'; },
      deadLetter: (_ctx: unknown, _issue: unknown, phase: string) => { calls.push(`dlq:${phase}`); return { outcome: 'dlq' }; },
    });
    return api.reviewAndLand(ctx, { number: 1, labels: [] }, '/fake', { pr: 7, touches: ['code'] }, 2, noop, 2, standing).then((result: { outcome: string }) => ({ result, calls }));
  };
  it('lands: it runs no review, so the spent budget does not stop it', async () => {
    const { result, calls } = await run({ review: { pr: 7, decision: 'merge', blocking: [], touches: ['code'] }, reviewedSha: 'h' });
    expect(result.outcome).toBe('merged');
    expect(calls).toEqual(['land']);
  });
  it('still dead-letters a path that would review', async () => {
    expect((await run()).calls).toEqual(['dlq:review']);
  });
});

describe('withLane judges what is on disk under its claim', () => {
  const pipeline = '../../fix-github-issue/lib/pipeline.ts';
  const run = (admit: () => unknown) => {
    const calls: string[] = [];
    const api = loadFunctions(pipeline, ['claimLane', 'withLane'], {
      trackerIo: noop, liveGate: () => ({ ok: true }), inFlight: new Map(),
      claim: async () => { calls.push('claim'); return { release: () => calls.push('release') }; },
      keepClaimed: () => () => calls.push('lease ends'),
      retireLane: () => calls.push('retire'),
      recordThrow: (_c: unknown, _i: unknown, error: Error) => { calls.push(`record ${error.message}`); return { outcome: { outcome: 'stopped', reason: error.message }, keepLane: true }; },
    });
    const lane = { ceiling: 2, pr: 7, admit: () => { calls.push('admit'); return admit(); }, open: () => { calls.push('open'); return '/lane'; } };
    return api.withLane(context(new FakeTracker(bot)), { number: 1 }, noop, lane, async () => { calls.push('work'); return { outcome: 'merged', reason: 'm' }; }).then((outcome: unknown) => ({ outcome, calls }));
  };
  it('a refusal is the outcome: nothing opened or worked, the claim released, and the lane kept', async () => {
    const { outcome, calls } = await run(() => ({ outcome: 'left-alone', reason: 'dirty' }));
    expect(outcome).toEqual({ outcome: 'left-alone', reason: 'dirty' });
    expect(calls).toEqual(['claim', 'admit', 'lease ends', 'release']);
  });
  it('an admitted lane is opened, worked, and retired', async () => {
    const { calls } = await run(() => null);
    expect(calls).toEqual(['claim', 'admit', 'open', 'work', 'lease ends', 'release', 'retire']);
  });
  it('a throw from the judgement is settled as this lane\'s, under the claim', async () => {
    const { outcome, calls } = await run(() => { throw new Error('stop'); });
    expect(outcome).toEqual({ outcome: 'stopped', reason: 'stop' });
    expect(calls).toEqual(['claim', 'admit', 'record stop', 'lease ends', 'release']);
  });
});

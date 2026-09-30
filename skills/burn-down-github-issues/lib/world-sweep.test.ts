import { describe, expect, it } from 'bun:test';
import { LANES } from './lanes.ts';
import { transitions, walk, MACHINE } from './machine.ts';
import { atoms, Card, fire, handles, laneKey, laneState, successors } from './simulate.ts';
import { CLAIM_READBACK, claim, isTrunk } from '../../carve-github-issue/lib/claims.ts';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import { readTree } from '../../carve-github-issue/lib/tree.ts';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import { awaitGreenChecks } from '../../fix-github-issue/lib/pipeline.ts';
import { refusedAsTrunk } from '../../appraise-github-issues/lib/appraise.ts';
import { readFileSync } from 'node:fs';

// All guards are observations of this finite world. No test supplies a set of true guards.
// Each axis includes every equivalence class read by its predicates. The sweep takes the
// Cartesian product of the axes read by an event's handlers, including inherited handlers.
class World {
  base: string[][] = [];
  landed: string[] = [];
}
class Model {
  world = new World();
  head = 0;
  files = ['leaf.ts'];
  imports = ['shared.ts'];
  contribution = 'original';
  reviewedContribution = 'original';
  pr = 'none';
  verdict = 'none';
  decision = 'none';
  result = 'none';
  hold = 'none';
  dlq = 'none';
  claim = 'none';
  record = 'none';
  points = 1;
  closed = false;
  paused = false;
  active = true;
  parentOpen = false;
  children = 0;
  fingerprint = 0;
  recordedFingerprint = 0;
  blocker = 'none';
  released = false;
  trusted = false;
  remainder = 1;
  check = 'pending';
  smokeCommand = '';
  smokeExit = 1;
  walkExit = 1;
  attempts = 0;
  appraisals = 0;
  carves = 0;
  carveRounds = 0;
  reviewRounds = 0;
  refreshes = 0;
  redrives = 0;
  resuming = false;
  closeBy = 'appraiser';
  confirmCloses = true;
  incoming() { return this.world.base.slice(this.head).flat(); }
  behind() { return this.head < this.world.base.length; }
}
type Axis = { values: unknown[]; put: (m: Model, value: any) => void };
const axes: Record<string, Axis> = {};
function axis(key: keyof Model, values: unknown[]) {
  axes[key] = { values, put: (m, v) => { (m as any)[key] = v; } };
}
for (const key of ['closed', 'paused', 'active', 'parentOpen', 'released', 'trusted', 'resuming', 'confirmCloses'] as const) axis(key, [false, true]);
axis('closeBy', ['appraiser', 'worker']);
for (const key of ['attempts', 'appraisals', 'carves', 'carveRounds', 'reviewRounds', 'refreshes', 'redrives'] as const) axis(key, [0, 3]);
axis('pr', ['none', 'draft', 'ready', 'merged']);
axis('verdict', ['none', 'merge', 'reject']);
axis('decision', ['none', 'merge', 'retry', 'oversize', 'rerun-reviewer', 'resolve-conflict', 'design-objection']);
axis('result', ['none', 'fixed', 'close', 'needs-decision', 'needs-human', 'out-of-band', 'too-uncertain', 'indivisible', 'small-enough', 'nothing-left', 'still-good', 'amend', 'exhausted', 'question']);
axis('hold', ['none', 'needs-decision', 'needs-human', 'parked']);
axis('dlq', ['none', 'appraisal', 'carve', 'work', 'review', 'landing']);
axis('claim', ['none', 'own', 'foreign', 'dead']);
axis('record', ['none', 'applying', 'live']);
axis('points', [0, 1, 5]);
axis('children', [0, 2]);
axis('fingerprint', [0, 1]);
axis('blocker', ['none', 'open', 'completed', 'not-planned']);
axis('remainder', [0, 1]);
axis('check', ['pending', 'green', 'red']);
axis('smokeCommand', ['', 'boot']);
axis('smokeExit', [0, 1]);
axis('walkExit', [0, 1]);
axis('contribution', ['original', 'altered']);
axes.movement = {
  values: [[], ['other.ts'], ['shared.ts'], ['bun.lock'], ['leaf.ts']],
  put: (m, files: string[]) => { m.world.base = files.length ? [files] : []; m.head = 0; },
};
type Predicate = { axes: string[]; read: (m: Model) => boolean };
const predicates: Record<string, Predicate> = {};
function pred(name: string, dependencies: string[], read: Predicate['read']) { predicates[name] = { axes: dependencies, read }; }
function eq(name: string, key: keyof Model, value: unknown) { pred(name, [key], m => m[key] === value); }
eq('lineActive', 'active', true);
eq('resuming', 'resuming', true); eq('closeByWorker', 'closeBy', 'worker'); eq('closesUnconfirmed', 'confirmCloses', false);
eq('noOpenPr', 'pr', 'none');
pred('prExists', ['pr'], m => m.pr === 'draft' || m.pr === 'ready');
eq('readyPr', 'pr', 'ready'); eq('draftPr', 'pr', 'draft');
eq('aMergedPrReferencesIt', 'pr', 'merged');
eq('issueClosed', 'closed', true);
pred('issueClosedByMerge', ['closed', 'pr'], m => m.closed && m.pr === 'merged');
pred('prMergedIssueOpen', ['closed', 'pr'], m => !m.closed && m.pr === 'merged');
for (const [suffix, value] of [['NeedsDecision', 'needs-decision'], ['NeedsHuman', 'needs-human'], ['Parked', 'parked']]) {
  eq(`holdIs${suffix}`, 'hold', value); eq(`label${suffix}`, 'hold', value);
}
for (const [suffix, value] of [['Appraise', 'appraisal'], ['Carve', 'carve'], ['Work', 'work'], ['Review', 'review'], ['Land', 'landing']]) eq(`labelDlq${suffix}`, 'dlq', value);
eq('pausedByAncestor', 'paused', true);
eq('foreignClaimLive', 'claim', 'foreign'); eq('ownClaimLive', 'claim', 'own'); eq('deadClaim', 'claim', 'dead');
eq('applyingRecord', 'record', 'applying'); eq('liveRecord', 'record', 'live');
pred('openChild', ['children'], m => m.children > 0);
pred('isTrunk', ['children', 'record', 'released'], m => m.children > 0 || m.record !== 'none' || m.released);
pred('trunkFingerprintMoved', ['fingerprint'], m => m.fingerprint !== m.recordedFingerprint);
pred('oversizedNoRecord', ['points', 'record'], m => m.points > 2 && m.record === 'none');
pred('sizedWithinCeiling', ['points'], m => m.points > 0 && m.points <= 2);
pred('sizedOverCeiling', ['points'], m => m.points > 2);
eq('releasedLabel', 'released', true); eq('trustedVerdict', 'trusted', true);
eq('blockerOpen', 'blocker', 'open'); eq('blockerCompleted', 'blocker', 'completed'); eq('hasOpenParent', 'parentOpen', true);
for (const [name, key] of [['attemptsUnderCap', 'attempts'], ['appraisalsUnderCap', 'appraisals'], ['carvesUnderCap', 'carves'], ['carveRoundsUnderCap', 'carveRounds'], ['reviewRoundsUnderCap', 'reviewRounds'], ['redrivesUnderCap', 'redrives'], ['refreshesUnderCap', 'refreshes']] as const) pred(name, [key], m => m[key] < (key === 'refreshes' ? 2 : 3));
for (const [name, value] of [['decisionMerge', 'merge'], ['decisionRetry', 'retry'], ['decisionOversize', 'oversize'], ['decisionRerunReviewer', 'rerun-reviewer'], ['decisionResolveConflict', 'resolve-conflict'], ['decisionDesignObjection', 'design-objection']]) eq(name, 'decision', value);
for (const [name, value] of [['verdictFixed', 'fixed'], ['verdictIsClose', 'close'], ['verdictNeedsDecision', 'needs-decision'], ['verdictNeedsHuman', 'needs-human'], ['verdictTooUncertain', 'too-uncertain'], ['verdictIndivisible', 'indivisible'], ['verdictSmallEnough', 'small-enough'], ['verdictNothingLeft', 'nothing-left'], ['verdictStillGood', 'still-good'], ['verdictAmend', 'amend'], ['verdictExhausted', 'exhausted'], ['verdictQuestion', 'question']]) eq(name, 'result', value);
pred('verdictOutOfBandOverCeiling', ['result', 'points'], m => m.result === 'out-of-band' && m.points > 2);
eq('standingVerdictMerge', 'verdict', 'merge'); eq('verdictMerge', 'verdict', 'merge');
eq('standingVerdictRejection', 'verdict', 'reject'); eq('noVerdictYet', 'verdict', 'none');
pred('behindBase', ['movement'], m => m.behind());
pred('movementOutsideClosure', ['movement'], m => !m.incoming().some(f => [...m.files, ...m.imports, 'bun.lock'].includes(f)));
pred('netChangeIntact', ['contribution'], m => m.contribution === m.reviewedContribution);
eq('checksGreen', 'check', 'green'); pred('smokeConfigured', ['smokeCommand'], m => m.smokeCommand.length > 0);
eq('smokePassed', 'smokeExit', 0); eq('walkPassed', 'walkExit', 0); eq('nothingRemains', 'remainder', 0);
const facts = (m: Model) => (guard: string) => {
  if (!predicates[guard]) throw new Error(`unmodelled guard: ${guard}`);
  return predicates[guard].read(m);
};
function* worlds(keys: string[], index = 0, m = new Model()): Generator<Model> {
  if (index === keys.length) { yield m; return; }
  for (const value of axes[keys[index]].values) {
    axes[keys[index]].put(m, value);
    yield* worlds(keys, index + 1, m);
  }
}
const laneStates = new Set(LANES.map(l => l.state));
const nodes = new Map(walk(MACHINE));
function eventAtoms(state: string, event: string) {
  const names = new Set<string>();
  for (let at = state; at; at = at.includes('.') ? at.slice(0, at.lastIndexOf('.')) : '') {
    const raw = nodes.get(at)?.on?.[event];
    for (const t of raw ? Array.isArray(raw) ? raw : [raw] : []) for (const a of atoms(t.guard)) names.add(a);
  }
  return [...names];
}

describe('independent world-derived exhaustive event sweep', () => {
  it('models every guard, fires every lane handler under every realizable direct guard valuation, and never leaks', () => {
    for (const { transition } of transitions()) for (const name of atoms(transition.guard)) expect(predicates[name], name).toBeDefined();
    let cases = 0;
    let disabled = 0;
    const staleEntries = new Set<string>();
    for (const lane of LANES) {
      const events = new Set(transitions().filter(t => t.event !== 'always' && (lane.state === t.from || lane.state.startsWith(`${t.from}.`))).map(t => t.event));
      for (const event of events) {
        const names = eventAtoms(lane.state, event);
        // Include base movement even when the handler neglects to guard it.
        const keys = [...new Set([...names.flatMap(n => predicates[n].axes), 'movement'])];
        for (const m of worlds(keys)) {
          cases++;
          const result = fire(lane.state, event, facts(m));
          if (!result) { disabled++; continue; }
          expect(laneStates.has(result.state) || result.state === 'ticket.offBoard').toBe(true);
          // No card enters Smoke, Merging, or a revision lacking the base, by any event of the landing or review.
          if (['F4', 'F5'].includes(laneKey(result.state)) && ['F1', 'F2', 'F3', 'F4'].includes(lane.key) && m.behind() && event !== 'HAND_MOVED') staleEntries.add(`${lane.key}:${event}`);
        }
      }
    }
    console.log(`world sweep: ${cases} cases, ${disabled} disabled events, stale Merging entries: ${[...staleEntries].join(', ')}`);
    expect([...staleEntries]).toEqual([]);
  });
  it('reconcile rests for every individual fact axis and every pair of fact axes, including conflicting observations', () => {
    const keys = [...new Set((nodes.get('ticket.reconcile')?.always ?? []).flatMap(t => atoms(t.guard)).flatMap(n => predicates[n].axes))];
    let count = 0;
    for (let i = 0; i < keys.length; i++) for (let j = i; j < keys.length; j++) {
      for (const m of worlds([...new Set([keys[i], keys[j]])])) {
        const result = fire(laneState('A1'), 'RUN_STARTED', facts(m));
        expect(result && laneStates.has(result.state)).toBe(true); count++;
      }
    }
    console.log(`reconcile: ${count} world pairs`);
  });
});

class Work extends Card {
  m = new Model();
  constructor(name: string, world: World, file: string, lane = 'B1') {
    super(name, laneState(lane)); this.m.world = world; this.m.files = [file]; this.m.head = world.base.length;
  }
  event(event: string) { this.send(event, facts(this.m)); return this; }
  work() { this.event('DISPATCHED'); this.m.head = this.m.world.base.length; this.m.pr = 'ready'; this.m.result = 'fixed'; return this.event('WORKER_VERDICT'); }
  catchUp() {
    const before = Object.assign(new Model(), this.m);
    this.m.head = this.m.world.base.length;
    this.send('CAUGHT_UP', facts(before));
    if (this.lane === 'E1' || this.lane === 'D2') { this.m.refreshes++; this.m.verdict = 'none'; }
    return this;
  }
  review(decision = 'merge') {
    this.event('REVIEWER_DISPATCHED');
    if (this.lane === 'F2') { this.catchUp(); if (this.laneKeyNow() !== 'E1') return this; this.event('REVIEWER_DISPATCHED'); }
    this.m.decision = decision; this.m.verdict = decision === 'merge' ? 'merge' : 'reject';
    return this.event('REVIEWED');
  }
  laneKeyNow() { return this.lane; }
  land() {
    this.event('FRONT_OF_QUEUE');
    if (this.lane === 'F2') this.catchUp();
    if (this.lane !== 'F3') return this;
    this.m.check = 'green'; this.event('CHECKS');
    if (this.laneKeyNow() === 'F2') return this;
    expect(this.m.behind()).toBe(false);
    this.event('MERGED'); this.m.world.base.push(this.m.files); this.m.world.landed.push(this.name); return this;
  }
}
describe('independent multi-card scenarios', () => {
  it('A and C land while middle B exhausts work attempts', () => {
    const w = new World(); const a = new Work('A', w, 'a.ts').work().review();
    const b = new Work('B', w, 'b.ts'); const c = new Work('C', w, 'c.ts').work().review();
    for (let n = 1; n <= 3; n++) { b.event('DISPATCHED'); b.m.attempts = n; b.event('AGENT_FAILED'); }
    a.land(); c.land(); expect([a.lane, b.lane, c.lane]).toEqual(['T1', 'Q3', 'T1']); expect(w.landed).toEqual(['A', 'C']);
  });
  it('shared imports revoke proof; own-file conflicts dead-letter; disjoint work survives', () => {
    const w = new World(); const a = new Work('A', w, 'shared.ts').work().review();
    const b = new Work('B', w, 'b.ts').work(); const c = new Work('C', w, 'shared.ts').work().review();
    a.land(); b.event('REVIEWER_DISPATCHED').catchUp(); expect(b.lane).toBe('D2');
    b.event('PROOF_REACQUIRED').review().land(); expect(b.lane).toBe('T1');
    c.event('FRONT_OF_QUEUE').event('CONFLICT'); expect(c.lane).toBe('Q5');
  });
  it('approval revoked while waiting on checks, then review and land again', () => {
    const w = new World(); const a = new Work('A', w, 'shared.ts').work().review(); const b = new Work('B', w, 'b.ts').work().review();
    b.event('FRONT_OF_QUEUE'); a.land();
    // Green checks on a lane that fell behind go back to the catch-up, never on to Merging.
    b.m.check = 'green'; b.event('CHECKS'); expect(b.lane).toBe('F2'); expect(b.m.behind()).toBe(true);
    b.catchUp(); expect(b.lane).toBe('E1'); b.review().land(); expect(b.lane).toBe('T1');
  });
  it('a rejection on a lane that fell behind catches up first, and the rejection stands through it', () => {
    const w = new World(); const a = new Work('A', w, 'shared.ts').work().review(); const b = new Work('B', w, 'b.ts').work();
    b.event('REVIEWER_DISPATCHED'); a.land(); b.m.decision = 'reject'; b.m.verdict = 'reject'; b.event('REVIEWED');
    expect(b.lane).toBe('F2'); expect(b.actions).not.toContain('runWorkerRevision');
    const before = Object.assign(new Model(), b.m); b.m.head = w.base.length; b.send('CAUGHT_UP', facts(before));
    expect(b.lane).toBe('D4'); expect(b.m.behind()).toBe(false); expect(b.actions).toContain('runWorkerRevision');
  });
  it('a child dead letter changes the parent fingerprint while other children remain in flight', () => {
    const w = new World(); const trunk = new Work('trunk', w, '', 'C5'); trunk.m.children = 3; trunk.m.record = 'live';
    const a = new Work('A', w, 'a.ts').work(); const b = new Work('B', w, 'b.ts').work();
    b.event('REVIEWER_DISPATCHED').event('AGENT_FAILED'); expect(b.lane).toBe('Q4');
    // Fingerprint includes child labels; the DLQ label changes the snapshot.
    trunk.m.fingerprint++; trunk.event('FINGERPRINT_CHANGED'); expect(trunk.lane).toBe('C6');
    trunk.m.result = 'still-good'; trunk.event('REVISITED'); expect(trunk.lane).toBe('C5'); expect(a.lane).toBe('E1');
  });
});

describe('intervention and recovery at every lane', () => {
  it('all 36 lanes answer each human hold and a foreign claim', () => {
    expect(LANES.length).toBe(36);
    for (const lane of LANES) {
      for (const [hold, expected] of [['needs-decision', 'H1'], ['needs-human', 'H2'], ['parked', 'H3']]) {
        const m = new Model(); m.hold = hold;
        expect(laneKey(fire(lane.state, 'HOLD_ADDED_BY_PERSON', facts(m))!.state)).toBe(expected);
      }
      const m = new Model(); m.claim = 'foreign';
      expect(laneKey(fire(lane.state, 'FOREIGN_CLAIM', facts(m))!.state)).toBe('W3');
    }
  });
  for (const lane of ['H3', 'Q3', 'Q4', 'Q5']) for (const pr of ['none', 'draft', 'ready']) for (const behind of [false, true]) {
    it(`${lane} redrive: pr=${pr}, behind=${behind}`, () => {
      const m = new Model(); m.pr = pr; m.verdict = 'reject'; if (behind) m.world.base.push(['shared.ts']);
      const card = new Card('redrive', laneState(lane)); card.send('REDRIVEN', facts(m));
      expect(card.lane).toBe(pr === 'none' ? 'B1' : behind ? 'F2' : 'D4');
      if (card.lane === 'F2') { m.head = m.world.base.length; card.send('CAUGHT_UP', facts(m)); expect(card.lane).toBe('D4'); expect(m.behind()).toBe(false); }
    });
  }
  it('every lane of a machine phase answers a failure, and the driver makes no move the chart lacks', () => {
    const dropped = LANES.filter(l => /^[ACDEFQ]/.test(l.key) && !handles(l.state, 'AGENT_FAILED')).map(l => l.key);
    expect(dropped).toEqual([]);
    // Moves the drivers make, each of which was once absent from the chart.
    const absent: string[] = [];
    for (const [from, to] of [['E2', 'F2'], ['E1', 'D3'], ['E1', 'D2'], ['D3', 'D2'], ['F3', 'Q5'], ['A2', 'T2'], ['D1', 'A3'], ['A3', 'T2'], ['C6', 'H2'], ['C6', 'Q2'], ['C7', 'A2'], ['A2', 'B1'], ['F3', 'F2'], ['F4', 'F2']]) {
      if (!successors(laneState(from), { ownEventsOnly: true }).has(laneState(to))) absent.push(`${from}->${to}`);
    }
    expect(absent).toEqual([]);
    // A driverless pull request is never sent to a revision: only a person's redrive reaches one.
    for (const from of ['E1', 'D3']) for (const behind of [false, true]) {
      const m = new Model(); m.pr = from === 'E1' ? 'ready' : 'draft'; if (behind) m.world.base.push(['other.ts']);
      expect(laneKey(fire(laneState(from), 'RESUMED', facts(m))!.state)).toBe(behind ? 'F2' : 'D2');
    }
  });
  it('a failed triage agent leaves the card resting in its queue, never in a person\'s hold', () => {
    const m = new Model(); m.pr = 'ready';
    for (const lane of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']) expect(laneKey(fire(laneState(lane), 'AGENT_FAILED', facts(m))!.state)).toBe(lane);
  });
});

// Each of these failed against the code as first reviewed; they hold the fixes in place.
describe('owner invariants', () => {
  it('never enters Merging behind the base after checks', () => {
    const m = new Model(); m.pr = 'ready'; m.verdict = 'merge'; m.check = 'green'; m.world.base.push(['shared.ts']);
    expect(laneKey(fire(laneState('F3'), 'CHECKS', facts(m))!.state)).not.toBe('F5');
  });
  it('does not start a rejected revision behind the base', () => {
    const m = new Model(); m.pr = 'ready'; m.verdict = 'reject'; m.world.base.push(['shared.ts']);
    expect(fire(laneState('E2'), 'REVIEWED', facts(m))!.actions).not.toContain('runWorkerRevision');
  });
  it('does not park on an automatic triage failure', () => {
    const m = new Model(); m.pr = 'ready';
    expect(laneKey(fire(laneState('Q5'), 'AGENT_FAILED', facts(m))!.state)).toBe('Q5');
  });
  it('claim read-back cannot substitute an old claim for the newly posted claim', async () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(1)]);
    const ctx = { botLogin: 'loop-bot', runId: 'host-1-1', dryRun: false, dryRunLog: [], project: { repo: 'o/r' }, log: () => {}, io } as unknown as Context;
    CLAIM_READBACK.waitMs = 0;
    const first = await claim(ctx, io, 1, 'working');
    if (first === 'busy') throw new Error('first claim should succeed');
    const oldRead = structuredClone(io.view(1));
    first.release();
    // The read replica still shows the first claim, but neither its release nor the new claim.
    // All writes remain in FakeTracker memory; no subprocess or GitHub access occurs.
    const view = io.view.bind(io);
    io.view = n => n === 1 ? structuredClone(oldRead) : view(n);
    const second = await claim(ctx, io, 1, 'working');
    if (second !== 'busy') console.log(`claim lag: old comment ${first.commentId}, accepted comment ${second.commentId}`);
    expect(second).toBe('busy');
  });
  it('every appraisal gate admits the released trunk the burndown asked about', () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(1, { labels: [{ name: 'loop/released' }] })]);
    const ctx = { botLogin: 'loop-bot', runId: 'host-1-1', io } as unknown as Context;
    const tree = readTree(ctx, 1, io);
    expect(isTrunk(tree)).toBe(true);
    expect(refusedAsTrunk(tree, true)).toBe(false);
    expect(refusedAsTrunk(tree, undefined)).toBe(true);
    const source = readFileSync(new URL('../../appraise-github-issues/lib/appraise.ts', import.meta.url), 'utf8');
    // The gate is asked through the one predicate: a bare isTrunk call is how the exception was lost.
    expect(source.match(/isTrunk\(/g)?.length).toBe(1);
  });
  it('does not call an empty landing rollup green while checks are awaiting registration', async () => {
    let clock = 0;
    const ctx = { project: { repo: 'o/r' }, knobs: { checksTimeoutMinutes: 10, checks: 'auto' } } as unknown as Context;
    const io = { now: () => clock, sleep: async (ms: number) => { clock += ms; }, read: () => JSON.stringify({ headRefOid: 'landing', statusCheckRollup: clock >= 30_000 ? [{ name: 'build', conclusion: 'FAILURE' }] : [] }) };
    expect(await awaitGreenChecks(ctx, 1, () => {}, { sha: 'landing', required: ['build'] }, io)).toContain('checks failed');
  });
});

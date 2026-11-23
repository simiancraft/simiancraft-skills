import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '../../../fix-github-issue/lib/config.ts';
import { createContext } from '../../../fix-github-issue/lib/context.ts';
import { nextWalkMinutes, resolveFloor } from './config.ts';
import { Floor, FLOOR_PAUSE, incidentWaiting, stillWithAPerson } from './floor.ts';
import { pauseForHost } from '../host-pause.ts';
import type { handleIncident } from './incident.ts';
import { appendEntry, appendItem, type LedgerEntry, latestByItem, readLedger, readList } from './ledger.ts';
import { type FloorCause, floorReason, lineHolds, readSwitch } from './line.ts';
import { type Lineage, type LineageOf, owedTo, renderLineage } from './lineage.ts';

let scratch: string;
let status = 200;
let server: ReturnType<typeof Bun.serve>;
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim();

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'floor-'));
  git(scratch, 'init', '-q', '-b', 'main');
  git(scratch, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one');
  server = Bun.serve({ port: 0, fetch: () => new Response('ok', { status }) });
});
afterAll(() => {
  server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

const PROJECT = { name: 'Test', repo: 'o/floor', remote: 'origin', baseBranch: 'main', evidenceBranch: 'evidence', checkCommand: 'true', installCommand: 'true', conventionDocs: [], sizingScale: 'fib', sharedServices: [], portBase: 9000, portSpan: 10, pathAliases: [], sourceExtensions: ['.ts'], alwaysInvalidates: [], touchPaths: { migration: [], ci: [] }, worktreeRoot: 'wt' } as ProjectConfig;

/** A floor of its own per case, with recording callbacks in its callbacks directory. */
function floorFor(name: string, environment: Record<string, unknown> = {}, extra: { forge?: boolean; walkerAnswer?: string; lineageOf?: LineageOf; repair?: typeof handleIncident; readIncident?: (itemId: string) => { number: number; withAPerson: boolean } | null; landBlocker?: (issue: number) => string | null } = {}) {
  const root = join(scratch, name);
  const callbacksDir = join(root, 'callbacks');
  mkdirSync(callbacksDir, { recursive: true });
  for (const slot of ['on-walk', 'on-walk-fail']) {
    writeFileSync(join(callbacksDir, slot), `#!/bin/sh\ncat >> '${join(root, `${slot}.log`)}'\n`);
    chmodSync(join(callbacksDir, slot), 0o755);
  }
  const ctx = createContext({
    project: PROJECT,
    knobs: { autoMerge: 'never', maxReviewRounds: 3, checksTimeoutMinutes: 1, smokeTimeoutMinutes: 1 },
    seats: { worker: { engine: 'fixture' }, reviewer: { engine: 'fixture2' } },
    repoRoot: scratch,
    invokeRoot: scratch,
    promptsDirs: [join(import.meta.dir, '..', '..', 'prompts')],
    dryRun: false,
    runDir: join(root, 'runs'),
    botLogin: 'loop-bot',
    log: () => {},
    step: () => {},
  });
  const { floor: config, faults } = resolveFloor({ ...(extra.forge === undefined ? {} : { forge: extra.forge }), environment: { kind: 'web', baseUrl: `http://localhost:${server.port}`, ...environment } });
  expect(faults).toEqual([]);
  const readouts: string[] = [];
  const switchFile = join(root, 'line-switch');
  const floor = new Floor({
    ctx,
    config,
    dir: join(root, 'floor'),
    switchFile,
    callbacksDir,
    seats: { walker: { engine: 'fixture', ...(extra.walkerAnswer ? { model: extra.walkerAnswer } : {}) }, callback: { engine: 'fixture' } },
    maxPoints: 2,
    log: () => {},
    print: (text) => readouts.push(text),
    ...(extra.lineageOf ? { lineageOf: extra.lineageOf } : {}),
    handleIncident: extra.repair,
    ...(extra.readIncident ? { readIncident: extra.readIncident } : {}),
    ...(extra.landBlocker ? { landBlocker: extra.landBlocker } : {}),
    waitingAtMerge: () => 2,
  });
  const calls = (slot: string) => (existsSync(join(root, `${slot}.log`)) ? readFileSync(join(root, `${slot}.log`), 'utf8').trim().split('\n').length : 0);
  const line = () => (existsSync(switchFile) ? readFileSync(switchFile, 'utf8') : 'go\n');
  return { floor, readouts, switchFile, calls, line, dir: join(root, 'floor') };
}

describe('a walk that finds the environment down', () => {
  it('pauses the line, runs on-walk-fail once per transition, and releases its own pause when up again', async () => {
    const f = floorFor('down');
    status = 503;
    const first = await f.floor.walkOnce({ livenessOnly: true });
    expect(first?.wrong).toBe(true);
    expect(f.line()).toStartWith(`pause\n${FLOOR_PAUSE}undiagnosed: liveness is down`);
    expect(f.calls('on-walk-fail')).toBe(1);
    // Nothing here needs a person yet: the outage is a heads-up, not a question.
    expect(f.readouts[0]).toContain('liveness is down');
    expect(f.readouts[0]).toContain('🟢 Nothing needs you.');

    await f.floor.walkOnce({ livenessOnly: true });
    expect(f.calls('on-walk-fail')).toBe(1);

    status = 200;
    const up = await f.floor.walkOnce({ livenessOnly: true });
    expect(up?.wrong).toBe(false);
    expect(f.line()).toBe('go\n');
    expect(f.calls('on-walk')).toBe(2);
    expect(readLedger(f.dir).map((e) => e.verdict)).toEqual(['down', 'down', 'intact']);
  });

  it('leaves a pause a person set alone, going in and coming out', async () => {
    const f = floorFor('person');
    writeFileSync(f.switchFile, 'pause\nreleasing tonight\n');
    status = 503;
    await f.floor.walkOnce({ livenessOnly: true });
    expect(f.line()).toBe('pause\nreleasing tonight\n');
    status = 200;
    await f.floor.walkOnce({ livenessOnly: true });
    expect(f.line()).toBe('pause\nreleasing tonight\n');
  });

  it('leaves a host pause for a person to release, and pauses again after their go while still down', async () => {
    const f = floorFor('host-then-go');
    status = 503;
    await f.floor.walkOnce({ livenessOnly: true });
    expect(pauseForHost(f.switchFile, 'a host fault (ENOSPC)')).toBe('paused');
    const host = f.line();
    await f.floor.walkOnce({ livenessOnly: true });
    expect(f.line()).toBe(host);
    // The person fixes the disk and writes go: that clears the host pause, not the floor's.
    writeFileSync(f.switchFile, 'go\n');
    await f.floor.walkOnce({ livenessOnly: true });
    expect(f.line()).toStartWith(`pause\n${FLOOR_PAUSE}undiagnosed: liveness is down`);
    status = 200;
    await f.floor.walkOnce({ livenessOnly: true });
    expect(f.line()).toBe('go\n');
  });

  it("obeys a person's go over its own pause, and pauses again only when an item newly turns wrong", async () => {
    const f = floorFor('person-go');
    status = 503;
    await f.floor.walkOnce({ livenessOnly: true });
    expect(f.line()).toStartWith(`pause\n${FLOOR_PAUSE}`);
    writeFileSync(f.switchFile, 'go\n');
    await f.floor.walkOnce({ livenessOnly: true });
    expect(f.line()).toBe('go\n');
    status = 200;
    await f.floor.walkOnce({ livenessOnly: true });
    status = 503;
    await f.floor.walkOnce({ livenessOnly: true });
    expect(f.line()).toStartWith(`pause\n${FLOOR_PAUSE}undiagnosed: liveness is down`);
    status = 200;
  });

  it('leaves a host pause in place once the floor is right again: only a person releases it', async () => {
    const f = floorFor('host-up');
    status = 200;
    pauseForHost(f.switchFile, 'a host fault (ENOMEM)');
    const host = f.line();
    await f.floor.walkOnce({ livenessOnly: true });
    expect(f.line()).toBe(host);
  });

  it('is expected inside a quiet window: recorded, nothing paused or run', async () => {
    const f = floorFor('quiet', { quietWindows: [{ start: '00:00', end: '23:59' }] });
    status = 503;
    await f.floor.walkOnce({ livenessOnly: true });
    status = 200;
    expect(f.line()).toBe('go\n');
    expect(f.calls('on-walk-fail')).toBe(0);
    expect(readLedger(f.dir).at(-1)?.verdict).toBe('down');
  });
});

describe('a walk against another URL', () => {
  it('is a rehearsal: it reports, and writes neither the ledger nor the line', async () => {
    const f = floorFor('rehearsal');
    status = 503;
    const rehearsal = new Floor({ ...(f.floor as unknown as { o: ConstructorParameters<typeof Floor>[0] }).o, baseUrl: `http://127.0.0.1:${server.port}` });
    const walk = await rehearsal.walkOnce({ livenessOnly: true });
    expect(walk?.entries[0]?.verdict).toBe('down');
    expect(walk?.wrong).toBe(true);
    expect(f.line()).toBe('go\n');
    expect(readLedger(f.dir)).toHaveLength(0);
    expect(f.calls('on-walk-fail')).toBe(0);
  });
});

describe('an outage that began inside a quiet window', () => {
  it('pauses the line on the first walk after the window closes', async () => {
    const f = floorFor('quiet-then-out');
    status = 503;
    // The quiet walk, as the ledger records one, then a walk outside any window.
    appendEntry(f.dir, { itemId: 'liveness', checkedAt: new Date().toISOString(), rung: 'liveness', verdict: 'down', reason: '/ 503', quiet: true });
    await f.floor.walkOnce({ livenessOnly: true });
    expect(f.line()).toStartWith(`pause\n${FLOOR_PAUSE}undiagnosed: liveness is down`);
    expect(f.calls('on-walk-fail')).toBe(1);
    status = 200;
    await f.floor.walkOnce({ livenessOnly: true });
    expect(f.line()).toBe('go\n');
  });
});

describe('an outage that runs into a quiet window', () => {
  it('keeps the pause it already holds', async () => {
    const f = floorFor('out-then-quiet', { quietWindows: [{ start: '00:00', end: '23:59' }] });
    status = 503;
    appendEntry(f.dir, { itemId: 'liveness', checkedAt: new Date().toISOString(), rung: 'liveness', verdict: 'down', reason: '/ 503' });
    writeFileSync(f.switchFile, `pause\n${FLOOR_PAUSE} liveness is down; see the ledger on the floor\n`);
    await f.floor.walkOnce({ livenessOnly: true });
    expect(f.line()).toStartWith('pause\n');
    expect(readLedger(f.dir).at(-1)?.quiet).toBeUndefined();
  });
});

describe('merge-up and classification', () => {
  it('puts a merge on the floor with its issue, and records not-yet-deployed only when it changes', async () => {
    const deployed = git(scratch, 'rev-parse', 'HEAD');
    const f = floorFor('classify', { revisionCommand: `echo ${deployed}` });
    status = 200;
    f.floor.put({ issue: 7, title: 'fix: a thing', pr: 70, sha: '0123456789abcdef0123456789abcdef01234567', mergedAt: new Date().toISOString(), paths: ['src/a.ts'] });
    expect(readList(f.dir)[0]?.ref?.issue).toBe(7);
    await f.floor.walkOnce();
    await f.floor.walkOnce();
    expect(readLedger(f.dir).filter((e) => e.itemId === 'pull-request:70').map((e) => e.verdict)).toEqual(['not-yet-deployed']);
    expect(f.floor.owed('run')).toHaveLength(1);
    // An item another producer listed is the floor's, but not this run's to wait on at the end.
    appendItem(f.dir, { id: 'note:header', addedAt: new Date().toISOString(), source: 'person', text: 'the header shows the new logo' });
    expect(f.floor.owed('all')).toHaveLength(2);
    expect(f.floor.owed('run')).toHaveLength(1);
    expect(f.readouts[0]).toContain('🔄 Pending:');
  });
});

describe('the cadence', () => {
  it('is a number or a function of the floor state, and falls back when the function misbehaves', () => {
    const state = { pending: 3, wrong: false, paused: false, draining: false };
    expect(nextWalkMinutes(10, state)).toBe(10);
    expect(nextWalkMinutes((s) => (s.pending > 0 ? 2 : 30), state)).toBe(2);
    expect(nextWalkMinutes(() => Number.NaN, state)).toBe(10);
    expect(
      nextWalkMinutes(() => {
        throw new Error('typo');
      }, state),
    ).toBe(10);
  });

  it('refuses a floor block without a base URL or with a bad cadence', () => {
    const { faults } = resolveFloor({ every: 0, environment: { kind: 'web', baseUrl: 'staging' } });
    expect(faults.some((f) => f.startsWith('floor.every'))).toBe(true);
    expect(faults.some((f) => f.startsWith('floor.environment.baseUrl'))).toBe(true);
  });
});

describe('a merge the forge listed before the loop recorded it', () => {
  it('takes the issue from the loop record, so the card can still move', () => {
    const dir = join(scratch, 'forge-first');
    appendItem(dir, { id: 'pull-request:5', addedAt: 'a', source: 'forge', text: 'fix: x', ref: { pullRequest: 5, sha: 'abc' } });
    appendItem(dir, { id: 'pull-request:5', addedAt: 'b', source: 'burndown', text: 'fix: x', ref: { issue: 50, pullRequest: 5, sha: 'abc' } });
    appendItem(dir, { id: 'pull-request:5', addedAt: 'c', source: 'person', text: 'ignored' });
    const [item] = readList(dir);
    expect(item.ref?.issue).toBe(50);
    expect(item.source).toBe('burndown');
    expect(readList(dir)).toHaveLength(1);
  });
});

describe('a carved child whose missing effect an open sibling owns', () => {
  // Issue 10 changed what new installs create; its open sibling 11 migrates the rows that exist.
  const lineage = (siblingOpen: boolean): Lineage => ({
    issue: { number: 10, title: 'feat: new installs get the new channel', body: 'Acceptance: a fresh install gives every article the new channel.' },
    trunk: { number: 9, title: 'Move articles to the new channel' },
    openSiblings: siblingOpen ? [{ number: 11, title: 'feat: migrate existing articles', body: 'Acceptance: every existing article is on the new channel.' }] : [],
  });

  function carvedFloor(name: string, answers: Record<string, unknown>) {
    const deployed = git(scratch, 'rev-parse', 'HEAD');
    const answerDir = join(scratch, `${name}-answers`);
    mkdirSync(answerDir, { recursive: true });
    for (const [file, body] of Object.entries(answers)) writeFileSync(join(answerDir, file), JSON.stringify(body));
    const tracker = { siblingOpen: true, reads: 0 };
    const f = floorFor(name, { revisionCommand: `echo ${deployed}` }, {
      forge: false,
      walkerAnswer: join(answerDir, 'walk.json'),
      lineageOf: (issue) => {
        tracker.reads++;
        return issue === 10 ? lineage(tracker.siblingOpen) : null;
      },
    });
    f.floor.put({ issue: 10, title: 'feat: new installs get the new channel', pr: 100, sha: deployed, mergedAt: new Date().toISOString(), paths: ['src/fixtures.ts'] });
    return { ...f, answerDir, tracker };
  }
  const itemVerdicts = (dir: string) => readLedger(dir).filter((e) => e.itemId === 'pull-request:100').map((e) => e.verdict);

  it('records owed-by-sibling from the walker, pauses nothing, and walks again once the sibling closes', async () => {
    status = 200;
    const f = carvedFloor('owed-walker', {
      'walk.json': { entries: [{ itemId: 'pull-request:100', rung: 'look', verdict: 'owed-by-sibling', sibling: 11, reason: 'Existing articles are on the old channel; #11 migrates them.' }] },
    });
    const first = await f.floor.walkOnce();
    expect(first?.wrong).toBe(false);
    expect(readLedger(f.dir).at(-1)).toMatchObject({ verdict: 'owed-by-sibling', sibling: 11 });
    expect(f.line()).toBe('go\n');
    expect(f.calls('on-walk-fail')).toBe(0);
    expect(f.readouts[0]).toContain('owed by sibling #11');
    // The drain does not wait on the sibling's work.
    expect(f.floor.owed('run')).toHaveLength(0);

    // While the sibling is open the item is not walked again.
    await f.floor.walkOnce();
    expect(itemVerdicts(f.dir)).toEqual(['owed-by-sibling']);

    // Once it closes, the item is walked again and judged.
    f.tracker.siblingOpen = false;
    writeFileSync(join(f.answerDir, 'walk.json'), JSON.stringify({ entries: [{ itemId: 'pull-request:100', rung: 'look', verdict: 'present', reason: 'Every article is on the new channel.' }] }));
    await f.floor.walkOnce();
    expect(itemVerdicts(f.dir)).toEqual(['owed-by-sibling', 'present']);
  });

  it('waits on a sibling that merged until its own floor item is verified', async () => {
    status = 200;
    const f = carvedFloor('owed-landing', {
      'walk.json': { entries: [{ itemId: 'pull-request:100', rung: 'look', verdict: 'owed-by-sibling', sibling: 11, reason: 'Owed to #11.' }] },
    });
    await f.floor.walkOnce();
    f.tracker.siblingOpen = false;
    appendItem(f.dir, { id: 'pull-request:110', addedAt: new Date().toISOString(), source: 'burndown', text: 'feat: migrate existing articles', ref: { issue: 11, pullRequest: 110, sha: '0123456789abcdef0123456789abcdef01234567' } });
    await f.floor.walkOnce();
    expect(itemVerdicts(f.dir)).toEqual(['owed-by-sibling']);
  });

  it('settles an absent through the diagnosis before anything pauses, files nothing, and fixes nothing', async () => {
    status = 200;
    const f = carvedFloor('owed-diagnosis', {
      'walk.json': { entries: [{ itemId: 'pull-request:100', rung: 'exercise', verdict: 'absent', reason: 'Existing articles are on the old channel.' }] },
      'walk.diagnose.json': { culprit: null, confidence: 'likely', error: '', remedy: 'owed-by-sibling', sibling: 11, summary: '#11 migrates the existing rows.' },
    });
    const walk = await f.floor.walkOnce();
    expect(walk?.wrong).toBe(false);
    expect(walk?.incidents).toEqual([]);
    expect(itemVerdicts(f.dir)).toEqual(['absent', 'owed-by-sibling']);
    expect(readLedger(f.dir).at(-1)?.sibling).toBe(11);
    expect(f.line()).toBe('go\n');
    expect(f.calls('on-walk-fail')).toBe(0);
  });
});

describe('owedTo and the lineage text', () => {
  const lineage: Lineage = {
    issue: { number: 10, title: 'child', body: 'Acceptance: the child holds.' },
    trunk: { number: 9, title: 'trunk' },
    openSiblings: [{ number: 11, title: 'sibling', body: 'Acceptance: the sibling holds.' }],
  };

  it('names only a sibling open under the trunk', () => {
    expect(owedTo(lineage, 11)?.number).toBe(11);
    expect(owedTo(lineage, 12)).toBeNull();
    expect(owedTo(lineage, '11')).toBeNull();
    expect(owedTo(lineage, undefined)).toBeNull();
    expect(owedTo(null, 11)).toBeNull();
  });

  it("puts the child's own acceptance and each open sibling's in front of the walker", () => {
    const text = renderLineage(lineage, '  ');
    expect(text).toContain('closes issue #10 (child)');
    expect(text).toContain('  > Acceptance: the child holds.');
    expect(text).toContain('carved from trunk #9 (trunk)');
    expect(text).toContain('- #11 sibling');
    expect(text).toContain('Acceptance: the sibling holds.');
  });
});

describe('"Needs you" is read fresh at render time', () => {
  const at = (verdict: LedgerEntry['verdict'], itemId = 'pull-request:7'): LedgerEntry => ({ itemId, checkedAt: '2026-11-18T20:10:00Z', rung: 'exercise', verdict, reason: 'r' });
  /** Marks an item as owned by a person, as a walk that found its incident parked would. */
  const own = (floor: Floor, itemId: string, incident: number) => {
    const inner = floor as unknown as { withAPerson: Set<string>; incidentOf: Map<string, number> };
    inner.withAPerson.add(itemId);
    inner.incidentOf.set(itemId, incident);
  };

  it('drops an item whose newest ledger verdict turned present', async () => {
    const { floor, readouts, dir } = floorFor('needs-you-resolved');
    appendItem(dir, { id: 'pull-request:7', addedAt: 'a', source: 'burndown', text: 'move the page', ref: { pullRequest: 7, sha: 'abc' } });
    appendEntry(dir, at('absent'));
    own(floor, 'pull-request:7', 41);
    appendEntry(dir, at('present'));
    await floor.walkOnce({ livenessOnly: true });
    expect(readouts.at(-1)).not.toContain('parked for you');
    expect(readouts.at(-1)).toContain('Nothing needs you');
  });

  it('keeps an item still wrong when the tracker cannot confirm its incident closed', async () => {
    const { floor, readouts, dir } = floorFor('needs-you-wrong');
    appendItem(dir, { id: 'pull-request:8', addedAt: 'a', source: 'burndown', text: 'move the page', ref: { pullRequest: 8, sha: 'abc' } });
    appendEntry(dir, at('absent', 'pull-request:8'));
    own(floor, 'pull-request:8', 42);
    await floor.walkOnce({ livenessOnly: true });
    expect(readouts.at(-1)).toContain('PR #8 move the page is still absent and incident #42 is parked for you');
  });

  it('prints the readout again when ownership alone changed between two walks', async () => {
    const { floor, readouts, dir } = floorFor('needs-you-second-walk');
    status = 200;
    appendItem(dir, { id: 'pull-request:9', addedAt: 'a', source: 'burndown', text: 'move the page', ref: { pullRequest: 9, sha: 'abc' } });
    appendEntry(dir, at('absent', 'pull-request:9'));
    own(floor, 'pull-request:9', 43);
    await floor.walkOnce({ livenessOnly: true });
    expect(readouts.at(-1)).toContain('incident #43 is parked for you');
    appendEntry(dir, at('present', 'pull-request:9'));
    await floor.walkOnce({ livenessOnly: true });
    expect(readouts).toHaveLength(2);
    expect(readouts.at(-1)).toContain('Nothing needs you');
  });

  it("names the landing on the next walk once the incident's fix is parked approved", async () => {
    let blocker: string | null = 'it is not parked at the merge boundary';
    const { floor, readouts, dir } = floorFor('needs-you-landable', {}, { readIncident: () => ({ number: 44, withAPerson: true }), landBlocker: () => blocker });
    status = 200;
    appendItem(dir, { id: 'pull-request:10', addedAt: 'a', source: 'burndown', text: 'move the page', ref: { pullRequest: 10, sha: 'abc' } });
    appendEntry(dir, at('absent', 'pull-request:10'));
    own(floor, 'pull-request:10', 44);
    await floor.walkOnce({ livenessOnly: true });
    expect(readouts.at(-1)).toContain('lift its label to hand it back');
    blocker = null;
    await floor.walkOnce({ livenessOnly: true });
    expect(readouts).toHaveLength(2);
    expect(readouts.at(-1)).toContain('fix.ts --land 44');
  });

  it('follows the incident as the tracker reports it now', () => {
    const latest = latestByItem([at('absent', 'a'), at('absent', 'b'), at('absent', 'c'), at('absent', 'd'), at('absent', 'e'), at('present', 'e')]);
    const tracker: Record<string, ReturnType<Parameters<typeof stillWithAPerson>[2]>> = {
      a: { number: 1, withAPerson: true }, // still parked
      b: null, // closed
      c: { number: 3, withAPerson: false }, // its label lifted: back with the pipeline
      d: undefined, // unreadable
      e: { number: 5, withAPerson: true }, // open, but walked right since
    };
    const reads: string[] = [];
    const kept = stillWithAPerson(['a', 'b', 'c', 'd', 'e'], latest, (id) => {
      reads.push(id);
      return tracker[id];
    });
    expect(kept.map((k) => [k.itemId, k.incident])).toEqual([['a', 1], ['d', null]]);
    // An item the ledger already shows right costs no tracker read.
    expect(reads).not.toContain('e');
  });
});

describe('the readout line for an incident a person owns', () => {
  it('names the landing when the merge boundary parked an approved fix', () => {
    const line = incidentWaiting('home', 42, true);
    expect(line).toContain('fix.ts --land 42');
    expect(line).not.toContain('lift its label');
  });
  it('hands any other park back by its label', () => {
    expect(incidentWaiting('home', 42, false)).toContain('lift its label to hand it back');
    expect(incidentWaiting('home', undefined, true)).toContain('(see floor/incident)');
  });
});

describe('the cause on the floor\'s pause', () => {
  const deployed = () => git(scratch, 'rev-parse', 'HEAD');
  /** An incident handler that answers with this cause, recording the line as the diagnosis found it and as it left it. */
  const answering = (cause: FloorCause | 'throws', seen: string[], during?: (switchFile: string) => void): typeof handleIncident =>
    async (_ctx, options) => {
      seen.push(readFileSync(switchFileOf.current, 'utf8'));
      if (cause === 'throws') throw new Error('the diagnosis seat is gone');
      during?.(switchFileOf.current);
      options.onDiagnosed?.(cause);
      seen.push(readFileSync(switchFileOf.current, 'utf8'));
      return { issue: 31, created: true, fix: null, diagnosis: null, withAPerson: cause === 'outside-repository', cause };
    };
  const switchFileOf = { current: '' };
  const wrongWalk = async (name: string, cause: FloorCause | 'throws', during?: (switchFile: string) => void) => {
    const seen: string[] = [];
    const f = floorFor(name, { revisionCommand: `echo ${deployed()}` }, { repair: answering(cause, seen, during) });
    switchFileOf.current = f.switchFile;
    status = 503;
    await f.floor.walkOnce();
    return { f, seen };
  };

  it('is undiagnosed the moment the walk finds something wrong, and the diagnosis converts it', async () => {
    const { f, seen } = await wrongWalk('cause-outage', 'outside-repository');
    expect(seen[0]).toStartWith(`pause\n${floorReason('undiagnosed', 'liveness is down')}`);
    expect(seen[1]).toStartWith(`pause\n${floorReason('outside-repository', 'liveness is down')}`);
    expect(f.line()).toStartWith(`pause\n${floorReason('outside-repository', 'liveness is down')}`);
    status = 200;
  });

  it('lets lanes start during an outage, stacks merges, and releases them on the first walk that finds it up', async () => {
    const { f } = await wrongWalk('cause-outage-release', 'outside-repository');
    expect(lineHolds(readSwitch(f.switchFile), 'dispatch')).toBe(false);
    expect(lineHolds(readSwitch(f.switchFile), 'merge')).toBe(true);
    expect(f.readouts.at(-1)).toContain('only merges are held, other work goes on');
    expect(f.readouts.at(-1)).toContain('2 pull request(s) waiting at the merge');
    status = 200;
    await f.floor.walkOnce({ livenessOnly: true });
    expect(lineHolds(readSwitch(f.switchFile), 'merge')).toBe(false);
  });

  it('starts no new lane while the floor repairs its own fault', async () => {
    const { f } = await wrongWalk('cause-repair', 'in-repository');
    expect(lineHolds(readSwitch(f.switchFile), 'dispatch')).toBe(true);
    expect(f.readouts.at(-1)).toContain('merges wait and no new lane starts');
    status = 200;
  });

  it('records a remedy in the repository as the repository\'s', async () => {
    const { f } = await wrongWalk('cause-ours', 'in-repository');
    expect(f.line()).toStartWith(`pause\n${FLOOR_PAUSE}in-repository: `);
    status = 200;
  });

  it('records a diagnosis that could not answer as a cause nobody knows, never as an outage', async () => {
    const { f } = await wrongWalk('cause-thrown', 'throws');
    expect(f.line()).toStartWith(`pause\n${FLOOR_PAUSE}cause-unknown: `);
    status = 200;
  });

  it('never overwrites a pause a person set while the diagnosis ran', async () => {
    const { f } = await wrongWalk('cause-person', 'outside-repository', (file) => writeFileSync(file, 'pause\nholding for the release\n'));
    expect(f.line()).toBe('pause\nholding for the release\n');
    status = 200;
    await f.floor.walkOnce({ livenessOnly: true });
    expect(f.line()).toBe('pause\nholding for the release\n');
  });

  it('keeps the cause an earlier run recorded for an outage still under way', async () => {
    const f = floorFor('cause-restart');
    status = 503;
    appendEntry(f.dir, { itemId: 'liveness', checkedAt: new Date().toISOString(), rung: 'liveness', verdict: 'down', reason: '/ 503' });
    writeFileSync(f.switchFile, `pause\n${floorReason('outside-repository', 'liveness is down')}; see the ledger on the floor\n`);
    const restarted = new Floor({ ...(f.floor as unknown as { o: ConstructorParameters<typeof Floor>[0] }).o });
    await restarted.walkOnce({ livenessOnly: true });
    expect(f.line()).toStartWith(`pause\n${floorReason('outside-repository', 'liveness is down')}`);
    status = 200;
    await restarted.walkOnce({ livenessOnly: true });
    expect(f.line()).toBe('go\n');
  });
});

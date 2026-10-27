import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '../../../fix-github-issue/lib/config.ts';
import { createContext } from '../../../fix-github-issue/lib/context.ts';
import { nextWalkMinutes, resolveFloor } from './config.ts';
import { Floor, FLOOR_PAUSE } from './floor.ts';
import { appendEntry, appendItem, readLedger, readList } from './ledger.ts';

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
function floorFor(name: string, environment: Record<string, unknown> = {}) {
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
  const { floor: config, faults } = resolveFloor({ environment: { kind: 'web', baseUrl: `http://localhost:${server.port}`, ...environment } });
  expect(faults).toEqual([]);
  const readouts: string[] = [];
  const switchFile = join(root, 'line-switch');
  const floor = new Floor({
    ctx,
    config,
    dir: join(root, 'floor'),
    switchFile,
    callbacksDir,
    seats: { walker: { engine: 'fixture' }, callback: { engine: 'fixture' } },
    maxPoints: 2,
    log: () => {},
    print: (text) => readouts.push(text),
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
    expect(f.line()).toStartWith(`pause\n${FLOOR_PAUSE} liveness is down`);
    expect(f.calls('on-walk-fail')).toBe(1);
    // Nothing here needs a person yet: the outage is a heads-up, not a question.
    expect(f.readouts[0]).toContain('liveness is down');
    expect(f.readouts[0]).toContain('⛔ Nothing waiting on you.');

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
    expect(f.line()).toStartWith(`pause\n${FLOOR_PAUSE} liveness is down`);
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

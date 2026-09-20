import { describe, expect, it } from 'bun:test';
import type { Context } from './context.ts';
import { awaitGreenChecks } from './pipeline.ts';

type Check = { name: string; conclusion: string };

type Suite = { app: string; runs: number };

/** A pull request whose checks appear on a schedule, on a clock the test owns. `openSuites` answers the check-suite read with the suites still open. */
function world(checks: 'required' | 'none', schedule: (clock: number) => Check[], options: { timeoutMinutes?: number; openSuites?: (clock: number) => Suite[] | string; idleApps?: string[] } = {}) {
  let clock = 0;
  const ctx = { project: { repo: 'o/r' }, knobs: { checksTimeoutMinutes: options.timeoutMinutes ?? 10, checks, idleCheckSuiteApps: options.idleApps } } as unknown as Context;
  const io = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    read: (argv: string[]) => (argv[1] === 'api' ? ((raw) => (typeof raw === 'string' ? raw : [{ total: raw.length, seen: raw.length }, ...raw].map((row) => JSON.stringify(row)).join('\n')))(options.openSuites?.(clock) ?? []) : JSON.stringify({ headRefOid: 'landing', statusCheckRollup: schedule(clock) })),
  };
  return { ctx, io, waited: () => clock };
}
const GREEN = { name: 'build', conclusion: 'SUCCESS' };
const suite = (app: string, runs: number): Suite => ({ app, runs });

const EXPECT = { sha: 'landing', required: ['build'] };

describe('the build gate', () => {
  it('never calls an empty list green, however long it stays empty', async () => {
    const w = world('required', () => []);
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, EXPECT, w.io)).toContain('have not registered');
    expect(w.waited()).toBe(10 * 60_000);
  });

  it('refuses outright when nothing names the checks a landing must pass', async () => {
    const w = world('required', () => [GREEN]);
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, { sha: 'landing' }, w.io)).toContain('nothing names the checks');
    expect(w.waited()).toBe(0);
  });

  it('sees a check that registers late and fails', async () => {
    const w = world('required', (clock) => (clock >= 120_000 ? [{ name: 'build', conclusion: 'FAILURE' }] : []));
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, EXPECT, w.io)).toContain('checks failed: build');
  });

  it('waits for every expected check, so one fast green check cannot stand in for a slower one', async () => {
    const w = world('required', (clock) => (clock >= 60_000 ? [GREEN, { name: 'integration', conclusion: 'FAILURE' }] : [GREEN]));
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, { sha: 'landing', required: ['build'], names: ['build', 'integration'] }, w.io)).toContain('checks failed: integration');
  });

  it('refuses a list that only the reviewed head names: a fast review sees a partial list too', async () => {
    const w = world('required', () => [GREEN]);
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, { sha: 'landing', names: ['build'] }, w.io)).toContain('nothing names the checks');
  });

  it('takes the expected checks from the config as well', async () => {
    const w = world('required', (clock) => (clock >= 60_000 ? [GREEN, { name: 'integration', conclusion: 'FAILURE' }] : [GREEN]));
    (w.ctx.knobs as { requiredChecks?: string[] }).requiredChecks = ['integration'];
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, EXPECT, w.io)).toContain('checks failed: integration');
  });

  it('waits for a check suite that has a run in it', async () => {
    const said: string[] = [];
    const w = world('required', () => [GREEN], { openSuites: (clock) => (clock < 300_000 ? [suite('github-actions', 1)] : []) });
    expect(await awaitGreenChecks(w.ctx, 1, (m) => said.push(m), EXPECT, w.io)).toBeNull();
    expect(w.waited()).toBeGreaterThanOrEqual(300_000);
    expect(said[0]).toContain('have not finished: github-actions;');
  });

  it('waits out a suite with no run in it that nobody wrote down, and names the knob', async () => {
    const w = world('required', () => [GREEN], { openSuites: () => [suite('netlify', 0)] });
    const refusal = await awaitGreenChecks(w.ctx, 1, () => {}, EXPECT, w.io);
    expect(refusal).toContain('netlify (no run in it; an app that runs nothing here belongs in idleCheckSuiteApps)');
    expect(refusal).toContain('after 10 minutes');
  });

  it('passes over a listed app whose suite has no run in it, and says so once per app', async () => {
    const said: string[] = [];
    const w = world('required', () => [GREEN], { openSuites: () => [suite('netlify', 0), suite('codecov', 0)], idleApps: ['netlify', 'codecov'] });
    expect(await awaitGreenChecks(w.ctx, 1, (m) => said.push(m), EXPECT, w.io)).toBeNull();
    expect(w.waited()).toBe(0);
    expect(said.map((m) => /^the (\S+) check suite/.exec(m)?.[1])).toEqual(['netlify', 'codecov']);
  });

  it('holds for a listed app once its suite has a run, when that run registers while the gate still waits', async () => {
    // Idle for six minutes beside a running suite, then its first run registers. Seen only because the
    // gate was still waiting on the other suite; a first run after the gate has passed is not detected.
    const w = world('required', () => [GREEN], {
      idleApps: ['slow-ci'],
      openSuites: (clock) => (clock < 360_000 ? [suite('slow-ci', 0), suite('github-actions', 1)] : clock < 480_000 ? [suite('slow-ci', 1)] : []),
    });
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, EXPECT, w.io)).toBeNull();
    expect(w.waited()).toBeGreaterThanOrEqual(480_000);
  });

  it('reads every page: a holding suite after thirty idle ones still holds', async () => {
    const idle = Array.from({ length: 30 }, (_, i) => suite(`idle-${i}`, 0));
    const w = world('required', () => [GREEN], { idleApps: idle.map((s) => s.app), openSuites: () => [...idle, suite('page-two-ci', 1)] });
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, EXPECT, w.io)).toContain('have not finished: page-two-ci,');
  });

  it('asks the tracker for every page of suites', async () => {
    const w = world('required', () => [GREEN]);
    const asked: string[][] = [];
    const read = w.io.read;
    w.io.read = (argv) => (asked.push(argv), read(argv));
    await awaitGreenChecks(w.ctx, 1, () => {}, EXPECT, w.io);
    const suites = asked.find((argv) => argv.some((a) => a.includes('/check-suites')));
    expect(suites).toContain('--paginate');
  });

  const PAGE = '{"total":1,"seen":1}';
  for (const [what, raw] of [
    ['not JSON', 'NaN'],
    ['nothing at all', ''],
    ['a suite with no run count', `${PAGE}\n{"app":"x"}`],
    ['a suite with no app', `${PAGE}\n{"runs":0}`],
    ['fewer suites than GitHub counted', '{"total":40,"seen":30}'],
    ['pages that disagree on the total', '{"total":2,"seen":1}\n{"total":3,"seen":1}'],
  ] as const) {
    it(`waits on suite data it cannot read (${what}), and never assumes it complete`, async () => {
      const w = world('required', () => [GREEN], { openSuites: () => raw, idleApps: ['x'] });
      expect(await awaitGreenChecks(w.ctx, 1, () => {}, EXPECT, w.io)).toContain('cannot be read');
    });
  }

  it('lands a complete green list at once', async () => {
    const w = world('required', () => [GREEN]);
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, EXPECT, w.io)).toBeNull();
    expect(w.waited()).toBe(0);
  });

  it('lands at once where the config says the repository runs no checks', async () => {
    const w = world('none', () => []);
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, { sha: 'landing' }, w.io)).toBeNull();
    expect(w.waited()).toBe(0);
  });

  it('never waits past the configured timeout, to the millisecond', async () => {
    const w = world('required', () => [], { timeoutMinutes: 0.501 });
    await awaitGreenChecks(w.ctx, 1, () => {}, EXPECT, w.io);
    expect(w.waited()).toBe(30_060);
  });

  it('waits for the pull request to show the landing head', async () => {
    const w = world('required', () => [GREEN]);
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, { sha: 'another', required: ['build'] }, w.io)).toContain('does not show the landing head');
  });
});

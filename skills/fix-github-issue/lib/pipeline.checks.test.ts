import { describe, expect, it } from 'bun:test';
import type { Context } from './context.ts';
import { awaitGreenChecks, SUITE_SETTLE_MS } from './pipeline.ts';

type Check = { name: string; conclusion: string };

type Suite = { app: string; runs: number; created: string };

/** A pull request whose checks appear on a schedule, on a clock the test owns. `openSuites` answers the check-suite read with the suites still open. */
function world(checks: 'required' | 'none', schedule: (clock: number) => Check[], options: { timeoutMinutes?: number; openSuites?: (clock: number) => Suite[] | string } = {}) {
  let clock = 0;
  const ctx = { project: { repo: 'o/r' }, knobs: { checksTimeoutMinutes: options.timeoutMinutes ?? 10, checks } } as unknown as Context;
  const io = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    read: (argv: string[]) => (argv[1] === 'api' ? ((raw) => (typeof raw === 'string' ? raw : JSON.stringify(raw)))(options.openSuites?.(clock) ?? []) : JSON.stringify({ headRefOid: 'landing', statusCheckRollup: schedule(clock) })),
  };
  return { ctx, io, waited: () => clock };
}
const GREEN = { name: 'build', conclusion: 'SUCCESS' };
/** The test clock starts at the epoch, so a suite created then is as old as the clock reads. */
const suite = (app: string, runs: number): Suite => ({ app, runs, created: new Date(0).toISOString() });

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

  it('waits for a check suite that has a run in it, however old the suite is', async () => {
    const said: string[] = [];
    const w = world('required', () => [GREEN], { openSuites: (clock) => (clock < 3 * SUITE_SETTLE_MS ? [suite('github-actions', 1)] : []), timeoutMinutes: 20 });
    expect(await awaitGreenChecks(w.ctx, 1, (m) => said.push(m), EXPECT, w.io)).toBeNull();
    expect(w.waited()).toBeGreaterThanOrEqual(3 * SUITE_SETTLE_MS);
    expect(said[0]).toContain('have not finished: github-actions');
  });

  it('gives a suite with no run in it the settle window to register one', async () => {
    const w = world('required', () => [GREEN], { openSuites: (clock) => [suite('late-app', clock < 120_000 ? 0 : 1)], timeoutMinutes: 20 });
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, EXPECT, w.io)).toContain('have not finished: late-app, after 20 minutes');
  });

  it('stops waiting on a suite that stays open with no run in it, and says which app once', async () => {
    const said: string[] = [];
    const w = world('required', () => [GREEN], { openSuites: () => [suite('netlify', 0), suite('codecov', 0)] });
    expect(await awaitGreenChecks(w.ctx, 1, (m) => said.push(m), EXPECT, w.io)).toBeNull();
    expect(w.waited()).toBe(SUITE_SETTLE_MS);
    expect(said.filter((m) => /no run in it/.test(m)).map((m) => /the (\S+) check suite/.exec(m)?.[1])).toEqual(['netlify', 'codecov']);
  });

  it('still waits on a suite with a run while passing over an idle one beside it', async () => {
    const w = world('required', () => [GREEN], { openSuites: () => [suite('netlify', 0), suite('github-actions', 2)] });
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, EXPECT, w.io)).toContain('have not finished: github-actions, after 10 minutes');
  });

  for (const [what, raw] of [['not JSON', 'NaN'], ['a suite with no run count', '[{"app":"x","created":"1970-01-01T00:00:00Z"}]'], ['a suite with no creation time', '[{"app":"x","runs":0}]']] as const) {
    it(`waits on suite data it cannot read (${what}), and never assumes it complete`, async () => {
      const w = world('required', () => [GREEN], { openSuites: () => raw });
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

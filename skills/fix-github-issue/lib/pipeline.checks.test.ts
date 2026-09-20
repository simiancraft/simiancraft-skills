import { describe, expect, it } from 'bun:test';
import type { Context } from './context.ts';
import { awaitGreenChecks } from './pipeline.ts';

type Check = { name: string; conclusion: string };

/** A pull request whose checks appear on a schedule, on a clock the test owns. `openSuites` answers the check-suite read. */
function world(checks: 'required' | 'none', schedule: (clock: number) => Check[], options: { timeoutMinutes?: number; openSuites?: (clock: number) => number } = {}) {
  let clock = 0;
  const ctx = { project: { repo: 'o/r' }, knobs: { checksTimeoutMinutes: options.timeoutMinutes ?? 10, checks } } as unknown as Context;
  const io = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    read: (argv: string[]) => (argv[1] === 'api' ? String(options.openSuites?.(clock) ?? 0) : JSON.stringify({ headRefOid: 'landing', statusCheckRollup: schedule(clock) })),
  };
  return { ctx, io, waited: () => clock };
}
const GREEN = { name: 'build', conclusion: 'SUCCESS' };

const EXPECT = { sha: 'landing', names: ['build'] };

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
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, { sha: 'landing', names: ['build', 'integration'] }, w.io)).toContain('checks failed: integration');
  });

  it('takes the expected checks from the config as well', async () => {
    const w = world('required', (clock) => (clock >= 60_000 ? [GREEN, { name: 'integration', conclusion: 'FAILURE' }] : [GREEN]));
    (w.ctx.knobs as { requiredChecks?: string[] }).requiredChecks = ['integration'];
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, EXPECT, w.io)).toContain('checks failed: integration');
  });

  it('waits for every check suite GitHub has opened on the head', async () => {
    const w = world('required', () => [GREEN], { openSuites: (clock) => (clock < 300_000 ? 1 : 0) });
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, EXPECT, w.io)).toBeNull();
    expect(w.waited()).toBeGreaterThanOrEqual(300_000);
  });

  it('waits on suite data it cannot read, and never assumes it complete', async () => {
    const w = world('required', () => [GREEN], { openSuites: () => Number.NaN });
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, EXPECT, w.io)).toContain('cannot be read');
  });

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
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, { sha: 'another', names: ['build'] }, w.io)).toContain('does not show the landing head');
  });
});

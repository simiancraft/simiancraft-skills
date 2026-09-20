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

describe('the build gate', () => {
  it('never calls an empty list green, however long it stays empty', async () => {
    const w = world('required', () => []);
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, { sha: 'landing' }, w.io)).toContain('no check has registered');
    expect(w.waited()).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it('sees a check that registers late and fails', async () => {
    const w = world('required', (clock) => (clock >= 120_000 ? [{ name: 'ci', conclusion: 'FAILURE' }] : []));
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, { sha: 'landing' }, w.io)).toContain('checks failed: ci');
  });

  it('does not let one fast green check stand in for a slower one still registering', async () => {
    const w = world('required', (clock) => (clock >= 25_000 ? [GREEN, { name: 'integration', conclusion: 'FAILURE' }] : [GREEN]));
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, { sha: 'landing' }, w.io)).toContain('checks failed: integration');
  });

  it('waits for every check suite GitHub has opened on the head', async () => {
    const w = world('required', () => [GREEN], { openSuites: (clock) => (clock < 300_000 ? 1 : 0) });
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, { sha: 'landing' }, w.io)).toBeNull();
    expect(w.waited()).toBeGreaterThanOrEqual(300_000);
  });

  it('lands a green list once it has settled', async () => {
    const w = world('required', () => [GREEN]);
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, { sha: 'landing' }, w.io)).toBeNull();
    expect(w.waited()).toBe(30_000);
  });

  it('lands at once where the config says the repository runs no checks', async () => {
    const w = world('none', () => []);
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, { sha: 'landing' }, w.io)).toBeNull();
    expect(w.waited()).toBe(0);
  });

  it('never waits past the configured timeout', async () => {
    const w = world('required', () => [], { timeoutMinutes: 0.5 });
    await awaitGreenChecks(w.ctx, 1, () => {}, { sha: 'landing' }, w.io);
    expect(w.waited()).toBeLessThanOrEqual(30_000);
  });

  it('waits for the pull request to show the landing head', async () => {
    const w = world('required', () => [GREEN]);
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, { sha: 'another' }, w.io)).toContain('does not show the landing head');
  });
});

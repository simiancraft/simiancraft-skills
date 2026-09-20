import { describe, expect, it } from 'bun:test';
import type { Context } from './context.ts';
import { awaitGreenChecks } from './pipeline.ts';

type Check = { name: string; conclusion: string };

/** A pull request whose checks register `after` milliseconds of waiting, on a clock the test owns. */
function world(checks: 'auto' | 'required' | 'none', registerAfterMs: number | null, registered: Check[] = [{ name: 'build', conclusion: 'SUCCESS' }]) {
  let clock = 0;
  const ctx = { project: { repo: 'o/r' }, knobs: { checksTimeoutMinutes: 10, checks } } as unknown as Context;
  const io = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    read: () => JSON.stringify({ headRefOid: 'landing', statusCheckRollup: registerAfterMs !== null && clock >= registerAfterMs ? registered : [] }),
  };
  return { ctx, io, waited: () => clock };
}

describe('the build gate and an empty rollup', () => {
  it('waits for a check that registers late, even when none was seen on the reviewed commit', async () => {
    const w = world('auto', 40_000, [{ name: 'build', conclusion: 'FAILURE' }]);
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, { sha: 'landing', checksExpected: false }, w.io)).toContain('checks failed: build');
  });

  it('calls an empty rollup green only after the grace period, where none were seen', async () => {
    const w = world('auto', null);
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, { sha: 'landing', checksExpected: false }, w.io)).toBeNull();
    expect(w.waited()).toBeGreaterThanOrEqual(90_000);
  });

  it('never lands on an empty rollup where checks are expected', async () => {
    const w = world('required', null);
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, { sha: 'landing', checksExpected: true }, w.io)).toContain('no check has registered');
  });

  it('lands at once where the config says the repository runs none', async () => {
    const w = world('none', null);
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, { sha: 'landing', checksExpected: false }, w.io)).toBeNull();
    expect(w.waited()).toBe(0);
  });

  it('waits for the pull request to show the landing head', async () => {
    const w = world('auto', 0);
    expect(await awaitGreenChecks(w.ctx, 1, () => {}, { sha: 'another', checksExpected: true }, w.io)).toContain('does not show the landing head');
  });
});

import { describe, expect, it } from 'bun:test';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import { readTree } from '../../carve-github-issue/lib/tree.ts';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import { appraiseIssue, refusedAsTrunk } from './appraise.ts';

const treeOf = (labels: string[]) => {
  const io = new FakeTracker('loop-bot', [fakeIssue(1, { labels: labels.map((name) => ({ name })) })]);
  return readTree({ botLogin: 'loop-bot', runId: 'host-1-1', io } as unknown as Context, 1, io);
};

describe('the trunk gate an appraisal asks at every step', () => {
  it('refuses a released trunk, unless the burndown asked for its release appraisal', () => {
    expect(refusedAsTrunk(treeOf(['loop/released']), undefined)).toBe(true);
    expect(refusedAsTrunk(treeOf(['loop/released']), true)).toBe(false);
  });
  it('never refuses a leaf', () => {
    expect(refusedAsTrunk(treeOf(['bug']), undefined)).toBe(false);
    expect(refusedAsTrunk(treeOf(['bug']), true)).toBe(false);
  });
});

describe('the engines an appraisal requires', () => {
  const ctx = () => ({ botLogin: 'loop-bot', runId: 'host-1-1', io: new FakeTracker('loop-bot', [fakeIssue(1)]), log: () => {}, dryRun: true }) as unknown as Context;
  const seats = { appraiser: { engine: 'claude' }, confirmer: { engine: 'claude' } } as const;
  const run = (confirmCloses: boolean) =>
    appraiseIssue(ctx(), { number: 1, title: 't', createdAt: '2026-09-01T00:00:00Z', labels: [] } as never, { ageDays: null, seats, confirmCloses, skipLabels: [] }).then(
      () => '',
      (error: Error) => error.message,
    );
  it('refuses one engine in both seats when closes are confirmed', async () => {
    expect(await run(true)).toMatch(/must be different engines/);
  });
  it('does not care which engine the confirmer is when closes are not confirmed', async () => {
    expect(await run(false)).not.toMatch(/must be different engines/);
  });
});

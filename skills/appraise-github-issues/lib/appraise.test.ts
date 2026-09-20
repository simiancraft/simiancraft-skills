import { describe, expect, it } from 'bun:test';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import { readTree } from '../../carve-github-issue/lib/tree.ts';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import { refusedAsTrunk } from './appraise.ts';

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

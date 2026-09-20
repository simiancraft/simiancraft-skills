import { describe, expect, it } from 'bun:test';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import type { Context } from './context.ts';
import { countOf, DLQ_PHASES, dlqLabel, dlqPhase, HOLD_LABELS, isDlqLabel, isHeldBy, loopLabels, recordCount } from './labels.ts';

const labels = (...names: string[]) => names.map((name) => ({ name }));

describe('dead-letter labels', () => {
  it('has one label per phase that runs a machine, and every one is a hold', () => {
    expect(DLQ_PHASES).toEqual(['appraisal', 'carve', 'work', 'review', 'landing']);
    for (const phase of DLQ_PHASES) {
      expect(isDlqLabel(dlqLabel(phase))).toBe(true);
      expect(HOLD_LABELS).toContain(dlqLabel(phase));
    }
  });

  it('reads the phase from the label, and the bare legacy label as the review queue', () => {
    expect(dlqPhase(labels('bug', 'loop/dlq: landing'))).toBe('landing');
    expect(dlqPhase(labels('loop/dlq'))).toBe('review');
    expect(dlqPhase(labels('loop/dlq: nonsense'))).toBeNull();
    expect(dlqPhase(labels('size: 2'))).toBeNull();
  });

  it('does not mistake a counter or an unrelated prefix for a dead letter', () => {
    expect(isDlqLabel('loop/dlq-ish')).toBe(false);
    expect(isDlqLabel('loop/redrives: 2')).toBe(false);
    expect(isDlqLabel('loop/dlq: work')).toBe(true);
  });

  it('holds an issue for the caller\'s skip list or any dead letter', () => {
    expect(isHeldBy(labels('loop/dlq: carve'), ['needs-human'])).toBe(true);
    expect(isHeldBy(labels('needs-human'), ['needs-human'])).toBe(true);
    expect(isHeldBy(labels('size: 3'), ['needs-human'])).toBe(false);
  });
});

describe('the labels the loop creates', () => {
  it('keeps every description under the 100 characters GitHub accepts, and lists every queue', () => {
    const labels = loopLabels();
    for (const [name, , description] of labels) expect(description.length, name).toBeLessThanOrEqual(100);
    for (const phase of DLQ_PHASES) expect(labels.map(([name]) => name)).toContain(dlqLabel(phase));
  });
});

describe('counters', () => {
  it('reads the redrives counter like the others, taking the max of a torn increment', () => {
    expect(countOf('redrives', labels('loop/redrives: 1', 'loop/redrives: 2'))).toBe(2);
    expect(countOf('redrives', labels('loop/reviews: 3'))).toBe(0);
  });
});

describe('the label a count is written as', () => {
  // Which labels were ensured is remembered per repository for the life of the process, so every
  // case works in a repository of its own.
  function rig(repo: string) {
    const io = new FakeTracker('loop-bot', [fakeIssue(1), fakeIssue(2)]);
    const lines: string[] = [];
    const ctx = { botLogin: 'loop-bot', runId: 'host-1-1', dryRun: false, dryRunLog: [], project: { repo }, log: (m: string) => lines.push(m), io } as unknown as Context;
    const created = () => io.writes.filter((w) => w.argv[1] === 'label' && w.argv[2] === 'create').length;
    const on = (n: number) => io.view(n)!.labels.map((l) => l.name);
    return { io, ctx, lines, created, on };
  }

  it('is ensured once per process, and never announced as created', () => {
    const r = rig('o/ensure-once');
    recordCount(r.ctx, 'reviews', 1, 0);
    recordCount(r.ctx, 'reviews', 2, 0);
    expect(r.created()).toBe(1);
    expect(r.on(1)).toContain('loop/reviews: 1');
    expect(r.on(2)).toContain('loop/reviews: 1');
    expect(r.lines.filter((l) => /create label/.test(l))).toEqual([]);
  });

  it('may already exist: the refusal is expected and the count is still written', () => {
    const r = rig('o/already-there');
    r.io.repoLabels.add('loop/attempts: 1');
    expect(recordCount(r.ctx, 'attempts', 1, 0)).toBe(1);
    expect(r.on(1)).toContain('loop/attempts: 1');
  });

  it('that cannot be ensured for any other reason throws, writes no count, and is tried again', () => {
    const r = rig('o/refused');
    r.io.throwOn = /ensure label/;
    expect(() => recordCount(r.ctx, 'carves', 1, 0)).toThrow(/injected failure/);
    expect(r.on(1)).toEqual([]);
    expect(recordCount(r.ctx, 'carves', 1, 0)).toBe(1);
    expect(r.created()).toBe(1);
    expect(r.on(1)).toContain('loop/carves: 1');
  });

  it('is not ensured again for a failure that is not a missing label: that one is the caller\'s to know about', () => {
    const r = rig('o/other-failure');
    recordCount(r.ctx, 'reviews', 1, 0);
    r.io.beforeWrite = (op) => {
      if (op.argv.includes('--add-label')) throw new Error('HTTP 403: Resource not accessible by integration');
    };
    expect(() => recordCount(r.ctx, 'reviews', 2, 0)).toThrow(/403/);
    // One label create in all, from the first count: the refusal bought no second create and no second mark.
    expect(r.created()).toBe(1);
  });

  it('that was deleted after it was ensured is ensured afresh, and the count is not lost', () => {
    const r = rig('o/deleted-mid-run');
    // Like gh: a label the repository does not have cannot be put on an issue.
    r.io.beforeWrite = (op) => {
      const at = op.argv.indexOf('--add-label');
      if (at > -1 && !r.io.repoLabels.has(op.argv[at + 1])) throw new Error(`'${op.argv[at + 1]}' not found`);
    };
    recordCount(r.ctx, 'redrives', 1, 0);
    r.io.repoLabels.delete('loop/redrives: 1');
    expect(recordCount(r.ctx, 'redrives', 2, 0)).toBe(1);
    expect(r.created()).toBe(2);
    expect(r.on(2)).toContain('loop/redrives: 1');
  });
});

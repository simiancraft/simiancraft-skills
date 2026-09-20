import { describe, expect, it } from 'bun:test';
import { countOf, DLQ_PHASES, dlqLabel, dlqPhase, HOLD_LABELS, isDlqLabel, isHeldBy, loopLabels } from './labels.ts';

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

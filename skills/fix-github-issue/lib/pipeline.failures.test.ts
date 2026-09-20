import { describe, expect, it } from 'bun:test';
import { phaseOfLane } from './pipeline.ts';

describe('the queue that owns a thrown failure', () => {
  it('is the queue of the lane the card was in', () => {
    expect(phaseOfLane('E2')).toBe('review');
    expect(phaseOfLane('F3')).toBe('landing');
    expect(phaseOfLane('F2')).toBe('landing');
    expect(phaseOfLane('A2')).toBe('appraisal');
    expect(phaseOfLane('C4')).toBe('carve');
  });
  it('is the work queue for the work lanes, and for a card never moved', () => {
    expect(phaseOfLane('D1')).toBe('work');
    expect(phaseOfLane('D4')).toBe('work');
    expect(phaseOfLane(undefined)).toBe('work');
  });
});

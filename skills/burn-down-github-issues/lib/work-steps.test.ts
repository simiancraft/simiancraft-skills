import { describe, expect, it } from 'bun:test';
import { fire, laneKey, laneState } from './simulate.ts';

/** Facts as a set of the guards that hold. */
const holding = (...guards: string[]) => (guard: string) => guards.includes(guard);
const lane = (state: string, event: string, ...guards: string[]) => {
  const settled = fire(laneState(state), event, holding(...guards));
  return settled ? { lane: laneKey(settled.state), actions: settled.actions } : null;
};

describe('the work turn is steps, and a step ends at a durable fact', () => {
  it('dispatches Prove from the announcement that ends a Code step, first attempt or revision', () => {
    expect(lane('D1', 'CODE_ANNOUNCED')).toEqual({ lane: 'D2', actions: expect.arrayContaining(['runProver']) });
    expect(lane('D4', 'CODE_ANNOUNCED')).toEqual({ lane: 'D2', actions: expect.arrayContaining(['runProver']) });
  });

  it('sends a proof that cannot be done back a step, and spends an attempt on it', () => {
    expect(lane('D2', 'PROOF_REFUSED', 'attemptsUnderCap', 'noOpenPr')).toEqual({ lane: 'D1', actions: expect.arrayContaining(['countAttempt', 'runWorker']) });
  });

  it('goes back to a revision, not to a first Code step, when a pull request already exists', () => {
    const back = lane('D2', 'PROOF_REFUSED', 'attemptsUnderCap');
    expect(back?.lane).toBe('D4');
    expect(back?.actions).toEqual(expect.arrayContaining(['countAttempt', 'runWorkerRevision']));
  });

  it('dead-letters a refused proof in the work queue once the attempts are spent', () => {
    const spent = lane('D2', 'PROOF_REFUSED');
    expect(spent?.lane).toBe('Q3');
    expect(spent?.actions).toEqual(expect.arrayContaining(['countAttempt', 'labelDlq']));
  });

  it('sends a review that wants more evidence to Prove alone, and one that objects to the code to a revision', () => {
    const more = lane('E2', 'REVIEWED', 'reviewRoundsUnderCap', 'decisionGatherMore');
    expect(more?.lane).toBe('D2');
    expect(more?.actions).toEqual(expect.arrayContaining(['spendRound', 'runProver']));
    expect(more?.actions).not.toContain('runWorkerRevision');
    expect(lane('E2', 'REVIEWED', 'reviewRoundsUnderCap')?.lane).toBe('D4');
  });

  it('remembers what the rejection was about across a catch-up', () => {
    expect(lane('F2', 'CAUGHT_UP', 'standingVerdictRejection', 'rejectionWantsEvidence', 'reviewRoundsUnderCap')?.lane).toBe('D2');
    expect(lane('F2', 'CAUGHT_UP', 'standingVerdictRejection', 'reviewRoundsUnderCap')?.lane).toBe('D4');
  });

  it('still catches a stale lane up before either, whatever the reviewer asked for', () => {
    expect(lane('E2', 'REVIEWED', 'reviewRoundsUnderCap', 'behindBase', 'decisionGatherMore')?.lane).toBe('F2');
  });
});

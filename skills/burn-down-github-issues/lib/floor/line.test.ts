import { describe, expect, it } from 'bun:test';
import { combineCauses, type FloorCause, floorReason, lineHolds, readPause } from './line.ts';

describe('reading a pause from the line switch', () => {
  it('reads a reason without the floor prefix as a person\'s', () => {
    expect(readPause('releasing tonight')).toEqual({ by: 'person' });
  });
  it('reads the cause the floor recorded', () => {
    expect(readPause(floorReason('outside-repository', 'liveness is down'))).toEqual({ by: 'floor', cause: 'outside-repository' });
    expect(readPause(floorReason('cause-unknown', 'x is absent'))).toEqual({ by: 'floor', cause: 'cause-unknown' });
  });
  it('reads a host pause as the host\'s, neither a person\'s nor the floor\'s', () => {
    expect(readPause('host: a host fault (ENOSPC); fix the host, then write go to this file')).toEqual({ by: 'host' });
  });
  it('reads a floor pause that recorded no cause as undiagnosed', () => {
    expect(readPause('floor: liveness is down; see the ledger on the floor')).toEqual({ by: 'floor', cause: 'undiagnosed' });
  });
});

describe('the cause over several wrong items', () => {
  it('is an outage only when every remedy is outside the repository', () => {
    expect(combineCauses(['outside-repository', 'outside-repository'])).toBe('outside-repository');
    expect(combineCauses(['outside-repository', 'in-repository'])).toBe('in-repository');
    expect(combineCauses(['outside-repository', 'cause-unknown'])).toBe('cause-unknown');
    expect(combineCauses(['in-repository', 'undiagnosed'])).toBe('undiagnosed');
  });
});

describe('the seams a pause holds', () => {
  const floor = (cause: FloorCause) => ({ state: 'pause' as const, reason: floorReason(cause, 'liveness is down') });
  const person = { state: 'pause' as const, reason: 'releasing tonight' };

  it('an outage holds only the merge: new lanes start and appraisal goes on', () => {
    expect(lineHolds(floor('outside-repository'), 'dispatch')).toBe(false);
    expect(lineHolds(floor('outside-repository'), 'appraisal')).toBe(false);
    expect(lineHolds(floor('outside-repository'), 'merge')).toBe(true);
  });

  it('a repair starts no new lane, whether the cause is ours, unknown, or not yet diagnosed', () => {
    for (const cause of ['in-repository', 'cause-unknown', 'undiagnosed'] as const) {
      expect(lineHolds(floor(cause), 'dispatch')).toBe(true);
      expect(lineHolds(floor(cause), 'appraisal')).toBe(true);
      expect(lineHolds(floor(cause), 'merge')).toBe(true);
    }
    expect(lineHolds({ state: 'pause', reason: 'floor: liveness is down' }, 'dispatch')).toBe(true);
  });

  it('an incident fix passes the floor\'s own pause of any cause, never a person\'s', () => {
    for (const cause of ['in-repository', 'cause-unknown', 'undiagnosed', 'outside-repository'] as const) expect(lineHolds(floor(cause), 'merge', true)).toBe(false);
    expect(lineHolds(person, 'merge', true)).toBe(true);
  });

  it('a host pause holds every seam, an incident fix\'s merge included', () => {
    const host = { state: 'pause' as const, reason: 'host: a host fault (ENOMEM)' };
    for (const seam of ['appraisal', 'dispatch', 'merge'] as const) expect(lineHolds(host, seam, true)).toBe(true);
  });

  it('a person\'s pause holds every seam; go holds none', () => {
    for (const seam of ['appraisal', 'dispatch', 'merge'] as const) {
      expect(lineHolds(person, seam)).toBe(true);
      expect(lineHolds({ state: 'go', reason: '' }, seam)).toBe(false);
    }
  });
});

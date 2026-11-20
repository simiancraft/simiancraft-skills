import { describe, expect, it } from 'bun:test';
import { combineCauses, floorReason, readPause } from './line.ts';

describe('reading a pause from the line switch', () => {
  it('reads a reason without the floor prefix as a person\'s', () => {
    expect(readPause('releasing tonight')).toEqual({ by: 'person' });
  });
  it('reads the cause the floor recorded', () => {
    expect(readPause(floorReason('outside-repository', 'liveness is down'))).toEqual({ by: 'floor', cause: 'outside-repository' });
    expect(readPause(floorReason('cause-unknown', 'x is absent'))).toEqual({ by: 'floor', cause: 'cause-unknown' });
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

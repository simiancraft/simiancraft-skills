import { describe, expect, it } from 'bun:test';
import { clock, renderReadout } from './readout.ts';

const AT = new Date('2026-03-03T22:56:00Z');

describe('renderReadout', () => {
  it('orders the sections, nests children, and keeps one-liners inline', () => {
    const text = renderReadout({
      at: AT,
      timeZone: 'America/Chicago',
      sections: {
        waiting: ['May I delete the old plan?'],
        health: ['all processes alive'],
        landed: ['a1b2c3d merged', { text: 'two checks', children: ['lint pass', 'test pass'] }],
      },
    });
    expect(text).toBe(
      [
        '16:56 CST',
        '',
        '- ✅ Landed:',
        '  - a1b2c3d merged',
        '  - two checks',
        '    - lint pass',
        '    - test pass',
        '- 🩺 Health: all processes alive',
        '- ⛔ Waiting on you: May I delete the old plan?',
      ].join('\n'),
    );
  });

  it('says nothing is waiting rather than leaving the reader to infer it', () => {
    expect(renderReadout({ at: AT, timeZone: 'UTC', sections: {} })).toBe('22:56 UTC\n\n- ⛔ Nothing waiting on you.');
  });

  it('renames a section without moving it, and flattens multi-line text', () => {
    const text = renderReadout({ at: AT, timeZone: 'UTC', title: 'floor walk', labels: { landed: 'Verified' }, sections: { landed: ['line one\n  line two'] } });
    expect(text.split('\n')[0]).toBe('22:56 UTC · floor walk');
    expect(text).toContain('- ✅ Verified: line one line two');
  });
});

describe('clock', () => {
  it('uses a 24-hour clock, midnight included', () => {
    expect(clock(new Date('2026-03-04T00:05:00Z'), 'UTC')).toBe('00:05 UTC');
  });
});

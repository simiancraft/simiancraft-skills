import { describe, expect, it } from 'bun:test';
import { clock, elapsed, renderReadout } from './readout.ts';

const AT = new Date('2026-03-03T22:56:00Z');
const SINCE = new Date('2026-03-03T21:44:00Z');

describe('renderReadout', () => {
  it('keeps the producer order, drops empty sections, nests labelled groups, and puts ⛔ last', () => {
    const text = renderReadout({
      at: AT,
      since: SINCE,
      timeZone: 'America/Chicago',
      needsYou: ['May I delete the old plan?'],
      sections: [
        { emoji: '🧱', lines: ['#214 stuck 25 min on the lint gate'] },
        { emoji: '🧪', label: 'Tests', lines: ['  '] },
        { emoji: '✅', label: 'Landed', lines: ['a1b2c3d merged', { text: 'two checks', children: ['lint pass', 'test pass'] }] },
      ],
    });
    expect(text).toBe(
      [
        '16:56 CST · 1h 12m in',
        '',
        '- 🧱 #214 stuck 25 min on the lint gate',
        '- ✅ Landed:',
        '  - a1b2c3d merged',
        '  - two checks',
        '    - lint pass',
        '    - test pass',
        '- ⛔ Needs you: May I delete the old plan?',
      ].join('\n'),
    );
  });

  it('gives an unlabelled group one bullet per line, never a bare emoji heading', () => {
    const text = renderReadout({ at: AT, since: AT, timeZone: 'UTC', sections: [{ emoji: '⚠️', lines: ['slow step', 'flaky check'] }] });
    expect(text).toContain('- ⚠️ slow step\n- ⚠️ flaky check');
  });

  it('says nothing needs you with its own emoji, so ⛔ alone means you are needed', () => {
    expect(renderReadout({ at: AT, since: AT, timeZone: 'UTC', sections: [] })).toBe('22:56 UTC · <1m in\n\n- 🟢 Nothing needs you.');
  });

  it('moves a ⛔ section into the requests at the end', () => {
    const text = renderReadout({ at: AT, since: AT, timeZone: 'UTC', sections: [{ emoji: '⛔', lines: ['approve the migration?'] }, { emoji: '✅', lines: ['done'] }] });
    expect(text.split('\n').at(-1)).toBe('- ⛔ Needs you: approve the migration?');
    expect(text).not.toContain('Nothing needs you');
  });

  it('carries a title and flattens multi-line text and labels', () => {
    const text = renderReadout({ at: AT, since: SINCE, timeZone: 'UTC', title: 'floor walk', sections: [{ emoji: '✅', label: 'Ver\nified', lines: ['line one\n  line two'] }] });
    expect(text.split('\n')[0]).toBe('22:56 UTC · 1h 12m in · floor walk');
    expect(text).toContain('- ✅ Ver ified: line one line two');
  });
});

describe('the header', () => {
  it('uses a 24-hour clock, midnight included', () => {
    expect(clock(new Date('2026-03-04T00:05:00Z'), 'UTC')).toBe('00:05 UTC');
  });
  it('says how long the work has been running, up to days', () => {
    expect(elapsed(new Date('2026-03-03T22:55:30Z'), AT)).toBe('<1m');
    expect(elapsed(new Date('2026-03-03T22:44:00Z'), AT)).toBe('12m');
    expect(elapsed(new Date('2026-03-03T19:56:00Z'), AT)).toBe('3h');
    expect(elapsed(new Date('2026-03-01T21:56:00Z'), AT)).toBe('2d 1h');
    expect(elapsed(new Date('not a date'), AT)).toBeNull();
  });
});

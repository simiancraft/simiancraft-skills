import { describe, expect, it } from 'bun:test';
import { isBotMarker } from '../../carve-github-issue/lib/tree.ts';
import { LOOP_NOTE, loopNote } from './note.ts';

describe('loopNote', () => {
  it('marks an unmarked loop comment so readers can tell it from a person', () => {
    const body = loopNote('Moved to the work dead-letter queue.');
    expect(body.startsWith(LOOP_NOTE)).toBe(true);
    expect(isBotMarker({ author: 'bot', body } as never, 'bot')).toBe(true);
  });
  it('leaves a body that already opens with a marker alone', () => {
    const body = '<!-- carve-unclaim kind=carving run=r -->';
    expect(loopNote(body)).toBe(body);
  });
});

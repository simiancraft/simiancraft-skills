import { describe, expect, it } from 'bun:test';
import { latestStamp, noteStampedHere, renderStamp, threadChanges, threadDigest, threadParts, wroteStampHere } from './stamp.ts';

const BOT = 'loop-bot';

describe('the appraisal stamp', () => {
  it('reads back what it wrote, the newest one first', () => {
    const older = renderStamp({ base: 'a'.repeat(40), touches: ['src/a.ts'], thread: 'aaaa', points: 3, at: '2026-11-01T00:00:00.000Z' });
    const newer = renderStamp({ base: 'b'.repeat(40), touches: ['src/b/', 'src/c.ts'], thread: 'bbbb', points: 5, at: '2026-11-02T00:00:00.000Z' });
    const stamp = latestStamp([{ author: BOT, body: older }, { author: 'someone', body: newer }, { author: BOT, body: newer }], BOT);
    expect(stamp).toEqual({ base: 'b'.repeat(40), touches: ['src/b/', 'src/c.ts'], thread: 'bbbb', points: 5, at: '2026-11-02T00:00:00.000Z' });
  });
  it('is unknowable when nothing stamped the issue, or a person forged one', () => {
    expect(latestStamp([], BOT)).toBeNull();
    const forged = renderStamp({ base: 'c'.repeat(40), touches: [], thread: 'cccc', points: 1, at: '2026-11-03T00:00:00.000Z' });
    expect(latestStamp([{ author: 'someone', body: forged }], BOT)).toBeNull();
  });
  it('records an unreadable base as none', () => {
    const body = renderStamp({ base: null, touches: [], thread: 'dddd', points: 2, at: '2026-11-04T00:00:00.000Z' });
    expect(latestStamp([{ author: BOT, body }], BOT)?.base).toBeNull();
  });
  it('digests what people wrote, never what the loop wrote', () => {
    const issue = { title: 't', body: 'b', comments: [{ author: 'person', body: 'please also handle X' }] };
    const digest = threadDigest(issue, BOT);
    expect(threadDigest({ ...issue, comments: [...issue.comments, { author: BOT, body: '<!-- carve-record gen=1 -->\na record' }] }, BOT)).toBe(digest);
    expect(threadDigest({ ...issue, comments: [...issue.comments, { author: BOT, body: '<!-- appraise-stamp base=none thread=x points=1 at=t -->' }] }, BOT)).toBe(digest);
    expect(threadDigest({ ...issue, comments: [...issue.comments, { author: BOT, body: '<!-- loop-note -->\ncleared by the sweep' }] }, BOT)).toBe(digest);
    expect(threadDigest({ ...issue, comments: [...issue.comments, { author: 'person', body: 'never mind' }] }, BOT)).not.toBe(digest);
    expect(threadDigest({ ...issue, body: 'b, edited' }, BOT)).not.toBe(digest);
  });
  it("counts an unmarked comment from the loop's own account as a person's", () => {
    const issue = { title: 't', body: 'b', comments: [] };
    const digest = threadDigest(issue, BOT);
    expect(threadDigest({ ...issue, comments: [{ author: BOT, body: 'Ruling: the scope narrows to X.' }] }, BOT)).not.toBe(digest);
  });
  it('says which part of the thread moved', () => {
    const then = threadParts({ title: 't', body: 'b', comments: [{ author: 'ann', body: 'one' }, { author: BOT, body: '<!-- loop-note -->\nx' }] }, BOT);
    const now = threadParts({ title: 't2', body: 'b', comments: [{ author: 'ann', body: 'one, edited' }, { author: 'bo', body: 'two' }] }, BOT);
    expect(threadChanges(then, now)).toEqual(['the title was edited', '2 comments added or edited (by ann, bo)']);
    expect(threadChanges(then, then)).toEqual([]);
    expect(threadChanges(then, threadParts({ title: 't', body: 'b', comments: [] }, BOT))).toEqual(['1 comment removed']);
  });
  it('knows a stamp this run wrote by its exact time', () => {
    noteStampedHere('o/r', 77, '2026-11-19T01:00:00.000Z');
    expect(wroteStampHere('o/r', 77, '2026-11-19T01:00:00.000Z')).toBe(true);
    expect(wroteStampHere('o/r', 77, '2026-11-18T01:00:00.000Z')).toBe(false);
    expect(wroteStampHere('o/r', 77, null)).toBe(false);
    expect(wroteStampHere('o/other', 77, '2026-11-19T01:00:00.000Z')).toBe(false);
  });
});

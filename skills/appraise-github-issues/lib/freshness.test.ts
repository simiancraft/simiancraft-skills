import { describe, expect, it } from 'bun:test';
import { appraisalFreshness } from './freshness.ts';
import { renderStamp, threadDigest } from './stamp.ts';

const BOT = 'loop-bot';
const thread = { title: 't', body: 'b', comments: [{ author: 'person', body: 'details' }] };
const stamped = (over: Partial<Parameters<typeof renderStamp>[0]> = {}) => ({
  ...thread,
  comments: [...thread.comments, { author: BOT, body: renderStamp({ base: 'a'.repeat(40), touches: ['src/x.ts'], thread: threadDigest(thread, BOT), points: 5, at: '2026-11-01T00:00:00.000Z', ...over }) }],
});
const none = () => [];

describe('whether an appraisal still describes its issue', () => {
  it('is fresh when nothing it judged moved', () => {
    expect(appraisalFreshness(stamped(), BOT, none)).toEqual({ verdict: 'fresh', reasons: [] });
  });
  it('is unknowable with no stamp, no base, or no paths', () => {
    expect(appraisalFreshness(thread, BOT, none).verdict).toBe('unknowable');
    expect(appraisalFreshness(stamped({ base: null }), BOT, none).verdict).toBe('unknowable');
    expect(appraisalFreshness(stamped({ touches: [] }), BOT, none).verdict).toBe('unknowable');
    expect(appraisalFreshness(stamped(), BOT, () => { throw new Error('bad revision'); }).verdict).toBe('unknowable');
  });
  it('is stale when commits landed on its paths or a person wrote on the thread', () => {
    const moved = appraisalFreshness(stamped(), BOT, (from, paths) => (from === 'a'.repeat(40) && paths[0] === 'src/x.ts' ? ['abc1234'] : []));
    expect(moved.verdict).toBe('stale');
    expect(moved.reasons[0]).toMatch(/1 commit on its paths/);
    const edited = stamped();
    edited.comments.push({ author: 'person', body: 'actually, also Y' });
    expect(appraisalFreshness(edited, BOT, none).verdict).toBe('stale');
  });
  it('is not moved by the loop writing on the thread', () => {
    const later = stamped();
    later.comments.push({ author: BOT, body: 'a carving record' });
    expect(appraisalFreshness(later, BOT, none).verdict).toBe('fresh');
  });
});

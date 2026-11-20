import { describe, expect, it } from 'bun:test';
import { appraisalFreshness, type CommitsSince } from './freshness.ts';
import { renderStamp, threadDigest, threadParts } from './stamp.ts';

const BOT = 'loop-bot';
const thread = { title: 't', body: 'b', comments: [{ author: 'person', body: 'details' }] };
const stamped = (over: Partial<Parameters<typeof renderStamp>[0]> = {}) => ({
  ...thread,
  comments: [
    ...thread.comments,
    { author: BOT, body: renderStamp({ base: 'a'.repeat(40), touches: ['src/x.ts'], thread: threadDigest(thread, BOT), parts: threadParts(thread, BOT), points: 5, at: '2026-11-01T00:00:00.000Z', ...over }) },
  ],
});
const none: CommitsSince = () => [];
const checks = (commitsSince: CommitsSince = none) => ({ commitsSince });

describe('whether an appraisal still describes its issue', () => {
  it('is fresh when nothing it judged moved, and names the stamp it read', () => {
    expect(appraisalFreshness(stamped(), BOT, checks())).toEqual({ verdict: 'fresh', reasons: [], scope: 'thread-and-paths', stampAt: '2026-11-01T00:00:00.000Z', stampBase: 'a'.repeat(40) });
  });
  it('reads a stamp that named no paths from its thread alone, and says so', () => {
    const asked: string[][] = [];
    const spike = appraisalFreshness(stamped({ touches: [] }), BOT, checks((_, paths) => { asked.push(paths); return ['abc1234']; }));
    expect(spike).toMatchObject({ verdict: 'fresh', scope: 'thread-only' });
    expect(spike.reasons[0]).toMatch(/^paths: none/);
    expect(asked).toEqual([]);
    const edited = stamped({ touches: [] });
    edited.body = 'b, rewritten';
    expect(appraisalFreshness(edited, BOT, checks())).toMatchObject({ verdict: 'stale', scope: 'thread-only' });
  });
  it('names the files the commits on its paths changed, when it can read them', () => {
    const moved = appraisalFreshness(stamped(), BOT, { commitsSince: () => ['abc1234'], filesSince: () => ['src/x.ts'] });
    expect(moved).toMatchObject({ verdict: 'stale', movedFiles: ['src/x.ts'] });
  });
  it('is unknowable with no base, or a base git cannot compare, and says which', () => {
    expect(appraisalFreshness(stamped({ base: null }), BOT, checks())).toMatchObject({ verdict: 'unknowable', cause: 'stamp-incomplete' });
    expect(appraisalFreshness(stamped({ touches: null }), BOT, checks())).toMatchObject({ verdict: 'unknowable', cause: 'stamp-incomplete' });
    const broken = appraisalFreshness(stamped(), BOT, checks(() => { throw new Error('bad revision'); }));
    expect(broken).toMatchObject({ verdict: 'unknowable', cause: 'uncheckable' });
  });
  it('tells an appraisal from before stamping apart from a stamp that went missing', () => {
    const since = '2026-11-18T00:00:00.000Z';
    expect(appraisalFreshness(thread, BOT, { commitsSince: none, stampingSince: since, sizedAt: () => '2026-08-01T00:00:00Z' })).toMatchObject({ verdict: 'unknowable', cause: 'never-stamped', stampAt: null });
    expect(appraisalFreshness(thread, BOT, { commitsSince: none, stampingSince: since, sizedAt: () => '2026-11-19T00:00:00Z' })).toMatchObject({ verdict: 'unknowable', cause: 'stamp-missing' });
    const unaccounted = appraisalFreshness(thread, BOT, { commitsSince: none, stampingSince: null, sizedAt: () => { throw new Error('no timeline'); } });
    expect(unaccounted).toMatchObject({ verdict: 'unknowable', cause: 'stamp-unaccounted' });
    expect(unaccounted.reasons[0]).toMatch(/when stamping began or when it was sized is not known/);
  });
  it('is stale when commits landed on its paths', () => {
    const moved = appraisalFreshness(stamped(), BOT, checks((from, paths) => (from === 'a'.repeat(40) && paths[0] === 'src/x.ts' ? ['abc1234'] : [])));
    expect(moved.verdict).toBe('stale');
    expect(moved.reasons[0]).toMatch(/1 commit on its paths/);
  });
  it('is stale when a person wrote on the thread, and says what moved', () => {
    const commented = stamped();
    commented.comments.push({ author: 'person', body: 'actually, also Y' });
    const verdict = appraisalFreshness(commented, BOT, checks());
    expect(verdict.verdict).toBe('stale');
    expect(verdict.reasons[0]).toBe('since the appraisal, 1 comment added or edited (by person)');
    const edited = { ...stamped(), body: 'b, narrowed' };
    expect(appraisalFreshness(edited, BOT, checks()).reasons[0]).toBe('since the appraisal, the body was edited');
  });
  it('falls back to a plain reason on a stamp written before parts were recorded', () => {
    const old = stamped({ parts: undefined });
    old.comments.push({ author: 'person', body: 'more' });
    expect(appraisalFreshness(old, BOT, checks()).reasons[0]).toBe('the thread changed since the appraisal');
  });
  it('is not moved by the loop writing on the thread', () => {
    const later = stamped();
    later.comments.push({ author: BOT, body: '<!-- carve-record gen=1 -->\na carving record' });
    expect(appraisalFreshness(later, BOT, checks()).verdict).toBe('fresh');
  });
});

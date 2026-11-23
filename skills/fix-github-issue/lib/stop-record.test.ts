import { describe, expect, it } from 'bun:test';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import { isBotMarker } from '../../carve-github-issue/lib/tree.ts';
import type { Context } from './context.ts';
import { parkIssue, sendToDlq } from './labels.ts';
import { landBlocker } from './land.ts';
import { heldComment, loopHoldStands, objectionAfter, proofHeldComment, readStop, standingStop, stopComment, stopIn } from './stop-record.ts';

const BOT = 'loop-bot';
const BOUNDARY = 'autoMerge is code-only and the change touches code, stored-string';

/** The comment each writer leaves, captured from a fake tracker. */
function written(write: (ctx: Context) => void): string {
  const io = new FakeTracker(BOT, [fakeIssue(1)]);
  const ctx = { botLogin: BOT, runId: 'host-1-1', dryRun: false, dryRunLog: [], project: { repo: 'o/stop-record' }, log: () => {}, io } as unknown as Context;
  write(ctx);
  return io.view(1)!.comments.at(-1)!.body;
}

describe('the stop record: every stop writer leaves one, read back as its kind', () => {
  it('a park, a boundary park, and a dead letter, with their words kept', () => {
    const park = written((ctx) => parkIssue(ctx, 1, 'the issue changed under the review'));
    expect(stopIn(park)).toEqual({ kind: 'park', fields: {}, text: 'the issue changed under the review' });
    const boundary = written((ctx) => parkIssue(ctx, 1, BOUNDARY, 'boundary'));
    expect(stopIn(boundary)).toEqual({ kind: 'boundary', fields: {}, text: BOUNDARY });
    const dlq = written((ctx) => sendToDlq(ctx, 1, 'landing', 'checks failed: ci (FAILURE)'));
    const read = stopIn(dlq);
    expect(read?.kind).toBe('dead-letter');
    expect(read?.fields).toEqual({ phase: 'landing' });
    expect(read?.text.startsWith('Moved to the landing dead-letter queue.\n\nchecks failed: ci (FAILURE)')).toBe(true);
  });

  it('a held proof and a seat\'s ask', () => {
    expect(stopIn(proofHeldComment('run-1', { branch: 'fix/x-1', pr: 7 }, 'needs credentials'))).toMatchObject({ kind: 'proof-held', fields: { run: 'run-1', branch: 'fix/x-1', pr: '7' } });
    expect(stopIn(heldComment('needs-decision', 'which schema?'))).toEqual({ kind: 'held', fields: { verdict: 'needs-decision' }, text: 'which schema?' });
  });

  it('is a loop marker, so a fingerprint of the thread leaves it out, and refuses a field that is not one token', () => {
    expect(isBotMarker({ author: BOT, body: stopComment('park', {}, 'x') } as never, BOT)).toBe(true);
    expect(() => stopComment('approved', { sha: 'a b' }, 'x')).toThrow(/one token/);
    expect(stopComment('approved', { sha: 'abc', pr: undefined }, 'x').split('\n')[0]).toBe('<!-- loop-stop kind=approved sha=abc -->');
  });
});

describe("an old thread, written by main's code before the stop record", () => {
  it('reads the loop-note words: a dead letter, a park, and the boundary', () => {
    expect(stopIn('<!-- loop-note -->\nMoved to the work dead-letter queue.\n\nx')?.kind).toBe('dead-letter');
    expect(stopIn('<!-- loop-note -->\nParked: the merge boundary refused it.')).toEqual({ kind: 'park', fields: {}, text: 'Parked: the merge boundary refused it.' });
    expect(stopIn(`<!-- loop-note -->\n${BOUNDARY}`)?.kind).toBe('boundary');
    expect(stopIn(BOUNDARY)?.kind).toBe('boundary');
  });
  it('reads the two older markers as their kinds', () => {
    expect(stopIn('<!-- loop-proof-held run=r branch=fix/x-1 pr=7 -->\n**Held**')).toMatchObject({ kind: 'proof-held', fields: { pr: '7' } });
    expect(stopIn('<!-- loop-held verdict=needs-human -->\nthe coder needs the vendor key')).toEqual({ kind: 'held', fields: { verdict: 'needs-human' }, text: 'the coder needs the vendor key' });
  });
  it('reads nothing else as a stop: a sweep note, a coded step, a person\'s words', () => {
    expect(stopIn('<!-- loop-note -->\nCleared by the sweep.')).toBeNull();
    expect(stopIn('<!-- loop-step coded run=r branch=b sha=s gated=s touches=code -->\nthe handoff says it was parked')).toBeNull();
    expect(stopIn('a person asks a question')).toBeNull();
  });
  it('lets --land through on an old boundary park and refuses an old park of another kind', () => {
    const at = '2026-10-28T20:05:00Z';
    expect(landBlocker(['loop/parked'], [{ body: `<!-- loop-note -->\n${BOUNDARY}`, createdAt: at }], at)).toBeNull();
    expect(landBlocker(['loop/parked'], [{ body: '<!-- loop-note -->\nParked: something else', createdAt: at }], at)).toMatch(/not the merge boundary/);
  });
});

describe('readStop: one reader, one scope', () => {
  const at = (body: string, createdAt: string, author = BOT) => ({ author, body, createdAt });
  const park = stopComment('park', {}, 'parked for a reason');
  const held = proofHeldComment('run-1', { branch: 'fix/x-1', pr: 7 }, 'needs credentials');
  it('the newest of the loop\'s own records wins', () => {
    expect(readStop([at(park, '2026-09-01'), at(held, '2026-09-02')], { botLogin: BOT })?.kind).toBe('proof-held');
    expect(readStop([at(held, '2026-09-01'), at(park, '2026-09-02')], { botLogin: BOT })?.kind).toBe('park');
    expect(readStop([at(park, '2026-09-01'), at(held, '2026-09-02', 'someone')], { botLogin: BOT })?.kind).toBe('park');
  });
  it('only since the pull request in hand was opened', () => {
    expect(readStop([at(park, '2026-09-01')], { botLogin: BOT, since: '2026-09-02' })).toBeNull();
    expect(readStop([at(park, '2026-09-03')], { botLogin: BOT, since: '2026-09-02' })?.kind).toBe('park');
  });
  it('hands a coder an objection only for a park or a dead letter', () => {
    const after = (body: string) => objectionAfter(standingStop([{ author: BOT, body }], BOT));
    expect(after(park)).toBe('parked for a reason');
    expect(after(stopComment('dead-letter', { phase: 'work' }, 'Moved to the work dead-letter queue.'))).toBe('Moved to the work dead-letter queue.');
    expect(after(stopComment('boundary', {}, BOUNDARY))).toBeNull();
    expect(after(held)).toBeNull();
    expect(objectionAfter(null)).toBeNull();
  });
  it('standingStop reads a boundary park and an approval as neither an objection nor a hold', () => {
    expect(standingStop([{ author: BOT, body: stopComment('boundary', {}, BOUNDARY) }], BOT)).toEqual({ kind: 'boundary' });
    expect(standingStop([{ author: BOT, body: stopComment('approved', { sha: 'abc' }, 'Approved') }], BOT)).toEqual({ kind: 'approved', sha: 'abc' });
  });
});

describe('landBlocker reads the stop record', () => {
  const at = (minute: number) => `2026-10-28T20:${String(minute).padStart(2, '0')}:00Z`;
  it('a boundary record lets --land through; a park record does not', () => {
    expect(landBlocker(['loop/parked'], [{ body: stopComment('boundary', {}, BOUNDARY), createdAt: at(5) }], at(5))).toBeNull();
    expect(landBlocker(['loop/parked'], [{ body: stopComment('boundary', {}, BOUNDARY), createdAt: at(5) }, { body: stopComment('park', {}, 'the issue changed under the review'), createdAt: at(9) }], at(9))).toMatch(/not the merge boundary/);
  });
});

describe('an outside stop on the thread', () => {
  const outside = (cause: string, seat: string, text = 'stopped outside the change') => ({ author: BOT, body: stopComment('outside', { cause, seat }, text) });
  const park = { author: BOT, body: stopComment('park', {}, 'answer the review') };
  it('carries the stop behind it, so a rerun answers the same objection', () => {
    const stop = standingStop([park, outside('host', 'reviewer')], BOT);
    expect(stop).toMatchObject({ kind: 'outside', cause: 'host', seat: 'reviewer', behind: { kind: 'objection', text: 'answer the review' } });
    expect(objectionAfter(stop)).toBe('answer the review');
    expect(loopHoldStands(stop)).toBe(false);
  });
  it("is the loop's hold when it waits on a person, and hands the coder its own words when nothing stands behind it", () => {
    const held = standingStop([outside('needs-person', 'coder', 'the gate needs a vendor key')], BOT);
    expect(loopHoldStands(held)).toBe(true);
    expect(objectionAfter(held)).toBe('the gate needs a vendor key');
    expect(loopHoldStands(standingStop([outside('base', 'coder')], BOT))).toBe(true);
    // A rerun cause with nothing behind it is no objection: the pickup proves again.
    expect(objectionAfter(standingStop([outside('signal', 'prover')], BOT))).toBeNull();
  });
  it('a held proof is the loop\'s hold too, and a seat\'s ask is not', () => {
    expect(loopHoldStands(standingStop([{ author: BOT, body: proofHeldComment('r', { branch: 'b' }, 'x') }], BOT))).toBe(true);
    expect(loopHoldStands(standingStop([{ author: BOT, body: heldComment('needs-human', 'x') }], BOT))).toBe(false);
  });
});

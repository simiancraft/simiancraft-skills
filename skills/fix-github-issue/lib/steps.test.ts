import { describe, expect, it } from 'bun:test';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import { isBotMarker } from '../../carve-github-issue/lib/tree.ts';
import type { Context } from './context.ts';
import { announceStep, everyStep, newestStep, parseStepMarker, placeInWork, readWorkFacts, renderStepMarker, type StepMarker, type WorkFacts, type WorkReads } from './steps.ts';

const BOT = 'loop-bot';
const S = 'a'.repeat(40);
const T = 'b'.repeat(40);
const coded: StepMarker = { step: 'coded', runId: 'host-1-1', sha: S, gated: S, touches: ['code'], handoff: 'Changed the parser to reject a trailing comma.\nExercise: `bun test parser`.' };

describe('a step marker', () => {
  it('survives the round trip, hand-off and all', () => {
    expect(parseStepMarker(renderStepMarker(coded))).toEqual(coded);
    expect(parseStepMarker(renderStepMarker({ ...coded, touches: [] }))?.touches).toEqual([]);
  });

  it('is nothing a driver acts on unless it names a known step, a run, and two heads', () => {
    for (const body of ['hello', '<!-- carve-claim kind=working run=x -->', `<!-- loop-step step=shipped run=r sha=${S} gated=${S} -->`, `<!-- loop-step step=coded sha=${S} gated=${S} -->`, `<!-- loop-step step=coded run=r sha=nope gated=${S} -->`, `<!-- loop-step step=coded run=r sha=${S} -->`]) {
      expect(parseStepMarker(body)).toBeNull();
    }
  });

  it('counts only when the loop itself wrote it, and the newest one wins', () => {
    const comments = [
      { author: BOT, body: renderStepMarker(coded) },
      { author: 'a-person', body: renderStepMarker({ ...coded, step: 'refused', sha: T }) },
      { author: BOT, body: 'a plain comment' },
    ];
    expect(newestStep(comments, BOT)?.step).toBe('coded');
    const later = [...comments, { author: BOT, body: renderStepMarker({ ...coded, step: 'refused', sha: T, attempt: 2 }) }];
    expect(newestStep(later, BOT)).toMatchObject({ step: 'refused', sha: T, attempt: 2 });
    // Asked for by kind, the refusal does not hide the hand-off the prover needs.
    expect(newestStep(later, BOT, 'coded')).toMatchObject({ step: 'coded', sha: S });
    expect(everyStep(later, BOT, 'coded')).toHaveLength(1);
    expect(newestStep([], BOT)).toBeNull();
  });

  it('is announced through the tracker, and is a bot marker the knife does not read as a person speaking', () => {
    const io = new FakeTracker(BOT, [fakeIssue(7)]);
    const ctx = { botLogin: BOT, runId: 'host-1-1', dryRun: false, dryRunLog: [], project: { repo: 'o/r' }, log: () => {}, io } as unknown as Context;
    announceStep(ctx, 7, coded);
    const comment = io.view(7)!.comments.at(-1)!;
    expect(parseStepMarker(comment.body)).toEqual(coded);
    expect(isBotMarker(comment, BOT)).toBe(true);
  });
});

describe('placing a card in Work from facts', () => {
  const nothing: WorkFacts = { readyPr: false, draftHead: null, remoteHead: null, marker: null, remoteCarriesMarker: false };

  it('starts Code from nothing', () => {
    expect(placeInWork(nothing)).toEqual({ lane: 'D1', dispatch: 'code', from: 'nothing' });
  });

  it('continues Code from a pushed branch nobody announced: a push is not a statement of completion', () => {
    expect(placeInWork({ ...nothing, remoteHead: S })).toEqual({ lane: 'D1', dispatch: 'code', from: 'branch' });
  });

  it('dispatches Prove from a coded marker whose head the remote branch is at', () => {
    expect(placeInWork({ ...nothing, remoteHead: S, marker: coded, remoteCarriesMarker: true })).toEqual({ lane: 'D2', dispatch: 'prove' });
  });

  it('does not trust a marker the remote branch no longer carries', () => {
    expect(placeInWork({ ...nothing, remoteHead: T, marker: coded, remoteCarriesMarker: false })).toEqual({ lane: 'D1', dispatch: 'code', from: 'branch' });
    expect(placeInWork({ ...nothing, marker: coded })).toEqual({ lane: 'D1', dispatch: 'code', from: 'nothing' });
  });

  it('proves a draft again: only a ready pull request says a proof is done', () => {
    expect(placeInWork({ ...nothing, remoteHead: S, draftHead: S, marker: coded, remoteCarriesMarker: true })).toEqual({ lane: 'D2', dispatch: 'prove' });
  });

  it('sends a ready pull request to review whatever else is true', () => {
    expect(placeInWork({ ...nothing, readyPr: true, marker: coded, remoteCarriesMarker: true })).toEqual({ lane: 'E1', dispatch: 'review' });
  });
});

describe('reading where the work stands, from the remote and the tracker alone', () => {
  const reads = (over: Partial<WorkReads>): WorkReads => ({ marker: () => null, remoteBranches: () => [], workedBefore: () => true, pull: () => null, ...over });

  it('resumes at Prove when a run died after Code announced: the marker and the branch are enough', () => {
    const facts = readWorkFacts(reads({ marker: () => coded, remoteBranches: () => [{ branch: 'fix/x-7', sha: S }] }));
    expect(facts).toMatchObject({ branch: 'fix/x-7', remoteCarriesMarker: true, pr: null });
    expect(placeInWork(facts)).toEqual({ lane: 'D2', dispatch: 'prove' });
  });

  it('does not prove a head that merely descends from the announced one: unfinished work descends from finished work too', () => {
    const facts = readWorkFacts(reads({ marker: () => coded, remoteBranches: () => [{ branch: 'fix/x-7', sha: T }] }));
    expect(facts.remoteCarriesMarker).toBe(false);
    expect(placeInWork(facts)).toEqual({ lane: 'D1', dispatch: 'code', from: 'branch' });
  });

  it('continues Code, with the refusal as its brief, when a run died after a proof was refused', () => {
    const refused: StepMarker = { ...coded, step: 'refused', handoff: 'the endpoint still returns 500 for an empty list' };
    const facts = readWorkFacts(reads({ marker: () => refused, remoteBranches: () => [{ branch: 'fix/x-7', sha: S }] }));
    expect(placeInWork(facts)).toEqual({ lane: 'D1', dispatch: 'code', from: 'refusal' });
    expect(facts.marker?.handoff).toContain('returns 500');
    // And it stands across a catch-up that moved the head: nothing was repaired by merging the base.
    const moved = readWorkFacts(reads({ marker: () => refused, remoteBranches: () => [{ branch: 'fix/x-7', sha: T }] }));
    expect(placeInWork(moved)).toEqual({ lane: 'D1', dispatch: 'code', from: 'refusal' });
  });

  it('continues Code when a run died before the announcement: a pushed branch, no marker', () => {
    const facts = readWorkFacts(reads({ remoteBranches: () => [{ branch: 'fix/x-7', sha: S }] }));
    expect(facts.branch).toBe('fix/x-7');
    expect(placeInWork(facts)).toEqual({ lane: 'D1', dispatch: 'code', from: 'branch' });
  });

  it('adopts no unannounced branch on an issue the loop never worked: a name is not ownership', () => {
    const facts = readWorkFacts(reads({ remoteBranches: () => [{ branch: 'fix/cart-7', sha: S }], workedBefore: () => false }));
    expect(facts.branch).toBeNull();
    expect(placeInWork(facts)).toEqual({ lane: 'D1', dispatch: 'code', from: 'nothing' });
  });

  it('does not guess between two unannounced branches named for the issue', () => {
    const facts = readWorkFacts(reads({ remoteBranches: () => [{ branch: 'fix/a-7', sha: S }, { branch: 'fix/b-7', sha: T }] }));
    expect(facts.branch).toBeNull();
    expect(placeInWork(facts)).toEqual({ lane: 'D1', dispatch: 'code', from: 'nothing' });
  });

  it('picks the branch that carries the marker when there are several', () => {
    const facts = readWorkFacts(reads({ marker: () => coded, remoteBranches: () => [{ branch: 'fix/old-7', sha: T }, { branch: 'fix/x-7', sha: S }] }));
    expect(facts.branch).toBe('fix/x-7');
  });

  it('ignores a marker whose head is on no remote branch: the branch was deleted or rewritten', () => {
    const facts = readWorkFacts(reads({ marker: () => coded, remoteBranches: () => [{ branch: 'fix/x-7', sha: T }] }));
    expect(placeInWork(facts)).toEqual({ lane: 'D1', dispatch: 'code', from: 'branch' });
  });

  it('reads a draft and a ready pull request off the chosen branch', () => {
    const draft = readWorkFacts(reads({ marker: () => coded, remoteBranches: () => [{ branch: 'fix/x-7', sha: S }], pull: () => ({ number: 9, isDraft: true, headRefOid: S }) }));
    expect(draft).toMatchObject({ draftHead: S, readyPr: false, pr: 9 });
    const ready = readWorkFacts(reads({ remoteBranches: () => [{ branch: 'fix/x-7', sha: S }], pull: () => ({ number: 9, isDraft: false, headRefOid: S }) }));
    expect(placeInWork(ready)).toEqual({ lane: 'E1', dispatch: 'review' });
  });
});


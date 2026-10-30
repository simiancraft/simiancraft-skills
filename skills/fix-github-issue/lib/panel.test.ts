import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import type { ProjectConfig } from './config.ts';
import { type Context, createContext } from './context.ts';
import type { Seat } from './engines.ts';
import { type PanelDeps, panelSeats, renderReceipt, validateReview, weighHold } from './panel.ts';

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'panel-'));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PROJECT = { name: 'Test', repo: 'o/panel', remote: 'origin', baseBranch: 'main', evidenceBranch: 'evidence', checkCommand: 'true', installCommand: 'true', conventionDocs: [], sizingScale: 'fib', sharedServices: [], portBase: 9000, portSpan: 10, pathAliases: [], sourceExtensions: ['.ts'], alwaysInvalidates: [], touchPaths: { migration: [], ci: [] }, worktreeRoot: 'wt' } as ProjectConfig;
const ISSUE = 7;
const BASE: Record<string, string> = { 'src/copy.ts': "export const CLAIMED = 'This account is already linked.';\n" };
const deps: PanelDeps = { readAtBase: (_ctx, path) => BASE[path] ?? null, reachable: () => true };

let files = 0;
/** Writes a seat's answers: `<name>.json` for its review, and `<name>.<role>.json` for its other turns. */
function seat(engine: 'fixture' | 'fixture2', answers: { review?: object | null; framer?: object; judge?: object }): Seat {
  const base = join(scratch, `seat-${files++}`);
  if (answers.review !== null) writeFileSync(`${base}.json`, JSON.stringify(answers.review ?? {}));
  if (answers.framer) writeFileSync(`${base}.panel-framer.json`, JSON.stringify(answers.framer));
  if (answers.judge) writeFileSync(`${base}.panel-judge.json`, JSON.stringify(answers.judge));
  return { engine, model: `${base}.json` };
}

const QUESTIONS = { issue: ISSUE, questions: [{ id: 'Q1', text: 'Which message does a linked account see?' }, { id: 'Q2', text: 'Does the second path need its own email?' }] };
const decide = (id: string, answer: string, facts: object[] = []) => ({ id, kind: 'decide', answer, reasoning: 'the existing copy says so', facts });
const review = (...answers: object[]) => ({ issue: ISSUE, answers, review: 'Answers below, with the reasons.' });
const FACT = { path: 'src/copy.ts', quote: "'This account is already linked.'" };
const AGREED = { issue: ISSUE, questions: [{ id: 'Q1', agreed: true, decision: 'Reuse the linked-account message.', reasoning: 'All three reuse the existing string.', wordingRule: 'reuse the existing string' }, { id: 'Q2', agreed: true, decision: 'No; it reuses the first email.', reasoning: 'All three reuse it.' }] };

function context(io: FakeTracker, others: Seat[]): Context {
  return createContext({
    project: PROJECT,
    knobs: { autoMerge: 'never', maxReviewRounds: 3, checksTimeoutMinutes: 1, smokeTimeoutMinutes: 1 },
    seats: { worker: { engine: 'fixture' }, reviewer: { engine: 'fixture2' } },
    repoRoot: scratch,
    invokeRoot: scratch,
    promptsDirs: [],
    dryRun: false,
    runDir: join(scratch, 'runs'),
    botLogin: 'loop-bot',
    io,
    log: () => {},
    step: () => {},
    panel: { seats: others, maxPanels: 2, effort: 'high' },
  });
}

const tracker = (labels: string[] = []) => new FakeTracker('loop-bot', [fakeIssue(ISSUE, { labels: labels.map((name) => ({ name })) })]);
const comments = (io: FakeTracker) => io.issues.get(ISSUE)?.comments.map((c) => c.body) ?? [];
const labels = (io: FakeTracker) => io.issues.get(ISSUE)?.labels.map((l) => l.name) ?? [];
const request = (raiser: Seat) => ({ issue: ISSUE, title: 'issue 7', question: 'What should a linked account see, and does the second path need its own email?', raiser });

describe('the decision panel', () => {
  it('decides every question when all three agree on facts that verify, and posts every review', async () => {
    const io = tracker();
    const raiser = seat('fixture', { framer: QUESTIONS, judge: AGREED, review: review(decide('Q1', 'Reuse it.', [FACT]), decide('Q2', 'No.')) });
    const others = [seat('fixture2', { review: review(decide('Q1', 'Reuse the linked message.'), decide('Q2', 'No, reuse the first.')) }), seat('fixture', { review: review(decide('Q1', 'Same string as today.', [FACT]), decide('Q2', 'Reuse it.')) })];
    const outcome = await weighHold(context(io, others), request(raiser), deps);
    expect(outcome.kind).toBe('proceed');
    const posted = comments(io);
    expect(posted.filter((b) => b.includes('<!-- panel-review'))).toHaveLength(3);
    for (const n of [1, 2, 3]) expect(posted.some((b) => b.includes(`(${n} of 3)`))).toBe(true);
    const receipt = posted.find((b) => b.includes('<!-- panel-receipt')) ?? '';
    expect(receipt).toContain('outcome=proceed');
    expect(receipt).toContain('**Decided:**');
    expect(receipt).not.toContain('Still open');
    expect(labels(io)).toContain('loop/panels: 1');
    expect(labels(io)).not.toContain('loop/deliberating');
  });

  it('holds with the missing fact named when a reviewer says only a person can answer', async () => {
    const io = tracker();
    const raiser = seat('fixture', { framer: QUESTIONS, judge: { issue: ISSUE, questions: [AGREED.questions[0]] }, review: review(decide('Q1', 'Reuse it.'), decide('Q2', 'No.')) });
    const owner = { id: 'Q2', kind: 'owner', answer: 'Probably one.', reasoning: 'the contract decides', facts: [], missingFact: 'whether the contract promises a separate notice', offeredDefault: 'one email' };
    const others = [seat('fixture2', { review: review(decide('Q1', 'Reuse it.'), owner) }), seat('fixture', { review: review(decide('Q1', 'Reuse it.'), decide('Q2', 'No.')) })];
    const outcome = await weighHold(context(io, others), request(raiser), deps);
    expect(outcome.kind).toBe('hold');
    if (outcome.kind === 'unavailable') return;
    expect(outcome.questions.map((q) => q.status)).toEqual(['decided', 'open']);
    const receipt = comments(io).find((b) => b.includes('<!-- panel-receipt')) ?? '';
    expect(receipt).toContain('**Still open:**');
    expect(receipt).toContain('whether the contract promises a separate notice; offered default: one email');
  });

  it('leaves an agreed answer open when a fact it cites is not in the base as quoted', async () => {
    const io = tracker();
    const wrong = { path: 'src/copy.ts', quote: "'Already claimed.'" };
    const raiser = seat('fixture', { framer: QUESTIONS, judge: AGREED, review: review(decide('Q1', 'Reuse it.', [wrong]), decide('Q2', 'No.')) });
    const others = [seat('fixture2', { review: review(decide('Q1', 'Reuse it.'), decide('Q2', 'No.')) }), seat('fixture', { review: review(decide('Q1', 'Reuse it.'), decide('Q2', 'No.')) })];
    const outcome = await weighHold(context(io, others), request(raiser), deps);
    expect(outcome.kind).toBe('hold');
    if (outcome.kind === 'unavailable') return;
    expect(outcome.questions[0].status).toBe('open');
    expect(outcome.questions[0].why).toContain('src/copy.ts');
  });

  it('cannot decide anything a seat short', async () => {
    const io = tracker();
    const raiser = seat('fixture', { framer: QUESTIONS, judge: AGREED, review: review(decide('Q1', 'Reuse it.'), decide('Q2', 'No.')) });
    const others = [seat('fixture2', { review: null }), seat('fixture', { review: review(decide('Q1', 'Reuse it.'), decide('Q2', 'No.')) })];
    const outcome = await weighHold(context(io, others), request(raiser), deps);
    expect(outcome.kind).toBe('hold');
    if (outcome.kind === 'unavailable') return;
    expect(outcome.questions.every((q) => q.status === 'open' && q.why === '2 of 3 reviewers answered')).toBe(true);
    expect(comments(io).filter((b) => b.includes('<!-- panel-review'))).toHaveLength(2);
    expect(labels(io)).not.toContain('loop/deliberating');
  });

  it('sits only with three distinct models on two engines and under the cap, and writes nothing otherwise', async () => {
    const raiser = seat('fixture', { review: review() });
    const one = seat('fixture2', { review: review() });
    for (const [others, held] of [[[one], []], [[raiser, one], []], [[seat('fixture', {}), seat('fixture', {})], []], [[one, seat('fixture', {})], ['loop/panels: 2']]] as Array<[Seat[], string[]]>) {
      const io = tracker(held);
      const outcome = await weighHold(context(io, others), request(raiser), deps);
      expect(outcome.kind).toBe('unavailable');
      expect(io.writes).toHaveLength(0);
    }
    const io = tracker();
    const unconfigured = { ...context(io, []), panel: undefined };
    expect((await weighHold(unconfigured, request(raiser), deps)).kind).toBe('unavailable');
  });

  it('seats the candidates most different from the raising seat first', () => {
    const raiser: Seat = { engine: 'claude', model: 'a' };
    const seated = panelSeats({ seats: [{ engine: 'claude', model: 'b' }, { engine: 'codex', model: 'c' }, { engine: 'claude', model: 'd' }], maxPanels: 2, effort: 'high' }, raiser, () => true);
    expect(seated.ok && seated.seats.map((s) => `${s.engine}:${s.model}:${s.effort}`)).toEqual(['claude:a:high', 'codex:c:high', 'claude:b:high']);
  });

  it('refuses an owner answer that does not name what only a person knows', () => {
    const questions = [{ id: 'Q1', text: 'q' }];
    expect(validateReview(review({ id: 'Q1', kind: 'owner', answer: 'ask', reasoning: 'unsure', facts: [] }), ISSUE, questions)).toBeNull();
    expect(validateReview(review({ id: 'Q1', kind: 'owner', answer: 'ask', reasoning: 'unsure', facts: [], missingFact: 'the contract term' }), ISSUE, questions)).not.toBeNull();
  });

  it('writes its receipt with lettered options and no em dash', () => {
    const receipt = renderReceipt(
      [{ question: { id: 'Q1', text: 'q' }, status: 'open', why: 'the reviewers disagree', positions: [{ text: 'one', reviewers: [1, 3] }, { text: 'three', reviewers: [2] }], owners: [] }],
      '<!-- panel-receipt round=1 outcome=hold -->',
    );
    expect(receipt).toContain('(a) one (reviewers 1 and 3)');
    expect(receipt).toContain('(b) three (reviewer 2)');
    expect(receipt).not.toContain('\u2014');
  });
});

/**
 * The decision panel: an adversarial check before an agent-raised question parks an issue for a
 * person. The seat that raised the question sits on it with two other frontier models, as
 * different from it and from each other as the adopter can reach, and every seat tries to answer
 * the question from the code, the written conventions, and the thread, without seeing the others.
 *
 * Each seat's review lands on the issue as a comment of its own, so the thread keeps the whole
 * deliberation. A question is decided only when all three seats decide it alike and the facts the
 * answer cites are found in the base; anything else is still open. When every question is decided
 * the issue goes back to the loop with the receipt as its ruling. Otherwise the hold the raising
 * seat asked for stands, and the person who takes it up finds the research already done.
 *
 * Fail-closed, like the appraisal: a seat that fails, writes nothing, or writes something malformed
 * is a seat short, and a panel short a seat decides nothing. A throw anywhere holds the issue.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LeaseLostError, trackerIo } from '../../carve-github-issue/lib/claims.ts';
import { readResult, renderPrompt, runAgent } from './agent.ts';
import type { Context } from './context.ts';
import { PANEL_JUDGMENT_FILE, PANEL_QUESTIONS_FILE, PANEL_REVIEW_FILE } from './control-files.ts';
import { ENGINES, isFixture, type Seat, seatLabel } from './engines.ts';
import { countOf, ensureLabel, recordCount } from './labels.ts';
import { mutate, RunStopping } from './shell.ts';

const PROMPTS = join(import.meta.dir, '..', 'prompts');

export const DELIBERATING_LABEL = 'loop/deliberating';
/** Seats on a panel: the raising seat's model and two others. */
export const PANEL_SIZE = 3;

/** What a driver hands the context: the panel's other seats, best first, and its limits. */
export type PanelSetup = {
  /** Candidates for the two seats beside the raising seat's, in order of preference. */
  seats: Seat[];
  /** Panels an issue may convene before a raised question goes straight to a person. */
  maxPanels: number;
  /** The reasoning level every panel turn runs at, the raising seat's included. */
  effort: string;
};

/** The config block a driver reads, before its seat specs are parsed. */
export type PanelKnobs = { seats: string[]; maxPanels: number; effort: string };
export const PANEL_DEFAULTS: PanelKnobs = { seats: [], maxPanels: 2, effort: 'high' };

/** One question the panel answers; linked questions arrive as one, so a split shows once. */
export type PanelQuestion = { id: string; text: string };

/** A fact an answer rests on: a quote that must be found in the file as the base holds it. */
export type PanelFact = { path: string; quote: string };

export type PanelAnswer = {
  id: string;
  /** `decide`: the answer the seat would act on. `owner`: only a person can answer, and why. */
  kind: 'decide' | 'owner';
  answer: string;
  reasoning: string;
  facts: PanelFact[];
  /** For `owner`, the fact only a person has. */
  missingFact?: string;
  /** For `owner`, a default the person can accept. */
  offeredDefault?: string;
};

/** One seat's turn, after validation; null answers mean the seat produced nothing usable. */
export type SeatReview = { seat: Seat; number: number; answers: PanelAnswer[] | null; review: string | null };

export type QuestionOutcome = {
  question: PanelQuestion;
  status: 'decided' | 'open';
  /** For a decided question: the answer, the line of reasoning, and the wording rule when one picked the words. */
  decision?: string;
  reasoning?: string;
  wordingRule?: string;
  /** For an open question: why, and each distinct position with the reviewers who took it. */
  why?: string;
  positions: Array<{ text: string; reviewers: number[] }>;
  owners: Array<{ reviewer: number; missingFact: string; offeredDefault?: string }>;
};

export type PanelOutcome =
  | { kind: 'unavailable'; why: string }
  | { kind: 'proceed' | 'hold'; questions: QuestionOutcome[]; receipt: string };

/** What the panel reads from outside itself; a test supplies its own. */
export type PanelDeps = {
  /** The file at `path` as the base holds it, or null when it does not exist there. */
  readAtBase?: (ctx: Context, path: string) => string | null;
  /** True when the engine's command can be run on this machine. */
  reachable?: (seat: Seat) => boolean;
};

/** A raised question, as the hand-off site hands it over. */
export type HoldRequest = { issue: number; title: string; question: string; raiser: Seat };

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

function defaultReachable(seat: Seat): boolean {
  if (isFixture(seat)) return true;
  const command = ENGINES[seat.engine].command('.', '', seat.model)[0];
  return Bun.which(command) !== null;
}

/**
 * The three seats: the raising seat's model, then the two candidates most different from it and
 * from each other. Different engines first, since an engine is the nearest thing to a vendor the
 * registry knows; then the adopter's order. Refuses a panel that cannot seat three distinct models
 * on at least two engines, which is when the hold goes to a person as it always did.
 */
export function panelSeats(setup: PanelSetup, raiser: Seat, reachable: (seat: Seat) => boolean = defaultReachable): { ok: true; seats: Seat[] } | { ok: false; why: string } {
  if (!reachable(raiser)) return { ok: false, why: `the raising seat ${seatLabel(raiser)} cannot be run here` };
  const seated = [raiser];
  const taken = new Set([seatLabel(raiser)]);
  const candidates = setup.seats.filter((seat) => !taken.has(seatLabel(seat)) && reachable(seat));
  while (seated.length < PANEL_SIZE) {
    const engines = new Set(seated.map((s) => s.engine));
    const next = candidates.find((s) => !taken.has(seatLabel(s)) && !engines.has(s.engine)) ?? candidates.find((s) => !taken.has(seatLabel(s)));
    if (!next) break;
    seated.push(next);
    taken.add(seatLabel(next));
  }
  if (seated.length < PANEL_SIZE) return { ok: false, why: `only ${seated.length} distinct models are reachable for a panel of ${PANEL_SIZE}` };
  if (new Set(seated.map((s) => s.engine)).size < 2) return { ok: false, why: 'every reachable panel seat is on one engine' };
  return { ok: true, seats: seated.map((seat) => ({ ...seat, effort: setup.effort })) };
}

// ---------------------------------------------------------------------------
// Validation: anything malformed reads as no answer
// ---------------------------------------------------------------------------

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function validateQuestions(raw: unknown, issue: number): PanelQuestion[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.issue !== issue || !Array.isArray(r.questions) || r.questions.length === 0 || r.questions.length > 8) return null;
  const questions: PanelQuestion[] = [];
  for (const q of r.questions as Array<Record<string, unknown>>) {
    if (!q || !text(q.id) || !text(q.text) || questions.some((p) => p.id === q.id)) return null;
    questions.push({ id: q.id.trim(), text: q.text.trim() });
  }
  return questions;
}

export function validateReview(raw: unknown, issue: number, questions: PanelQuestion[]): { answers: PanelAnswer[]; review: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.issue !== issue || !text(r.review) || !Array.isArray(r.answers)) return null;
  const answers: PanelAnswer[] = [];
  for (const a of r.answers as Array<Record<string, unknown>>) {
    if (!a || !questions.some((q) => q.id === a.id) || answers.some((b) => b.id === a.id)) return null;
    if (a.kind !== 'decide' && a.kind !== 'owner') return null;
    if (!text(a.answer) || !text(a.reasoning)) return null;
    // An owner answer must name the fact only a person has; one that cannot is a decide it would not make.
    if (a.kind === 'owner' && !text(a.missingFact)) return null;
    const facts: PanelFact[] = [];
    for (const f of (Array.isArray(a.facts) ? a.facts : []) as Array<Record<string, unknown>>) {
      if (!f || !text(f.path) || !text(f.quote)) return null;
      facts.push({ path: f.path.trim(), quote: f.quote });
    }
    answers.push({
      id: a.id as string,
      kind: a.kind,
      answer: a.answer.trim(),
      reasoning: a.reasoning.trim(),
      facts,
      missingFact: text(a.missingFact) ? a.missingFact.trim() : undefined,
      offeredDefault: text(a.offeredDefault) ? a.offeredDefault.trim() : undefined,
    });
  }
  return { answers, review: r.review.trim() };
}

type Judgment = { id: string; agreed: boolean; decision?: string; wordingRule?: string; reasoning?: string; positions: Array<{ text: string; reviewers: number[] }> };

export function validateJudgment(raw: unknown, issue: number, ids: string[]): Judgment[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.issue !== issue || !Array.isArray(r.questions)) return null;
  const out: Judgment[] = [];
  for (const j of r.questions as Array<Record<string, unknown>>) {
    if (!j || !ids.includes(j.id as string) || typeof j.agreed !== 'boolean') return null;
    // Agreement without the answer it agrees on is not a decision.
    if (j.agreed && (!text(j.decision) || !text(j.reasoning))) return null;
    const positions: Judgment['positions'] = [];
    for (const p of (Array.isArray(j.positions) ? j.positions : []) as Array<Record<string, unknown>>) {
      if (!p || !text(p.text) || !Array.isArray(p.reviewers) || !p.reviewers.every((n) => Number.isInteger(n) && n >= 1 && n <= PANEL_SIZE)) return null;
      positions.push({ text: p.text.trim(), reviewers: p.reviewers as number[] });
    }
    out.push({ id: j.id as string, agreed: j.agreed, decision: text(j.decision) ? j.decision.trim() : undefined, wordingRule: text(j.wordingRule) ? j.wordingRule.trim() : undefined, reasoning: text(j.reasoning) ? j.reasoning.trim() : undefined, positions });
  }
  // A judgment that skips a question it was asked about leaves that question open, never decided.
  return out;
}

// ---------------------------------------------------------------------------
// Verification and outcomes
// ---------------------------------------------------------------------------

function defaultReadAtBase(ctx: Context, path: string): string | null {
  const proc = Bun.spawnSync(['git', '-C', ctx.repoRoot, 'show', `${ctx.project.remote}/${ctx.project.baseBranch}:${path}`], { stdout: 'pipe', stderr: 'pipe' });
  return proc.exitCode === 0 ? proc.stdout.toString() : null;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The cited facts that are not in the base as quoted, by path; empty when every one holds. */
export function unverified(ctx: Context, facts: PanelFact[], readAtBase: NonNullable<PanelDeps['readAtBase']>): string[] {
  const failed: string[] = [];
  for (const fact of facts) {
    const body = readAtBase(ctx, fact.path);
    if (body === null || !squash(body).includes(squash(fact.quote))) failed.push(fact.path);
  }
  return [...new Set(failed)];
}

/** Each seat's own answer as a position, merging answers that are word for word the same. */
function positionsFrom(reviews: SeatReview[], id: string): QuestionOutcome['positions'] {
  const positions: QuestionOutcome['positions'] = [];
  for (const r of reviews) {
    const a = r.answers?.find((x) => x.id === id);
    if (!a) continue;
    const same = positions.find((p) => squash(p.text) === squash(a.answer));
    if (same) same.reviewers.push(r.number);
    else positions.push({ text: a.answer, reviewers: [r.number] });
  }
  return positions;
}

/** Settles every question from the seats' answers, the judgment, and the facts at the base. */
export function settle(ctx: Context, questions: PanelQuestion[], reviews: SeatReview[], judgments: Judgment[] | null, readAtBase: NonNullable<PanelDeps['readAtBase']>): QuestionOutcome[] {
  return questions.map((question) => {
    const answers = reviews.map((r) => r.answers?.find((a) => a.id === question.id) ?? null);
    const owners = reviews.flatMap((r) => {
      const a = r.answers?.find((x) => x.id === question.id);
      return a?.kind === 'owner' ? [{ reviewer: r.number, missingFact: a.missingFact ?? '', offeredDefault: a.offeredDefault }] : [];
    });
    const open = (why: string, positions = positionsFrom(reviews, question.id)): QuestionOutcome => ({ question, status: 'open', why, positions, owners });
    if (answers.some((a) => a === null)) return open(`${answers.filter((a) => a !== null).length} of ${PANEL_SIZE} reviewers answered`);
    if (owners.length > 0) return open(owners.length === PANEL_SIZE ? 'every reviewer says only a person can answer this' : 'a reviewer says only a person can answer this');
    const judged = judgments?.find((j) => j.id === question.id);
    if (!judged) return open('agreement could not be judged');
    if (!judged.agreed) return open('the reviewers disagree', judged.positions.length > 0 ? judged.positions : positionsFrom(reviews, question.id));
    const failed = unverified(ctx, answers.flatMap((a) => a?.facts ?? []), readAtBase);
    if (failed.length > 0) return open(`a fact the answer cites is not in \`${ctx.project.baseBranch}\` as quoted (${failed.map((p) => `\`${p}\``).join(', ')})`);
    return { question, status: 'decided', decision: judged.decision, reasoning: judged.reasoning, wordingRule: judged.wordingRule, positions: [], owners: [] };
  });
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const reviewers = (ns: number[]) => (ns.length === 1 ? `reviewer ${ns[0]}` : `reviewers ${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`);

/** The decision comment: what was decided, then what is still open, with lettered options. */
export function renderReceipt(outcomes: QuestionOutcome[], marker: string): string {
  const decided = outcomes.filter((o) => o.status === 'decided');
  const open = outcomes.filter((o) => o.status === 'open');
  const lines = [marker, `**Decision review.** ${PANEL_SIZE} independent reviews of the open question${outcomes.length === 1 ? '' : 's'} are on this thread.`, ''];
  if (decided.length > 0) {
    lines.push('**Decided:**', '');
    for (const o of decided) {
      lines.push(`- **${o.question.id}.** ${o.question.text}`, `  ${o.decision} (${o.reasoning})${o.wordingRule ? ` Wording: ${o.wordingRule}.` : ''}`);
    }
    lines.push('');
  }
  if (open.length > 0) {
    lines.push('**Still open:**', '');
    for (const o of open) {
      lines.push(`- **${o.question.id}.** ${o.question.text} _(${o.why})_`);
      o.positions.forEach((p, i) => lines.push(`  - (${LETTERS[i]}) ${p.text} (${reviewers(p.reviewers)})`));
      for (const owner of o.owners) {
        lines.push(`  - Needs from a person: ${owner.missingFact}${owner.offeredDefault ? `; offered default: ${owner.offeredDefault}` : ''} (reviewer ${owner.reviewer})`);
      }
    }
    lines.push('');
  }
  lines.push(
    open.length === 0
      ? 'Every question was decided, so the work carries on with these answers as its ruling. A ruling from a person overrides any of them.'
      : 'A person answers what is still open, by letter where there are options. The decided answers stand unless a person rules otherwise.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

function comment(ctx: Context, issue: number, what: string, body: string): void {
  mutate(ctx, `${what} on #${issue}`, ['gh', 'issue', 'comment', String(issue), '--body', body]);
}

function scratch(ctx: Context, issue: number, role: string): string {
  const cwd = join(ctx.runDir, `panel-${issue}-${role}-${process.pid}`);
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

/** Runs one panel turn in its own scratch directory and returns what it wrote, or null. */
async function turn<T>(ctx: Context, request: HoldRequest, role: string, tag: string, seat: Seat, file: string, vars: Record<string, string>): Promise<T | null> {
  const cwd = scratch(ctx, request.issue, tag);
  const prompt = renderPrompt({ ...ctx, promptsDirs: [...ctx.promptsDirs, PROMPTS] }, `${role}.md`, { ISSUE: String(request.issue), TITLE: request.title, PANEL_SIZE: String(PANEL_SIZE), ...vars });
  const run = await runAgent(ctx, role, request.issue, cwd, seat, prompt);
  const answer = run.exitCode === 0 && !run.notRun ? readResult<T>(cwd, file) : null;
  rmSync(cwd, { recursive: true, force: true });
  return answer;
}

const listQuestions = (questions: PanelQuestion[]) => questions.map((q) => `- **${q.id}.** ${q.text}`).join('\n');

/** The issue's labels as the tracker holds them now. */
function labelsNow(ctx: Context, issue: number): Array<{ name: string }> {
  const node = trackerIo(ctx).view(issue) as { labels?: Array<{ name: string }> } | null;
  return node?.labels ?? [];
}

/**
 * Weighs an agent-raised question before it holds the issue. Returns `unavailable` when no panel
 * can sit (none configured, fewer than three reachable models, the cap spent, a dry run), and the
 * caller holds the issue as it always did. Otherwise the panel has run, every review and the
 * receipt are on the issue, and `proceed` or `hold` says which way the caller sends it.
 *
 * The caller has already put the question on the thread. On `hold` it applies the hold label; on
 * `proceed` it sends the issue back to be appraised. `loop/deliberating` is off either way.
 */
export async function weighHold(ctx: Context, request: HoldRequest, deps: PanelDeps = {}): Promise<PanelOutcome> {
  const say = (message: string) => ctx.log(`#${request.issue}  ${message}`);
  const setup = ctx.panel;
  if (!setup) return { kind: 'unavailable', why: 'no decision panel is configured' };
  const seating = panelSeats(setup, request.raiser, deps.reachable);
  if (!seating.ok) return { kind: 'unavailable', why: seating.why };
  const spent = countOf('panels', labelsNow(ctx, request.issue));
  if (spent >= setup.maxPanels) return { kind: 'unavailable', why: `${spent} panels already convened on this issue` };
  const seats = seating.seats;
  if (ctx.dryRun && !seats.every(isFixture)) {
    say(`DRY RUN  would weigh the question on a panel of ${seats.map(seatLabel).join(', ')}`);
    return { kind: 'unavailable', why: 'dry run' };
  }

  say(`weighing the question on a panel of ${seats.map(seatLabel).join(', ')}`);
  try {
    ctx.onLane?.({ issue: request.issue, title: request.title, lane: 'P1', note: 'three frontier models weigh the question' });
  } catch (error) {
    say(`board: ${(error as Error).message}`);
  }
  ensureLabel(ctx, DELIBERATING_LABEL, 'fbca04', 'A panel of frontier models is weighing whether a person must decide');
  mutate(ctx, `label #${request.issue} ${DELIBERATING_LABEL}`, ['gh', 'issue', 'edit', String(request.issue), '--add-label', DELIBERATING_LABEL]);
  const round = recordCount(ctx, 'panels', request.issue, spent);
  const marker = (kind: string, extra = '') => `<!-- panel-${kind} round=${round}${extra} -->`;

  let outcome: PanelOutcome;
  try {
    outcome = await convene(ctx, request, seats, marker, deps, say);
  } catch (error) {
    // A stopping run and a lost lease are not this panel's to settle: the label comes off, and the
    // issue is left for whichever run holds it next, with the question still on the thread.
    if (error instanceof RunStopping || error instanceof LeaseLostError) {
      mutate(ctx, `unlabel #${request.issue} ${DELIBERATING_LABEL}`, ['gh', 'issue', 'edit', String(request.issue), '--remove-label', DELIBERATING_LABEL], { whileStopping: true });
      throw error;
    }
    // Whatever else broke, the raising seat's hold stands; the reviews already posted are the research.
    say(`the panel could not finish: ${(error as Error).message.split('\n')[0]}`);
    const receipt = [marker('receipt', ' outcome=hold'), '**Decision review.** The review was interrupted before it finished; the reviews above are what it gathered, and a person decides.'].join('\n');
    try {
      comment(ctx, request.issue, 'post the interrupted decision review', receipt);
    } catch (second) {
      say(`could not post the interrupted review: ${(second as Error).message.split('\n')[0]}`);
    }
    outcome = { kind: 'hold', questions: [], receipt };
  }
  mutate(ctx, `unlabel #${request.issue} ${DELIBERATING_LABEL}`, ['gh', 'issue', 'edit', String(request.issue), '--remove-label', DELIBERATING_LABEL], { whileStopping: true });
  return outcome;
}

async function convene(ctx: Context, request: HoldRequest, seats: Seat[], marker: (kind: string, extra?: string) => string, deps: PanelDeps, say: (m: string) => void): Promise<PanelOutcome> {
  const raiser = seats[0];
  // Framing: the raising seat splits its question into the decisions it is made of, linked ones together.
  const framed = validateQuestions(await turn<unknown>(ctx, request, 'panel-framer', 'frame', raiser, PANEL_QUESTIONS_FILE, { QUESTION: request.question }), request.issue);
  const questions = framed ?? [{ id: 'Q1', text: request.question }];
  if (!framed) say('the question could not be framed; the panel answers it whole');

  // The seats answer concurrently, and each review lands on the issue the moment it is in.
  const reviews: SeatReview[] = await Promise.all(
    seats.map(async (seat, index): Promise<SeatReview> => {
      const number = index + 1;
      const raw = await turn<unknown>(ctx, request, 'panelist', `seat${number}`, seat, PANEL_REVIEW_FILE, {
        QUESTION: request.question,
        QUESTIONS: listQuestions(questions),
        REVIEWER: String(number),
        PANEL_SIZE: String(PANEL_SIZE),
      });
      const checked = validateReview(raw, request.issue, questions);
      if (!checked) {
        say(`reviewer ${number} (${seatLabel(seat)}) produced no usable review`);
        return { seat, number, answers: null, review: null };
      }
      const body = [
        marker('review', ` reviewer=${number}`),
        `**Independent review of the open decision${questions.length === 1 ? '' : 's'} (${number} of ${PANEL_SIZE}).** Written without seeing the other reviews.`,
        '',
        checked.review,
        '',
        '<details><summary>Answers as recorded</summary>',
        '',
        '```json',
        JSON.stringify(checked.answers, null, 2),
        '```',
        '',
        '</details>',
      ].join('\n');
      comment(ctx, request.issue, `post review ${number} of ${PANEL_SIZE}`, body);
      return { seat, number, answers: checked.answers, review: checked.review };
    }),
  );

  // Agreement is judged only where every seat decided; an owner answer or a missing one is open already.
  const contested = questions.filter((q) => reviews.every((r) => r.answers?.find((a) => a.id === q.id)?.kind === 'decide'));
  let judgments: Judgment[] | null = [];
  if (contested.length > 0) {
    const answersFor = (q: PanelQuestion) =>
      [`### ${q.id}. ${q.text}`, ...reviews.map((r) => {
        const a = r.answers?.find((x) => x.id === q.id) as PanelAnswer;
        return `Reviewer ${r.number}: ${a.answer}\nReasoning: ${a.reasoning}`;
      })].join('\n\n');
    judgments = validateJudgment(
      await turn<unknown>(ctx, request, 'panel-judge', 'judge', raiser, PANEL_JUDGMENT_FILE, { ANSWERS: contested.map(answersFor).join('\n\n'), QUESTION_IDS: contested.map((q) => q.id).join(', ') }),
      request.issue,
      contested.map((q) => q.id),
    );
    if (!judgments) say('agreement could not be judged; every contested question stays open');
  }

  const outcomes = settle(ctx, questions, reviews, judgments, deps.readAtBase ?? defaultReadAtBase);
  const kind = outcomes.every((o) => o.status === 'decided') ? 'proceed' : 'hold';
  const receipt = renderReceipt(outcomes, marker('receipt', ` outcome=${kind}`));
  comment(ctx, request.issue, 'post the decision review', receipt);
  say(`panel: ${outcomes.filter((o) => o.status === 'decided').length} of ${outcomes.length} decided; ${kind}`);
  return { kind, questions: outcomes, receipt };
}

/**
 * Sends a decided issue back to be appraised the way a person's answer does: its size labels come
 * off, since the decisions can change the size, and the appraiser sizes it again with the receipt
 * in the thread as a ruling.
 */
export function clearSizeLabels(ctx: Context, issue: number): void {
  for (const { name } of labelsNow(ctx, issue)) {
    if (/^size:\s*\d+$/.test(name)) mutate(ctx, `unlabel #${issue} ${name}`, ['gh', 'issue', 'edit', String(issue), '--remove-label', name]);
  }
}

// ---------------------------------------------------------------------------
// A panel whose run died
// ---------------------------------------------------------------------------

/**
 * When `loop/deliberating` last went on the issue, from its event timeline, or null when it cannot
 * be told. A panel runs inside the process that raised its question, so a label older than every
 * turn the panel could take belongs to a run that died.
 */
export function deliberatingSince(ctx: Context, issue: number): number | null {
  const proc = Bun.spawnSync(
    ['gh', 'api', `repos/${ctx.project.repo}/issues/${issue}/events`, '--paginate', '--jq', `[.[] | select(.event == "labeled" and .label.name == "${DELIBERATING_LABEL}") | .created_at] | last`],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const at = Date.parse(proc.stdout.toString().trim());
  return proc.exitCode === 0 && Number.isFinite(at) ? at : null;
}

/**
 * Holds an issue whose panel was interrupted by a run that died: the reviews it posted stay as the
 * research, the hold the raising seat asked for is applied, and the label comes off.
 */
export function holdInterruptedPanel(ctx: Context, issue: number): void {
  comment(ctx, issue, 'note the interrupted decision review', [
    '<!-- panel-receipt outcome=hold interrupted=true -->',
    '**Decision review.** The review was interrupted before it finished; any reviews above are what it gathered, and a person decides.',
  ].join('\n'));
  mutate(ctx, `label #${issue} needs-decision`, ['gh', 'issue', 'edit', String(issue), '--add-label', 'needs-decision']);
  mutate(ctx, `unlabel #${issue} ${DELIBERATING_LABEL}`, ['gh', 'issue', 'edit', String(issue), '--remove-label', DELIBERATING_LABEL]);
}

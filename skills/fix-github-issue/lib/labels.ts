/**
 * Durable state on the tracker: the labels that carry an issue's progress between runs, and the
 * transitions that write them.
 *
 * Every fact the pipeline needs across runs lives on the issue, not in a process. A run that dies
 * loses only the agents in flight; the next one reads the same labels and carries on. It also means
 * the state is legible on the forge rather than in a log nobody kept.
 */

import type { CloseEvent, Context } from './context.ts';
import { mutate, sh } from './shell.ts';

/** The shape every function here reads. Callers carry richer issues; these only need the labels. */
export type LabelledIssue = { number: number; labels: Array<{ name: string }> };

/** Every label the collection writes, with its color and description; GitHub caps a description at 100 characters. */
export function loopLabels(): Array<[string, string, string]> {
  return [
    ['needs-decision', 'ededed', 'Blocked on a product decision, not on effort'],
    ['needs-human', 'ededed', 'Needs access or authority an agent does not have'],
    ['loop/skip', 'ededed', 'Permanently out of the issue loop'],
    ['loop/parked', 'fbca04', 'The loop worked it and a human needs to finish the call'],
    ...DLQ_PHASES.map((phase): [string, string, string] => [dlqLabel(phase), 'b60205', `${DLQ_DESCRIPTION[phase]}; remove to redrive`]),
    ['loop/carved', '5319e7', 'Carved into sub-issues; worked by closing them'],
    ['loop/carving', '5319e7', 'A carve is in progress; other runs wait'],
    ['loop/released', '5319e7', 'Carving finished; awaiting re-appraisal'],
    ['loop/working', '1d76db', 'A worker has this issue; other runs wait'],
    ['loop/paused', 'fbca04', 'Paused by its parent while a question is open'],
    ['loop/handed-off', 'ededed', 'The knife handed this off before carving it; found by the sweep when the hold lifts'],
    ['spike', '0e8a16', 'Answer a question with evidence; no pull request'],
  ];
}

export function ensureLabels(ctx: Context): void {
  const existing = new Set(
    sh(ctx, ['gh', 'label', 'list', '--limit', '200', '--json', 'name', '--jq', '.[].name']).split('\n'),
  );
  for (const [name, color, description] of loopLabels()) {
    if (existing.has(name)) continue;
    // --force: two drivers starting together can both see the label missing; the loser must not abort.
    mutate(ctx, `create label ${name}`, ['gh', 'label', 'create', name, '--force', '--color', color, '--description', description]);
  }
}

/**
 * The dead-letter queues, one per phase that runs a machine, as `loop/dlq: <phase>` labels. Each
 * phase's letters are triaged differently (references/state-machine.md, "Dead letters"), and an
 * operator listing one queue must not have to read the reasons to tell them apart. The bare
 * `loop/dlq` of earlier runs is still read as a hold and as the review queue, never written.
 */
export const DLQ_PHASES = ['appraisal', 'carve', 'work', 'review', 'landing'] as const;
export type DlqPhase = (typeof DLQ_PHASES)[number];

const DLQ_DESCRIPTION: Record<DlqPhase, string> = {
  appraisal: 'Appraiser or confirmer failed past the cap',
  carve: 'Carve failed or disputed past a cap',
  work: 'Worker failed past the cap, or left undeclared work',
  review: 'Review rounds exhausted, or no trusted verdict',
  landing: 'Conflict, red checks, failed smoke, refresh cap, or unreported merge',
};

export const dlqLabel = (phase: DlqPhase): string => `loop/dlq: ${phase}`;

/** True for any dead-letter label: a phase's, or the bare one earlier runs wrote. */
export function isDlqLabel(name: string): boolean {
  return name === 'loop/dlq' || name.startsWith('loop/dlq:');
}

/** Which queue holds the issue, or null when none does; the bare legacy label reads as the review queue. */
export function dlqPhase(labels: Array<{ name: string }>): DlqPhase | null {
  for (const { name } of labels) {
    if (name === 'loop/dlq') return 'review';
    const match = /^loop\/dlq:\s*(\w+)$/.exec(name);
    if (match && (DLQ_PHASES as readonly string[]).includes(match[1])) return match[1] as DlqPhase;
  }
  return null;
}

/** True when a person's label, a dead letter, or the caller's own skip list holds the issue. */
export function isHeldBy(labels: Array<{ name: string }>, skipLabels: string[]): boolean {
  return labels.some((l) => skipLabels.includes(l.name) || isDlqLabel(l.name));
}

/**
 * The five counters, each a `loop/<kind>: N` label: review rounds, carve attempts, appraisal
 * attempts, worker attempts, and redrives out of a dead-letter queue. One pattern, one set of
 * functions, five names.
 */
export type Counter = 'reviews' | 'carves' | 'appraisals' | 'attempts' | 'redrives';

const COUNTER_LABEL: Record<Counter, { color: string; description: string }> = {
  reviews: { color: 'd4c5f9', description: 'Review rounds consumed' },
  carves: { color: 'd4c5f9', description: 'Carve attempts consumed' },
  appraisals: { color: 'd4c5f9', description: 'Appraisal attempts consumed' },
  attempts: { color: 'd4c5f9', description: 'Worker attempts consumed' },
  redrives: { color: 'd4c5f9', description: 'Redrives out of a dead-letter queue' },
};

/**
 * How many of `kind` this issue has already consumed, read from its `loop/<kind>: N` label.
 * Max rather than first match: the increment is add-then-remove, so a crash between the two
 * leaves both labels, and the honest reading of that state is the higher count.
 */
export function countOf(kind: Counter, labels: Array<{ name: string }>): number {
  const pattern = new RegExp(`^loop/${kind}:\\s*(\\d+)$`);
  let count = 0;
  for (const { name } of labels) {
    const match = pattern.exec(name);
    if (match) count = Math.max(count, Number(match[1]));
  }
  return count;
}

/**
 * Records one more of `kind`. Written by one role only per kind, so the count cannot be lost.
 *
 * Label edits are not compare-and-swap, so two writers incrementing concurrently would drop an
 * increment and silently break the burndown guarantee: the pull master alone writes reviews, the
 * knife alone writes carves, and so on.
 */
export function recordCount(ctx: Context, kind: Counter, issue: number, previous: number): number {
  const next = previous + 1;
  const label = `loop/${kind}: ${next}`;
  try {
    sh(ctx, ['gh', 'label', 'create', label, '--color', COUNTER_LABEL[kind].color, '--description', COUNTER_LABEL[kind].description]);
  } catch {
    // already exists
  }
  // Add the new count before removing the old one. A crash between the two leaves both labels,
  // and countOf reads the max; the other order would refund every spent round on a crash.
  mutate(ctx, `mark #${issue} at ${label}`, ['gh', 'issue', 'edit', String(issue), '--add-label', label]);
  if (previous > 0) {
    mutate(ctx, `clear loop/${kind}: ${previous} on #${issue}`, [
      'gh',
      'issue',
      'edit',
      String(issue),
      '--remove-label',
      `loop/${kind}: ${previous}`,
    ]);
  }
  return next;
}

/**
 * Takes every `loop/<kind>: N` off an issue, reading the labels live rather than trusting the
 * caller's snapshot, since an earlier add-before-remove crash can have left lower counts behind.
 */
export function clearCount(ctx: Context, kind: Counter, issue: number): void {
  const prefix = `loop/${kind}:`;
  const current = sh(ctx, ['gh', 'issue', 'view', String(issue), '--json', 'labels', '--jq', '.labels[].name'])
    .split('\n')
    .filter((name) => name.startsWith(prefix));
  for (const label of current) {
    mutate(ctx, `clear ${label} on #${issue}`, ['gh', 'issue', 'edit', String(issue), '--remove-label', label]);
  }
}

export const reviewCount = (labels: Array<{ name: string }>) => countOf('reviews', labels);
export const recordReview = (ctx: Context, issue: number, previous: number) => recordCount(ctx, 'reviews', issue, previous);
export const carveCount = (labels: Array<{ name: string }>) => countOf('carves', labels);
export const recordCarve = (ctx: Context, issue: number, previous: number) => recordCount(ctx, 'carves', issue, previous);
export const clearCarves = (ctx: Context, issue: number) => clearCount(ctx, 'carves', issue);
export const appraisalCount = (labels: Array<{ name: string }>) => countOf('appraisals', labels);
export const recordAppraisal = (ctx: Context, issue: number, previous: number) => recordCount(ctx, 'appraisals', issue, previous);
export const clearAppraisals = (ctx: Context, issue: number) => clearCount(ctx, 'appraisals', issue);
export const attemptCount = (labels: Array<{ name: string }>) => countOf('attempts', labels);
export const recordAttempt = (ctx: Context, issue: number, previous: number) => recordCount(ctx, 'attempts', issue, previous);
export const clearAttempts = (ctx: Context, issue: number) => clearCount(ctx, 'attempts', issue);
export const redriveCount = (labels: Array<{ name: string }>) => countOf('redrives', labels);
export const recordRedrive = (ctx: Context, issue: number, previous: number) => recordCount(ctx, 'redrives', issue, previous);

/**
 * Ejects an issue to one phase's dead-letter queue, retained with the reason that put it there.
 * The review queue also takes the spent rounds off, or the redrive would be a lie: with any
 * `loop/reviews: N` surviving, lifting the letter would hand the issue back with a short budget.
 */
export function sendToDlq(ctx: Context, issue: number, phase: DlqPhase, reason: string): void {
  const label = dlqLabel(phase);
  // Reason first, label second: a crash between the two leaves an explained issue that is not yet
  // ejected, which the next run finishes; the other order hides an issue with no explanation.
  mutate(ctx, `comment on #${issue}`, [
    'gh',
    'issue',
    'comment',
    String(issue),
    '--body',
    `Moved to the ${phase} dead-letter queue.\n\n${reason}\n\nRemove the \`${label}\` label, or run the fix command with \`--redrive\`, to put it back with a fresh budget.`,
  ]);
  mutate(ctx, `send #${issue} to the ${phase} DLQ`, ['gh', 'issue', 'edit', String(issue), '--add-label', label]);
  if (phase === 'review') clearCount(ctx, 'reviews', issue);
}

/** Lifts every dead-letter label an issue carries, the bare legacy one included. Returns what came off. */
export function liftDlq(ctx: Context, issue: number, labels: Array<{ name: string }>): string[] {
  const lifted = labels.map((l) => l.name).filter(isDlqLabel);
  for (const name of lifted) mutate(ctx, `lift ${name} on #${issue}`, ['gh', 'issue', 'edit', String(issue), '--remove-label', name]);
  return lifted;
}

/** The labels under which a person, not the loop, owns an issue; dead letters are `isDlqLabel`. */
export const HOLD_LABELS = ['needs-human', 'needs-decision', 'loop/skip', 'loop/parked', 'loop/dlq', ...DLQ_PHASES.map(dlqLabel), 'loop/paused'];

/**
 * Repairs label states a crash can leave half-written, so every durable transition is
 * re-runnable rather than a one-shot. Runs under the instance lock, before any lane starts.
 *
 * Reviews keep their original two wrecks: an issue at the review cap that never received
 * `loop/dlq` (its ejection half done, invisible to selection forever), and a DLQed issue still
 * carrying `loop/reviews:*` counts (its redrive would not actually requeue it). The three newer
 * counters trip a hold whose hand-off comment names them, and a person removing that hold is the
 * reset: a counter at its cap on an issue with no hold is cleared here, so the redrive is real.
 *
 * `skipLabels` is the caller's, since which labels shelve an issue is a driver's policy; `caps`
 * are the caller's too, and a cap it does not know is not repaired.
 */
export function repairDurableState(
  ctx: Context,
  all: LabelledIssue[],
  skipLabels: string[],
  caps: Partial<Record<Counter, number>> = { reviews: ctx.knobs.maxReviewRounds },
): void {
  for (const issue of all) {
    const names = issue.labels.map((l) => l.name);
    const counts = names.filter((name) => /^loop\/reviews:/.test(name));
    const dlq = dlqPhase(issue.labels) === 'review';
    const shelved = names.some((name) => skipLabels.includes(name));
    const held = names.some((name) => HOLD_LABELS.includes(name) || skipLabels.includes(name));

    if (dlq && counts.length > 0) {
      for (const label of counts) {
        mutate(ctx, `repair: clear ${label} on DLQed #${issue.number}`, [
          'gh',
          'issue',
          'edit',
          String(issue.number),
          '--remove-label',
          label,
        ]);
      }
      continue;
    }
    if (caps.reviews !== undefined && !dlq && !shelved && reviewCount(issue.labels) >= caps.reviews) {
      ctx.log(`repair: #${issue.number} sits at the review cap without loop/dlq; finishing the ejection`);
      sendToDlq(ctx, issue.number, 'review', `The review budget of ${reviewCount(issue.labels)} rounds is spent. Completing an ejection an earlier run started and did not finish.`);
      continue;
    }
    for (const kind of ['carves', 'appraisals', 'attempts'] as const) {
      const cap = caps[kind];
      if (cap === undefined || held || countOf(kind, issue.labels) < cap) continue;
      ctx.log(`repair: #${issue.number} sits at the ${kind} cap with no hold; a person redrove it, so the counter resets`);
      clearCount(ctx, kind, issue.number);
    }
  }
}

/** A close's announcement: the first thing `closeIssue` writes, so a crash before the close is finishable. */
export function closeMarker(verdict: string, by: CloseEvent['by']): string {
  return `<!-- loop-close verdict=${verdict} by=${by} -->`;
}

/**
 * Closes an issue: posts the explanation carrying its `loop-close` marker (the close intent), then
 * closes, then reads the close time back and tells the driver. Every close in the collection goes
 * through here, so a driver's `onClosed` hook sees all of them.
 *
 * An unfinished close announcement on the same issue by this account, younger than thirty minutes,
 * is finished rather than repeated; older than that it is stale, and a person may have acted since,
 * so a fresh announcement is posted.
 */
export async function closeIssue(
  ctx: Context,
  issue: number,
  comment: string,
  event: Omit<CloseEvent, 'issue' | 'closedAt'>,
): Promise<void> {
  const marker = closeMarker(event.kind === 'merged' ? 'merged' : event.reason.split(/\s/)[0] || event.kind, event.by);
  if (!pendingClose(ctx, issue, marker)) {
    mutate(ctx, `comment on #${issue}`, ['gh', 'issue', 'comment', String(issue), '--body', `${marker}\n${comment}`]);
  }
  const stateReason = event.kind === 'closed' && /^(obsolete|not-planned)/.test(event.reason) ? 'not planned' : 'completed';
  mutate(ctx, `close #${issue}`, ['gh', 'issue', 'close', String(issue), '--reason', stateReason]);
  if (ctx.dryRun) return;
  const viewed = ctx.io?.view?.(issue) as { closedAt?: string | null } | null | undefined;
  const closedAt =
    (ctx.io?.view ? viewed?.closedAt : sh(ctx, ['gh', 'issue', 'view', String(issue), '--json', 'closedAt', '--jq', '.closedAt'])) || new Date().toISOString();
  if (!ctx.onClosed) return;
  try {
    await ctx.onClosed({ ...event, issue, closedAt });
  } catch (error) {
    ctx.log(`  onClosed for #${issue} threw: ${(error as Error).message}`);
  }
}

const CLOSE_ANNOUNCEMENT_FRESH_MS = 30 * 60 * 1000;

/** True when this account already announced this close on the thread recently and the issue is still open. */
function pendingClose(ctx: Context, issue: number, marker: string): boolean {
  if (ctx.dryRun) return false;
  let view: { state: string; comments: Array<{ author: string; body: string; createdAt: string }> };
  if (ctx.io?.view) {
    const node = ctx.io.view(issue) as { state: string; comments: Array<{ author: string; body: string; createdAt: string }> } | null;
    if (!node) return false;
    view = node;
  } else {
    try {
      const raw = JSON.parse(sh(ctx, ['gh', 'issue', 'view', String(issue), '--json', 'state,comments'])) as { state: string; comments: Array<{ author: { login: string } | null; body: string; createdAt: string }> };
      view = { state: raw.state, comments: raw.comments.map((c) => ({ author: c.author?.login ?? 'ghost', body: c.body, createdAt: c.createdAt })) };
    } catch {
      return false;
    }
  }
  if (view.state !== 'OPEN') return false;
  return view.comments.some((c) => c.author === ctx.botLogin && c.body.startsWith(marker) && Date.now() - Date.parse(c.createdAt) < CLOSE_ANNOUNCEMENT_FRESH_MS);
}

/**
 * Hands an issue to a human, with the reason on the issue rather than only in a local log. A parked
 * issue is one a person now owns, so it has to say what stopped it.
 */
export function parkIssue(ctx: Context, issue: number, reason: string): void {
  // Comment first, then the label that hides the issue from selection: a crash between the two
  // leaves an issue that is still selectable, never one held without a reason on its thread.
  mutate(ctx, `comment on #${issue}`, ['gh', 'issue', 'comment', String(issue), '--body', reason]);
  mutate(ctx, `park #${issue}`, ['gh', 'issue', 'edit', String(issue), '--add-label', 'loop/parked']);
}

/**
 * Durable state on the tracker: the labels that carry an issue's progress between runs, and the
 * transitions that write them.
 *
 * Every fact the pipeline needs across runs lives on the issue, not in a process. A run that dies
 * loses only the agents in flight; the next one reads the same labels and carries on. It also means
 * the state is legible on the forge rather than in a log nobody kept.
 */

import type { Context } from './context.ts';
import { mutate, sh } from './shell.ts';

/** The shape every function here reads. Callers carry richer issues; these only need the labels. */
export type LabelledIssue = { number: number; labels: Array<{ name: string }> };

export function ensureLabels(ctx: Context): void {
  const existing = new Set(
    sh(ctx, ['gh', 'label', 'list', '--limit', '200', '--json', 'name', '--jq', '.[].name']).split('\n'),
  );
  const wanted: Array<[string, string, string]> = [
    ['needs-decision', 'ededed', 'Blocked on a product decision, not on effort'],
    ['needs-human', 'ededed', 'Needs access or authority an agent does not have'],
    ['loop/skip', 'ededed', 'Permanently out of the issue loop'],
    ['loop/parked', 'fbca04', 'The loop worked it and a human needs to finish the call'],
    ['loop/dlq', 'b60205', 'Exhausted its reviews; retained with a reason, redrive by removing this label'],
  ];
  for (const [name, color, description] of wanted) {
    if (existing.has(name)) continue;
    // --force: two drivers starting together can both see the label missing; the loser must not abort.
    mutate(ctx, `create label ${name}`, ['gh', 'label', 'create', name, '--force', '--color', color, '--description', description]);
  }
}

/**
 * How many review rounds this issue has already consumed, read from its `loop/reviews: N` label.
 * Max rather than first match: the increment is add-then-remove, so a crash between the two
 * leaves both labels, and the honest reading of that state is the higher count.
 */
export function reviewCount(labels: Array<{ name: string }>): number {
  let count = 0;
  for (const { name } of labels) {
    const match = /^loop\/reviews:\s*(\d+)$/.exec(name);
    if (match) count = Math.max(count, Number(match[1]));
  }
  return count;
}

/**
 * Records a completed review round. Written by one role only, so the count cannot be lost.
 *
 * Label edits are not compare-and-swap, so two writers incrementing concurrently would drop an
 * increment and silently break the burndown guarantee. The pull master is the only writer.
 */
export function recordReview(ctx: Context, issue: number, previous: number): number {
  const next = previous + 1;
  const label = `loop/reviews: ${next}`;
  try {
    sh(ctx, ['gh', 'label', 'create', label, '--color', 'd4c5f9', '--description', 'Review rounds consumed']);
  } catch {
    // already exists
  }
  // Add the new count before removing the old one. A crash between the two leaves both labels,
  // and reviewCount reads the max; the other order would refund every spent round on a crash.
  mutate(ctx, `mark #${issue} at ${label}`, ['gh', 'issue', 'edit', String(issue), '--add-label', label]);
  if (previous > 0) {
    mutate(ctx, `clear loop/reviews: ${previous} on #${issue}`, [
      'gh',
      'issue',
      'edit',
      String(issue),
      '--remove-label',
      `loop/reviews: ${previous}`,
    ]);
  }
  return next;
}

/** Ejects an issue to the dead-letter queue, retained with the reason that put it there. */
export function sendToDlq(ctx: Context, issue: number, rounds: number, reason: string): void {
  // Reason first, label second: a crash between the two leaves an explained issue that is not yet
  // ejected, which the next run finishes; the other order hides an issue with no explanation.
  mutate(ctx, `comment on #${issue}`, [
    'gh',
    'issue',
    'comment',
    String(issue),
    '--body',
    `Moved to the dead-letter queue after ${rounds} review rounds without a merge.\n\n${reason}\n\nRemove the \`loop/dlq\` label to put it back in the queue with a fresh review budget.`,
  ]);
  mutate(ctx, `send #${issue} to the DLQ`, ['gh', 'issue', 'edit', String(issue), '--add-label', 'loop/dlq']);
  // Every count label comes off, or the redrive is a lie: with any `loop/reviews: N` surviving,
  // removing `loop/dlq` would put the issue somewhere selection still refuses to look, or hand it
  // back with a short budget. Read the labels live rather than trusting the caller's snapshot,
  // since an earlier add-before-remove crash can have left lower counts behind.
  const current = sh(ctx, ['gh', 'issue', 'view', String(issue), '--json', 'labels', '--jq', '.labels[].name'])
    .split('\n')
    .filter((name) => /^loop\/reviews:/.test(name));
  for (const label of current) {
    mutate(ctx, `clear ${label} on #${issue}`, ['gh', 'issue', 'edit', String(issue), '--remove-label', label]);
  }
}

/**
 * Repairs label states a crash can leave half-written, so every durable transition is
 * re-runnable rather than a one-shot. Two known wrecks: an issue at the review cap that never
 * received `loop/dlq` (its ejection half done, invisible to selection forever), and a DLQed issue
 * still carrying `loop/reviews:*` counts (its redrive would not actually requeue it). Runs under
 * the instance lock, before any lane starts.
 *
 * `skipLabels` is the caller's, since which labels shelve an issue is a driver's policy.
 */
export function repairDurableState(ctx: Context, all: LabelledIssue[], skipLabels: string[]): void {
  for (const issue of all) {
    const names = issue.labels.map((l) => l.name);
    const counts = names.filter((name) => /^loop\/reviews:/.test(name));
    const dlq = names.includes('loop/dlq');
    const shelved = names.some((name) => skipLabels.includes(name));

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
    if (!dlq && !shelved && reviewCount(issue.labels) >= ctx.knobs.maxReviewRounds) {
      ctx.log(`repair: #${issue.number} sits at the review cap without loop/dlq; finishing the ejection`);
      sendToDlq(
        ctx,
        issue.number,
        reviewCount(issue.labels),
        'Completing an ejection an earlier run started and did not finish.',
      );
    }
  }
}

export function closeIssue(ctx: Context, issue: number, comment: string): void {
  mutate(ctx, `comment on #${issue}`, ['gh', 'issue', 'comment', String(issue), '--body', comment]);
  mutate(ctx, `close #${issue}`, ['gh', 'issue', 'close', String(issue)]);
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

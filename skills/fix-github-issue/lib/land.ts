/**
 * `fix.ts --land`: a person's go-ahead to land an approved pull request the merge boundary parked.
 * It waives that boundary and nothing else, so it refuses an issue held for any other reason: a
 * dead letter, a park because the issue changed under the review, or a park with no reason found.
 */

import type { Context } from './context.ts';
import { sh } from './shell.ts';
import { stopIn } from './stop-record.ts';

/** How long after the park label its note may still land and be read as that park's reason. */
const NOTE_AFTER_LABEL_MS = 10 * 60 * 1000;

/**
 * Why `--land` must not act on this issue, or null when it may. `labels` are the issue's label
 * names, `comments` its comments oldest first, and `parkedAt` when `loop/parked` was last added.
 * Every park writes its stop record and then the label, so the reason in force is the newest
 * comment at or before that moment; it has to be a boundary stop (`stopIn`, which also reads the
 * boundary's words on a thread written before the record). A boundary note within ten minutes after
 * the label is also read as its reason, since the label has been seen to land first.
 */
export function landBlocker(labels: string[], comments: Array<{ body: string; createdAt: string }>, parkedAt: string | null): string | null {
  const dlq = labels.find((name) => name === 'loop/dlq' || name.startsWith('loop/dlq:'));
  if (dlq) return `it is a dead letter (${dlq}); --land waives only the merge boundary, so use --redrive`;
  if (!labels.includes('loop/parked')) return 'it is not parked; there is no boundary to land past';
  if (!parkedAt) return 'no record of when it was parked; --land cannot tell whether the boundary parked it';
  const parked = Date.parse(parkedAt);
  const boundary = (c: { body: string }) => stopIn(c.body)?.kind === 'boundary';
  const before = comments.filter((c) => Date.parse(c.createdAt) <= parked).at(-1);
  // The label has been seen to land minutes before its note, so a boundary note written just after
  // the label is the same park's reason; only the boundary's own record is taken from that window.
  const after = comments.find((c) => Date.parse(c.createdAt) > parked && Date.parse(c.createdAt) - parked <= NOTE_AFTER_LABEL_MS && boundary(c));
  const reason = before && boundary(before) ? before : (after ?? before);
  if (!reason || !boundary(reason)) {
    return 'its newest park was not the merge boundary; --land waives only that boundary, so use --redrive';
  }
  // A park for a missing classification is not waivable: the landing would only park it again.
  if (/categories nobody stated/.test(reason.body)) {
    return 'the boundary parked it because no classification was stated, which --land never waives; use --redrive so the change is classified';
  }
  return null;
}

/** `landBlocker` for an issue as the tracker holds it now: its labels, its comments, and when it was last parked. */
export function readLandBlocker(ctx: Context, issue: number): string | null {
  const view = JSON.parse(sh(ctx, ['gh', 'issue', 'view', String(issue), '--json', 'labels,comments'])) as {
    labels: Array<{ name: string }>;
    comments: Array<{ body: string; createdAt: string }>;
  };
  const parkedAt = sh(ctx, ['gh', 'api', `repos/${ctx.project.repo}/issues/${issue}/events`, '--paginate', '--jq', '.[] | select(.event == "labeled" and .label.name == "loop/parked") | .created_at'])
    .split('\n')
    .filter(Boolean)
    .at(-1) ?? null;
  return landBlocker(view.labels.map((l) => l.name), view.comments.map((c) => ({ body: c.body, createdAt: c.createdAt })), parkedAt);
}

/**
 * Whether a person's `--land` waives the boundary for this landing: only for the issue named, and
 * only when both agents classified the change. A missing classification still fails closed.
 */
export function boundaryWaived(landPastBoundary: number | undefined, issue: number, touches: readonly string[] | null | undefined): boolean {
  return landPastBoundary === issue && touches != null && touches.length > 0;
}

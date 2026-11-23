/**
 * The bookkeeping a merge owes, whoever merged it: the card goes to Merged, the merge goes up onto
 * the floor (`afterMerge`), and the issue is closed with a pointer to the pull request. The loop's
 * own merge, a merge a person made while the landing waited on its checks, and a merge the run
 * start finds unrecorded all settle here, so none of them can skip a step the others take.
 */

import type { CloseEvent, Context, MergeEvent } from './context.ts';
import { closeIssue, parkIssue } from './labels.ts';

/** How one merge is recorded: who records it and with what words. */
export type MergeRecord = {
  /** Moves the card to Merged (T1) with the note. */
  place: (note: string) => void;
  note: string;
  by: CloseEvent['by'];
  /** The words the close posts on the issue. */
  comment: string;
  reason: string;
  /** Work done once the floor has the merge and before the issue closes (the lane's removal). */
  beforeClose?: () => void;
  /** Whether the issue is still open; a closed one is not closed again. */
  isOpen?: () => boolean;
  /** The live gate's refusal just before the close, or null; a refusal parks the issue with the merge named. */
  gate?: () => string | null;
};

/** `closed`: the issue was closed now. `already-closed`: it was closed before. `parked`: the gate refused the close. */
export type MergeRecorded = 'closed' | 'already-closed' | 'parked';

export async function recordMerge(ctx: Context, merge: MergeEvent, record: MergeRecord): Promise<MergeRecorded> {
  record.place(record.note);
  // A merge with no commit to name has nothing the floor could walk.
  if (!ctx.dryRun && merge.sha) ctx.afterMerge?.(merge);
  record.beforeClose?.();
  if (record.isOpen && !record.isOpen()) return 'already-closed';
  const refused = ctx.dryRun ? null : (record.gate?.() ?? null);
  if (refused) {
    parkIssue(ctx, merge.issue, `Pull request #${merge.pr} merged at ${merge.mergedAt}, but the issue was not closed because ${refused}. A person closes it or carries on.`);
    return 'parked';
  }
  await closeIssue(ctx, merge.issue, record.comment, { kind: 'merged', pr: merge.pr, mergeSha: merge.sha, reason: record.reason, by: record.by });
  return 'closed';
}

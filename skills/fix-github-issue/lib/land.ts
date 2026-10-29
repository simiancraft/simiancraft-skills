/**
 * `fix.ts --land`: a person's go-ahead to land an approved pull request the merge boundary parked.
 * It waives that boundary and nothing else, so it refuses an issue held for any other reason: a
 * dead letter, a park because the issue changed under the review, or a park with no reason found.
 */

/** The reason the merge boundary writes when it parks an approved change (`pipeline.ts`, land). */
export const BOUNDARY_PARK = /^autoMerge is \S+ and the change touches /;

/**
 * Why `--land` must not act on this issue, or null when it may. `labels` are the issue's label
 * names, `comments` its comments oldest first, and `parkedAt` when `loop/parked` was last added.
 * Every park writes its reason and then the label, so the reason in force is the newest comment
 * at or before that moment; it has to be the boundary's.
 */
export function landBlocker(labels: string[], comments: Array<{ body: string; createdAt: string }>, parkedAt: string | null): string | null {
  const dlq = labels.find((name) => name === 'loop/dlq' || name.startsWith('loop/dlq:'));
  if (dlq) return `it is a dead letter (${dlq}); --land waives only the merge boundary, so use --redrive`;
  if (!labels.includes('loop/parked')) return 'it is not parked; there is no boundary to land past';
  if (!parkedAt) return 'no record of when it was parked; --land cannot tell whether the boundary parked it';
  const reason = comments.filter((c) => Date.parse(c.createdAt) <= Date.parse(parkedAt)).at(-1);
  if (!reason || !BOUNDARY_PARK.test(reason.body.trim())) {
    return 'its newest park was not the merge boundary; --land waives only that boundary, so use --redrive';
  }
  // A park for a missing classification is not waivable: the landing would only park it again.
  if (/categories nobody stated/.test(reason.body)) {
    return 'the boundary parked it because no classification was stated, which --land never waives; use --redrive so the change is classified';
  }
  return null;
}

/**
 * Whether a person's `--land` waives the boundary for this landing: only for the issue named, and
 * only when both agents classified the change. A missing classification still fails closed.
 */
export function boundaryWaived(landPastBoundary: number | undefined, issue: number, touches: readonly string[] | null | undefined): boolean {
  return landPastBoundary === issue && touches != null && touches.length > 0;
}

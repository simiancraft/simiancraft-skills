/**
 * Whether an issue's appraisal still describes it: read at the moment the knife is dispatched, from
 * the stamp the appraisal left (lib/stamp.ts), the base as it stands now, and the thread as people
 * wrote it. No agent runs here; it is a few git and tracker reads.
 *
 * The answer is a verdict with reasons, in the Rumsfeld sense: `fresh` means every check ran and
 * found nothing moved; `stale` means something the appraisal judged has moved; `unknowable` means the
 * stamp is missing or incomplete, so nobody can say the appraisal still holds.
 */

import type { Context } from '../../fix-github-issue/lib/context.ts';
import { sh } from '../../fix-github-issue/lib/shell.ts';
import { latestStamp, threadDigest } from './stamp.ts';

export type Freshness = {
  verdict: 'fresh' | 'stale' | 'unknowable';
  reasons: string[];
};

type Thread = { title: string; body?: string | null; comments: Array<{ author: string; body: string }> };

/** Commits on the base since `from` that touch any of `paths`; throws when git cannot answer. */
export type CommitsSince = (from: string, paths: string[]) => string[];

export function gitCommitsSince(ctx: Context): CommitsSince {
  return (from, paths) => {
    const out = sh(ctx, ['git', 'log', '--format=%h', `${from}..${ctx.project.remote}/${ctx.project.baseBranch}`, '--', ...paths], ctx.repoRoot, 1);
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  };
}

export function appraisalFreshness(issue: Thread, botLogin: string, commitsSince: CommitsSince): Freshness {
  const stamp = latestStamp(issue.comments, botLogin);
  if (!stamp) return { verdict: 'unknowable', reasons: ['no appraisal stamp on the thread'] };
  const reasons: string[] = [];
  let unknowable = false;
  if (threadDigest(issue, botLogin) !== stamp.thread) reasons.push('the thread changed since the appraisal');
  if (!stamp.base) {
    unknowable = true;
    reasons.push('the stamp records no base');
  } else if (stamp.touches.length === 0) {
    unknowable = true;
    reasons.push('the appraisal named no paths, so movement under the issue cannot be scoped');
  } else {
    try {
      const moved = commitsSince(stamp.base, stamp.touches);
      if (moved.length) reasons.push(`${moved.length} commit${moved.length === 1 ? '' : 's'} on its paths since the appraisal (${moved.slice(0, 3).join(', ')}${moved.length > 3 ? ', ...' : ''})`);
    } catch (error) {
      unknowable = true;
      reasons.push(`git could not compare the base: ${(error as Error).message.split('\n')[0]}`);
    }
  }
  // A move that was seen outranks a check that could not run: stale is the stronger statement.
  if (reasons.some((r) => r.startsWith('the thread changed') || /commits? on its paths/.test(r))) return { verdict: 'stale', reasons };
  return { verdict: unknowable ? 'unknowable' : 'fresh', reasons };
}

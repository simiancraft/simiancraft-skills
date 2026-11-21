/**
 * Whether an issue's appraisal still describes it: read at the moment the knife is dispatched, from
 * the stamp the appraisal left (lib/stamp.ts), the base as it stands now, and the thread as people
 * wrote it. No agent runs here; it is a few git and tracker reads.
 *
 * The answer is a verdict with reasons, in the Rumsfeld sense: `fresh` means every check ran and
 * found nothing moved (a stamp that named no paths is checked on its thread alone, and says so); `stale` means something the appraisal judged has moved; `unknowable` means the
 * stamp is missing or incomplete, so nobody can say the appraisal still holds.
 */

import type { Context } from '../../fix-github-issue/lib/context.ts';
import { sh } from '../../fix-github-issue/lib/shell.ts';
import { latestStamp, threadChanges, threadDigest, threadParts } from './stamp.ts';

/**
 * Why a verdict is unknowable, by what is known about the missing knowledge:
 * - `never-stamped`: appraised before this run directory began stamping; no stamp ever existed.
 * - `stamp-missing`: sized after stamping began, so a stamp should be on the thread and is not.
 * - `stamp-unaccounted`: no stamp, and when the issue was sized or when stamping began is not known.
 * - `stamp-incomplete`: a stamp is there, but it names no base, or does not know the paths.
 * - `uncheckable`: the stamp is whole, but git could not compare its base with the base now.
 */
export type UnknowableCause = 'never-stamped' | 'stamp-missing' | 'stamp-unaccounted' | 'stamp-incomplete' | 'uncheckable';

/**
 * What a stamped verdict was read from. `thread-only` is a stamp whose appraisal named no paths (a
 * spike that edits nothing, say): there is no movement under the issue to ask about, so the thread
 * alone decides, and that is a full answer, not a missing one.
 */
export type FreshnessScope = 'thread-and-paths' | 'thread-only';

export type Freshness = {
  verdict: 'fresh' | 'stale' | 'unknowable';
  reasons: string[];
  /** Set only on an unknowable verdict. */
  cause?: UnknowableCause;
  /** Set when a stamp was read. */
  scope?: FreshnessScope;
  /** The files the commits on its paths changed, when they were read; what moved, not only that something did. */
  movedFiles?: string[];
  /** The stamp the verdict read: when it was written and the base it judged; null with no stamp. */
  stampAt: string | null;
  stampBase: string | null;
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

export function gitFilesSince(ctx: Context): (from: string, paths: string[]) => string[] {
  return (from, paths) => {
    const out = sh(ctx, ['git', 'diff', '--name-only', `${from}..${ctx.project.remote}/${ctx.project.baseBranch}`, '--', ...paths], ctx.repoRoot, 1);
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  };
}

export type FreshnessChecks = {
  commitsSince: CommitsSince;
  /** When the issue's newest size label was applied; throws or answers null when that cannot be read. */
  sizedAt?: () => string | null;
  /** When this run directory began stamping appraisals, or null when it never recorded it. */
  stampingSince?: string | null;
  /** The files changed on the base since `from` under `paths`; read only when commits moved them. */
  filesSince?: (from: string, paths: string[]) => string[];
};

export function appraisalFreshness(issue: Thread, botLogin: string, checks: FreshnessChecks): Freshness {
  const stamp = latestStamp(issue.comments, botLogin);
  if (!stamp) return { verdict: 'unknowable', ...unstamped(checks), stampAt: null, stampBase: null };
  const reasons: string[] = [];
  let cause: UnknowableCause | undefined;
  let moved = false;
  let scope: FreshnessScope = 'thread-and-paths';
  let movedFiles: string[] | undefined;
  if (threadDigest(issue, botLogin) !== stamp.thread) {
    moved = true;
    const changes = stamp.parts ? threadChanges(stamp.parts, threadParts(issue, botLogin)) : [];
    reasons.push(changes.length ? `since the appraisal, ${changes.join('; ')}` : 'the thread changed since the appraisal');
  }
  if (!stamp.base) {
    cause = 'stamp-incomplete';
    reasons.push('the stamp records no base');
  } else if (stamp.touches === null) {
    cause = 'stamp-incomplete';
    reasons.push('the appraisal did not say which paths the work changes, so movement under the issue cannot be scoped');
  } else if (stamp.touches.length === 0) {
    scope = 'thread-only';
    reasons.push('paths: none; the appraisal said the work changes no repository paths, so the thread alone decides');
  } else {
    try {
      const commits = checks.commitsSince(stamp.base, stamp.touches);
      if (commits.length) {
        moved = true;
        reasons.push(`${commits.length} commit${commits.length === 1 ? '' : 's'} on its paths since the appraisal (${commits.slice(0, 3).join(', ')}${commits.length > 3 ? ', ...' : ''})`);
        try {
          if (checks.filesSince) movedFiles = checks.filesSince(stamp.base, stamp.touches);
        } catch {
          movedFiles = undefined;
        }
      }
    } catch (error) {
      cause = 'uncheckable';
      reasons.push(`git could not compare the base: ${(error as Error).message.split('\n')[0]}`);
    }
  }
  const seen = { scope, ...(movedFiles ? { movedFiles } : {}), stampAt: stamp.at, stampBase: stamp.base };
  // A move that was seen outranks a check that could not run: stale is the stronger statement.
  if (moved) return { verdict: 'stale', reasons, ...seen };
  if (cause) return { verdict: 'unknowable', reasons, cause, ...seen };
  return { verdict: 'fresh', reasons, ...seen };
}

/** Why there is no stamp, as far as the size label's date and the start of stamping can say. */
function unstamped(checks: FreshnessChecks): { reasons: string[]; cause: UnknowableCause } {
  const since = checks.stampingSince ?? null;
  let sized: string | null = null;
  try {
    sized = checks.sizedAt?.() ?? null;
  } catch {
    sized = null;
  }
  if (since && sized) {
    if (Date.parse(sized) < Date.parse(since)) return { cause: 'never-stamped', reasons: [`no appraisal stamp; it was sized at ${sized}, before stamping began at ${since}`] };
    return { cause: 'stamp-missing', reasons: [`no appraisal stamp, though it was sized at ${sized}, after stamping began at ${since}`] };
  }
  const unknown = [since ? null : 'when stamping began', sized ? null : 'when it was sized'].filter(Boolean).join(' or ');
  return { cause: 'stamp-unaccounted', reasons: [`no appraisal stamp on the thread, and ${unknown} is not known`] };
}

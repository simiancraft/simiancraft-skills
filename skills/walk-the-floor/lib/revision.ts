/**
 * What revision the environment is running, and whether a given merge has reached it. The
 * propagation race becomes a state rather than a guess: `not-yet-deployed` when the merge is not
 * an ancestor of the deployed revision, `unverified` when there is no revision signal and the merge
 * is inside the grace window, and "walk it" otherwise.
 */

export type Pending = 'not-yet-deployed' | 'unverified' | null;

/**
 * Runs the configured revision command and returns the first 7-to-40 hex run in its stdout, or
 * null when the command is unset, fails, or prints no SHA.
 */
export function deployedRevision(command: string | undefined, cwd: string): string | null {
  if (!command) return null;
  const proc = Bun.spawnSync(['sh', '-c', command], { cwd, stderr: 'pipe' });
  if (proc.exitCode !== 0) return null;
  const match = proc.stdout.toString().match(/\b[0-9a-f]{7,40}\b/);
  return match ? match[0] : null;
}

/** True when `sha` is an ancestor of (or equal to) `deployed` in the repository at `repoRoot`. */
export function includesCommit(repoRoot: string, deployed: string, sha: string): boolean {
  const proc = Bun.spawnSync(['git', 'merge-base', '--is-ancestor', sha, deployed], { cwd: repoRoot, stderr: 'pipe' });
  return proc.exitCode === 0;
}

/**
 * Classifies an item before any agent runs. `mergedAt` and `sha` come from the item's ref; an
 * item without a ref is always walked.
 */
export function classify(options: {
  deployed: string | null;
  sha?: string;
  mergedAt?: string;
  graceMinutes: number;
  repoRoot: string;
  now?: number;
}): Pending {
  const { deployed, sha, mergedAt, graceMinutes, repoRoot } = options;
  const now = options.now ?? Date.now();
  if (!sha) return null;
  if (deployed) return includesCommit(repoRoot, deployed, sha) ? null : 'not-yet-deployed';
  if (mergedAt && now - Date.parse(mergedAt) < graceMinutes * 60_000) return 'unverified';
  return null;
}

/**
 * The main checkout follows the base. A merge lands on the remote; the checkout a person is
 * looking at (the one serving their dev server) stays where it was until someone pulls, and a fix
 * that is "merged" is invisible there until they do. When `project.followBase` is set, every
 * confirmed merge fast-forwards the main checkout to the remote base branch.
 *
 * Only a fast-forward, and only when the main checkout already has the base branch checked out
 * with a clean tracked tree. Untracked files are ignored: a dev server's logs and scratch do not
 * make a tree dirty. Anything else (another branch, local edits, a diverged history) is logged and
 * left alone; the checkout is the person's, and this never merges, stashes, or switches for them.
 *
 * Runs git itself rather than through `sh`: that helper retries a failing command four times, and
 * a fast-forward that cannot apply is an answer, not a flake.
 */

import { matchesPath } from './staleness.ts';

export type FollowBaseDeps = {
  repoRoot: string;
  project: { remote: string; baseBranch: string; alwaysInvalidates: readonly string[]; followBase?: boolean };
  dryRun: boolean;
  log: (message: string) => void;
};

export type FollowBaseOutcome =
  | { followed: true; from: string; to: string; invalidating: string[] }
  | { followed: false; why: string };

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const run = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    ok: run.exitCode === 0,
    out: run.stdout.toString().trim(),
    err: run.stderr.toString().trim(),
  };
}

/**
 * Fast-forward the main checkout to `<remote>/<base>` after a merge. `paths` are the files the
 * merge landed; those matching `alwaysInvalidates` are named in the log because the checkout's
 * installed dependencies or generated code no longer match its source.
 */
export function followBase(deps: FollowBaseDeps, paths: readonly string[]): FollowBaseOutcome {
  const { repoRoot, project, log } = deps;
  if (!project.followBase) return { followed: false, why: 'project.followBase is not set' };
  if (deps.dryRun) {
    log(`  DRY RUN  fast-forward the main checkout to ${project.remote}/${project.baseBranch}`);
    return { followed: false, why: 'dry run' };
  }
  const target = `${project.remote}/${project.baseBranch}`;
  const leave = (why: string): FollowBaseOutcome => {
    log(`  main checkout not fast-forwarded: ${why}`);
    return { followed: false, why };
  };

  const branch = git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch.ok) return leave(`could not read its branch (${branch.err})`);
  if (branch.out !== project.baseBranch) return leave(`it has ${branch.out} checked out, not ${project.baseBranch}`);

  const status = git(repoRoot, ['status', '--porcelain', '--untracked-files=no']);
  if (!status.ok) return leave(`could not read its status (${status.err})`);
  if (status.out !== '') return leave('it has uncommitted changes to tracked files');

  const fetch = git(repoRoot, ['fetch', project.remote, project.baseBranch]);
  if (!fetch.ok) return leave(`fetch failed (${fetch.err})`);

  const before = git(repoRoot, ['rev-parse', '--short', 'HEAD']).out;
  const ff = git(repoRoot, ['merge', '--ff-only', target]);
  if (!ff.ok) return leave(`it cannot fast-forward to ${target} (${ff.err.split('\n')[0]})`);
  const after = git(repoRoot, ['rev-parse', '--short', 'HEAD']).out;

  const invalidating = paths.filter((file) => project.alwaysInvalidates.some((pattern) => matchesPath(file, pattern)));
  if (before === after) {
    log(`  main checkout already at ${target} (${after})`);
  } else {
    log(`  main checkout fast-forwarded to ${target}: ${before} -> ${after}`);
  }
  if (invalidating.length > 0) {
    log(`  the main checkout now needs its install or codegen rerun; the merge touched ${invalidating.join(', ')}`);
  }
  return { followed: true, from: before, to: after, invalidating };
}

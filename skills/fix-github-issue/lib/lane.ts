/**
 * The lane: one issue's worktree, its lifecycle, and the locks and guards around it.
 *
 * A lane is created detached at the base, reset when an attempt is discarded, brought up to date
 * only at the front of the merge queue, and removed with the scratch siblings an agent left beside
 * it. The main checkout is never one.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Context } from './context.ts';
import { CONTROL_FILES, inLaneScratch } from './control-files.ts';
import { acquirePidLock } from './pid-lock.ts';
import { sh } from './shell.ts';

/** Porcelain status of a worktree, minus the loop's own control files and a seat's untracked in-lane scratch. */
export function dirtyPaths(ctx: Context, cwd: string): string[] {
  return sh(ctx, ['git', 'status', '--porcelain'], cwd)
    .split('\n')
    .filter(Boolean)
    .filter((line) => !CONTROL_FILES.has(line.slice(3).trim()) && !inLaneScratch(line));
}

/**
 * Keeps a commit under a ref of its own, `refs/loop/rescued/issue-<n>/<sha12>`, in the repository
 * every worktree shares, and returns the ref. One ref per rescue, named for the commit it saves, so a
 * later rescue on the same issue never takes an earlier one's name and leaves its history unreachable.
 */
export function rescueRef(ctx: Context, issue: number, sha: string, cwd: string): string {
  const ref = `refs/loop/rescued/issue-${issue}/${sha.slice(0, 12)}`;
  sh(ctx, ['git', 'update-ref', ref, sha], cwd);
  return ref;
}

/**
 * Returns a lane to what a fresh worker expects: detached at the base, no branch, no scratch.
 *
 * A worker that dies partway has usually already cut its branch and may have committed to it, so
 * retrying in place would fail at `git switch -c` and cascade into a second, confusing failure.
 * The discarded work is the work whose answer the driver already refuses to trust.
 */
export function resetLane(ctx: Context, issue: number, cwd: string): void {
  const remote = ctx.project.remote;
  const base = ctx.project.baseBranch;
  try {
    const branch = sh(ctx, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    // A lane kept from an earlier, stopped run can hold commits that run never pushed; the reset
    // below discards this attempt's work, never theirs, so they keep a ref of their own.
    if (Number(sh(ctx, ['git', 'rev-list', '--count', 'HEAD', '--not', '--remotes'], cwd)) > 0) {
      rescueRef(ctx, issue, sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd), cwd);
    }
    sh(ctx, ['git', 'fetch', remote, base]);
    sh(ctx, ['git', 'checkout', '--detach', `${remote}/${base}`], cwd);
    sh(ctx, ['git', 'reset', '--hard', `${remote}/${base}`], cwd);
    // Ignored files go too, so a half-written artifact cannot be read as this attempt's, but the
    // installed dependencies stay: reinstalling them is minutes of nothing.
    sh(ctx, ['git', 'clean', '-fdx', '-e', 'node_modules'], cwd);
    // The clean took the lane files with the rest of the ignored files.
    copyLaneFiles(ctx, issue, cwd);
    if (branch && branch !== 'HEAD') {
      try {
        sh(ctx, ['git', 'branch', '-D', branch], cwd);
      } catch {
        // the branch was never created, or is already gone
      }
    }
  } catch (error) {
    ctx.log(`  #${issue}  could not reset the lane before retrying: ${error}`);
  }
}

/**
 * A seat's scratch directory, outside its lane: `<runDir>/scratch/issue-<n>/<role>`. Its prompt names
 * it as `SCRATCH_DIR`, and receipts, logs, and drafts go there, never into the worktree, where an
 * untracked file reads as uncommitted work and the review gate refuses the lane. One directory per
 * issue and seat, kept across the lane's attempts and removed when the lane retires (`retireLane`);
 * a lane kept for a person keeps its scratch.
 */
export function seatScratch(ctx: Context, issue: number, role: string): string {
  const dir = join(ctx.runDir, 'scratch', `issue-${issue}`, role);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * `heldLane` answers whether a dirty lane is one the loop's own hold for a person kept: its
 * uncommitted work is this issue's own, left by the seat that asked for the person, and the pickup
 * after the hold is lifted continues on it. Asked only of a dirty lane.
 */
export function worktreeFor(ctx: Context, issue: number, heldLane?: () => boolean): string {
  const dir = resolve(ctx.repoRoot, ctx.project.worktreeRoot, `issue-${issue}`);
  if (existsSync(dir)) {
    // Reconcile leaves a dirty no-PR worktree in place for inspection; handing it to a fresh
    // worker would make the new fix inherit another run's uncommitted state. A hold's lane is the
    // exception: that state is this issue's own, kept for the pickup.
    if (dirtyPaths(ctx, dir).length > 0) {
      if (!heldLane?.()) throw new Error(`worktree for #${issue} is dirty from an earlier run; inspect or remove ${dir}`);
      ctx.log(`#${issue}  continuing on the lane the loop's hold kept, with its uncommitted work`);
    }
    copyLaneFiles(ctx, issue, dir);
    return dir;
  }

  mkdirSync(dirname(dir), { recursive: true });
  sh(ctx, ['git', 'fetch', ctx.project.remote, ctx.project.baseBranch]);
  sh(ctx, ['git', 'worktree', 'add', '--detach', dir, `${ctx.project.remote}/${ctx.project.baseBranch}`]);
  copyLaneFiles(ctx, issue, dir);
  return dir;
}

/**
 * Copies `project.laneFiles` from the main checkout into a lane, overwriting what the lane holds,
 * so every seat finds them without running a command for it. A lane is a fresh worktree and never
 * sees an untracked file such as shared test credentials otherwise.
 *
 * Only a path the lane's git ignores is copied: an untracked file git does not ignore would make
 * the lane dirty and could be committed with the fix. A missing source, a path that is not
 * ignored, or a failed copy is logged and skipped; the lane is still made.
 */
export function copyLaneFiles(ctx: Context, issue: number, dir: string): void {
  for (const path of ctx.project.laneFiles ?? []) {
    const source = resolve(ctx.repoRoot, path);
    if (!existsSync(source)) {
      ctx.log(`  #${issue}  lane file ${path} is not in ${ctx.repoRoot}; the lane goes without it`);
      continue;
    }
    if (Bun.spawnSync(['git', 'check-ignore', '-q', path], { cwd: dir }).exitCode !== 0) {
      ctx.log(`  #${issue}  lane file ${path} is not ignored by git in the lane; not copied, since it could be committed`);
      continue;
    }
    try {
      const target = resolve(dir, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true, force: true });
    } catch (error) {
      ctx.log(`  #${issue}  could not copy lane file ${path}: ${(error as Error).message}`);
    }
  }
}

/*
 * Deliberately NOT sharing `node_modules` with the main checkout.
 *
 * A symlink looks like free speed: a fresh worktree has none, so every agent installs before it can
 * type-check. The install command is typically a frozen-lockfile `bun install` under another name,
 * and both prompts require running it before a push. Through a symlink that install writes into the
 * main checkout's dependencies, from several lanes at once, while a human may be working there.
 * Each worktree therefore installs its own; bun hardlinks from its global cache, so the cost is
 * disk-cheap and the blast radius is one throwaway directory.
 */

/**
 * A lane checked out on an existing pull request's branch, for a redrive that continues the pull
 * request rather than opening a second one. The branch is checked out by name (not detached) so
 * the pushes that follow reach the same remote branch, and it is reset to the remote head so the
 * lane holds exactly what the pull request holds.
 */
export function worktreeAtPullRequest(ctx: Context, issue: number, branch: string, heldLane?: () => boolean): string {
  const dir = resolve(ctx.repoRoot, ctx.project.worktreeRoot, `issue-${issue}`);
  if (existsSync(dir)) {
    // A dirty lane is refused, unless the loop's hold kept it on this pull request's branch: then
    // it is this issue's own work, and the pickup continues on it as it stands (`worktreeFor`).
    const dirty = dirtyPaths(ctx, dir).length > 0;
    const kept = dirty && heldLane?.() === true && sh(ctx, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], dir) === branch;
    if (dirty && !kept) {
      throw new Error(`worktree for #${issue} is dirty from an earlier run; inspect or remove ${dir}`);
    }
    // A run stopped mid-revision can leave commits here that never reached the remote; the reset
    // below would orphan them. On the pull request's own branch they are pushed, and the review that
    // follows reads them; anywhere else they get a ref of their own and the lane is left for a person.
    if (Number(sh(ctx, ['git', 'rev-list', '--count', 'HEAD', '--not', '--remotes'], dir)) > 0) {
      const head = sh(ctx, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], dir);
      if (head !== branch) {
        const rescued = rescueRef(ctx, issue, sh(ctx, ['git', 'rev-parse', 'HEAD'], dir), dir);
        throw new Error(`worktree for #${issue} holds commits no remote has, on ${head} rather than ${branch}; saved as ${rescued}, inspect or remove ${dir}`);
      }
      try {
        sh(ctx, ['git', 'push', ctx.project.remote, `HEAD:refs/heads/${branch}`], dir);
        ctx.log(`#${issue}  pushed ${branch}: the lane held commits from an earlier run that were on no remote`);
      } catch (error) {
        throw new Error(`worktree for #${issue} holds commits no remote has and ${branch} would not take them (${(error as Error).message.split('\n')[0]}); inspect or remove ${dir}`);
      }
    }
    if (kept) {
      ctx.log(`#${issue}  continuing on the lane the loop's hold kept, with its uncommitted work`);
      copyLaneFiles(ctx, issue, dir);
      return dir;
    }
    removeWorktree(ctx, issue);
  }
  mkdirSync(dirname(dir), { recursive: true });
  sh(ctx, ['git', 'fetch', ctx.project.remote, `${branch}:refs/remotes/${ctx.project.remote}/${branch}`]);
  sh(ctx, ['git', 'worktree', 'add', '-B', branch, dir, `${ctx.project.remote}/${branch}`]);
  sh(ctx, ['git', 'branch', `--set-upstream-to=${ctx.project.remote}/${branch}`, branch], dir);
  copyLaneFiles(ctx, issue, dir);
  return dir;
}

export function removeWorktree(ctx: Context, issue: number): void {
  const dir = resolve(ctx.repoRoot, ctx.project.worktreeRoot, `issue-${issue}`);
  if (existsSync(dir)) {
    try {
      sh(ctx, ['git', 'worktree', 'remove', '--force', dir]);
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  removeStrayWorktrees(ctx, issue);
}

/**
 * Agents make their own worktrees (an evidence checkout, a before-state revert) and do not always
 * clean them up. Only ones the agent was told to create, inside this loop's own directory, are
 * removed.
 *
 * An earlier version did the opposite: it removed any registered worktree OUTSIDE the managed
 * directory whose path contained the issue number, force-removing it and then recursively deleting
 * the directory if git refused. A human's checkout kept at a path like `worktrees/fix-1234-typo`
 * would be destroyed, with any uncommitted work in it, the moment the loop worked issue 1234.
 * Path substring is not ownership. Nothing outside `worktreeRoot` is ever touched.
 */
export function removeStrayWorktrees(ctx: Context, issue: number): void {
  const managed = resolve(ctx.repoRoot, ctx.project.worktreeRoot);
  const own = resolve(managed, `issue-${issue}`);

  for (const line of sh(ctx, ['git', 'worktree', 'list', '--porcelain']).split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const dir = resolve(line.slice('worktree '.length).trim());
    if (dir === ctx.repoRoot || dir === own) continue;
    if (!dir.startsWith(`${managed}/`)) continue;
    // The issue number must stand alone between non-digits: cleaning issue 234 must not match a scratch
    // directory another lane made for issue 1234. Substring is not ownership even inside the root.
    if (!new RegExp(`(?:^|[^0-9])${issue}(?:[^0-9]|$)`).test(dir.slice(managed.length + 1))) continue;
    ctx.log(`  removing scratch worktree left by an agent: ${dir}`);
    try {
      sh(ctx, ['git', 'worktree', 'remove', '--force', dir]);
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Worktrees currently in use, for cleanup and for refusing to hand one to two agents at once.
 *
 * Nothing else touches a worktree while its agent owns it. A `git merge` under a running agent
 * either fails on its uncommitted edits or, worse, succeeds and changes files beneath it, so its
 * next commit carries a merge it never saw. Bringing a branch up to date happens only at the front
 * of the integration queue, where no agent is running in it.
 */
export const inFlight = new Map<number, { dir: string; busy: boolean }>();

/**
 * One driver per repository per lock name. Selection reads the tracker and claims what it finds, so
 * a second process started while the first is mid-run picks the same issues and two agents fix them
 * in parallel. The lock records a pid; a lock whose process is gone is stale and gets taken. The
 * name is the caller's, so two drivers sharing a run directory hold distinct locks.
 */
export function claimLock(ctx: Context, name: string): () => void {
  mkdirSync(ctx.runDir, { recursive: true });
  const lockPath = join(ctx.runDir, name);
  return acquirePidLock(
    lockPath,
    {
      held: (pid) => `another burn-down loop is running (pid ${pid}); wait for it or kill it`,
      lost: 'another burn-down loop claimed the lock first; run again once it finishes',
    },
    ctx.log,
  );
}

/**
 * Pulls the base branch into a worktree's branch and pushes the result. Returns false on conflict,
 * leaving the tree clean, since a conflicted catch-up is a human's problem and not the loop's.
 */
export function updateFromBase(ctx: Context, cwd: string, baseSha?: string): boolean {
  // A caller that judged freshness against a pinned commit merges exactly that commit; fetching
  // again here could bring in a newer tip than the one the overlap was computed for.
  if (!baseSha) sh(ctx, ['git', 'fetch', ctx.project.remote, ctx.project.baseBranch], cwd);
  try {
    sh(ctx, ['git', 'merge', '--no-edit', baseSha ?? `${ctx.project.remote}/${ctx.project.baseBranch}`], cwd);
  } catch {
    try {
      sh(ctx, ['git', 'merge', '--abort'], cwd);
    } catch {
      // nothing to abort
    }
    return false;
  }
  sh(ctx, ['git', 'push', ctx.project.remote, 'HEAD'], cwd);
  return true;
}

/**
 * The main checkout is never an agent's working directory. It holds the user's own branch and
 * uncommitted work, and an agent told to `git switch` in it would take that hostage.
 */
export function assertNotMainCheckout(ctx: Context, cwd: string, role: string): void {
  if (resolve(cwd) === resolve(ctx.repoRoot)) {
    throw new Error(`refusing to run ${role} in the main checkout (${ctx.repoRoot}); it must run in a worktree`);
  }
}

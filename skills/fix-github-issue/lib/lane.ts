/**
 * The lane: one issue's worktree, its lifecycle, and the locks and guards around it.
 *
 * A lane is created detached at the base, reset when an attempt is discarded, brought up to date
 * only at the front of the merge queue, and removed with the scratch siblings an agent left beside
 * it. The main checkout is never one.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Context } from './context.ts';
import { CONTROL_FILES } from './control-files.ts';
import { sh } from './shell.ts';

/** Porcelain status of a worktree, minus the loop's own control files. */
export function dirtyPaths(ctx: Context, cwd: string): string[] {
  return sh(ctx, ['git', 'status', '--porcelain'], cwd)
    .split('\n')
    .filter(Boolean)
    .filter((line) => !CONTROL_FILES.has(line.slice(3).trim()));
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
    sh(ctx, ['git', 'fetch', remote, base]);
    sh(ctx, ['git', 'checkout', '--detach', `${remote}/${base}`], cwd);
    sh(ctx, ['git', 'reset', '--hard', `${remote}/${base}`], cwd);
    // Ignored files go too, so a half-written artifact cannot be read as this attempt's, but the
    // installed dependencies stay: reinstalling them is minutes of nothing.
    sh(ctx, ['git', 'clean', '-fdx', '-e', 'node_modules'], cwd);
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

export function worktreeFor(ctx: Context, issue: number): string {
  const dir = resolve(ctx.repoRoot, ctx.project.worktreeRoot, `issue-${issue}`);
  if (existsSync(dir)) {
    // Reconcile leaves a dirty no-PR worktree in place for inspection; handing it to a fresh
    // worker would make the new fix inherit another run's uncommitted state.
    if (dirtyPaths(ctx, dir).length > 0) {
      throw new Error(`worktree for #${issue} is dirty from an earlier run; inspect or remove ${dir}`);
    }
    return dir;
  }

  mkdirSync(dirname(dir), { recursive: true });
  sh(ctx, ['git', 'fetch', ctx.project.remote, ctx.project.baseBranch]);
  sh(ctx, ['git', 'worktree', 'add', '--detach', dir, `${ctx.project.remote}/${ctx.project.baseBranch}`]);
  return dir;
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

  const held = () => {
    const holder = Number(readFileSync(lockPath, 'utf8').trim());
    try {
      process.kill(holder, 0);
      return holder;
    } catch {
      return null;
    }
  };

  // Exclusive create rather than check-then-write: two loops started in the same instant would both
  // pass an existsSync check and both believe they hold the lock.
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  } catch {
    const holder = held();
    if (holder !== null) throw new Error(`another burn-down loop is running (pid ${holder}); wait for it or kill it`);
    ctx.log('clearing a stale lock from a dead process');
    rmSync(lockPath, { force: true });
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  }

  // Read the lock back: two starters can both observe the same dead pid, both clear it, and race
  // the rewrite. Whoever's pid is not in the file lost, and must not run believing it holds it.
  if (readFileSync(lockPath, 'utf8').trim() !== String(process.pid)) {
    throw new Error('another burn-down loop claimed the lock first; run again once it finishes');
  }

  // Release only a lock this process still owns; deleting unconditionally could take out the lock
  // a competing starter just legitimately claimed.
  return () => {
    try {
      if (readFileSync(lockPath, 'utf8').trim() === String(process.pid)) rmSync(lockPath, { force: true });
    } catch {
      // already gone
    }
  };
}

/**
 * Pulls the base branch into a worktree's branch and pushes the result. Returns false on conflict,
 * leaving the tree clean, since a conflicted catch-up is a human's problem and not the loop's.
 */
export function updateFromBase(ctx: Context, cwd: string): boolean {
  sh(ctx, ['git', 'fetch', ctx.project.remote, ctx.project.baseBranch], cwd);
  try {
    sh(ctx, ['git', 'merge', '--no-edit', `${ctx.project.remote}/${ctx.project.baseBranch}`], cwd);
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

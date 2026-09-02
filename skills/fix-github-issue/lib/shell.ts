/**
 * Running commands and reporting on them: the retrying shell every stage goes through, the
 * mutation wrapper that makes `--dry-run` total, and the two console writers.
 */

import type { Context } from './context.ts';

export const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${msg}`);
export const step = (msg: string) => console.log(`\n\x1b[1m${msg}\x1b[0m`);

/**
 * Failures that mean "someone else is holding a shared resource", not "this command is wrong".
 * Concurrent lanes share one `.git` and one GitHub token, so both are contended by construction.
 */
export const CONTENTION = [
  'index.lock', // another lane is writing the shared index or refs
  'cannot lock ref',
  'unable to create',
  'reference already exists',
  'secondary rate limit', // gh; a burst of label edits is enough to trigger one
  'was submitted too quickly',
  'API rate limit',
];

export function sh(ctx: Context, cmd: string[], cwd = ctx.repoRoot, attempts = 4): string {
  // Every gh call is pinned to the configured repository. gh otherwise acts on whatever repo it
  // resolves from the cwd's remotes or its own default, and an unattended mutator that guesses is
  // one that can comment on a downstream tracker: an adopting checkout can carry two remotes
  // pointing at two different repositories.
  const argv = cmd[0] === 'gh' && !cmd.includes('-R') ? [...cmd, '-R', ctx.project.repo] : cmd;
  let lastError = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const proc = Bun.spawnSync(argv, { cwd, stderr: 'pipe' });
    if (proc.exitCode === 0) return proc.stdout.toString().trim();

    lastError = proc.stderr.toString().trim();
    const contended = CONTENTION.some((needle) => lastError.toLowerCase().includes(needle.toLowerCase()));
    if (!contended || attempt === attempts) break;

    // Backoff rather than a tight retry: git holds a lock for the length of another lane's write,
    // and GitHub's secondary limit lengthens the more you push against it.
    Bun.sleepSync(500 * 2 ** (attempt - 1));
  }
  throw new Error(`${cmd.join(' ')}\n${lastError}`);
}

/** A mutation the pipeline performs on GitHub. Every one routes through here so --dry-run is total. */
export function mutate(ctx: Context, description: string, cmd: string[]): void {
  if (ctx.dryRun) {
    ctx.log(`  DRY RUN  ${description}`);
    return;
  }
  ctx.log(`  ${description}`);
  sh(ctx, cmd);
}

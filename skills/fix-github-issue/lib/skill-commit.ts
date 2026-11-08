/** The checkout and commit holding the skill when a run starts. */
export type SkillCommit = { root: string; commit: string };

/** Run git directly: an unknowable checkout is an answer, not a command to retry. */
function git(cwd: string, args: string[]): string | null {
  try {
    const run = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    return run.exitCode === 0 ? run.stdout.toString().trim() || null : null;
  } catch {
    return null;
  }
}

/** Untracked plugin copies must not inherit the surrounding repository's commit. */
export function readSkillCommit(directory: string): SkillCommit | null {
  const root = git(directory, ['rev-parse', '--show-toplevel']);
  if (!root || !git(directory, ['ls-files', '--error-unmatch', '--', '.'])) return null;
  const commit = git(directory, ['rev-parse', '--verify', 'HEAD^{commit}']);
  return commit ? { root, commit } : null;
}

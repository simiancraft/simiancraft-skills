import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { followBase } from './follow-base.ts';

function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

/** A bare remote, a main checkout on `development`, and a second clone that pushes a merge past it. */
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'follow-base-'));
  const remote = join(root, 'remote.git');
  const main = join(root, 'main');
  const other = join(root, 'other');
  git(root, 'init', '--bare', '-b', 'development', remote);
  git(root, 'clone', '-q', remote, main);
  git(main, 'config', 'user.email', 'test@example.com');
  git(main, 'config', 'user.name', 'test');
  writeFileSync(join(main, 'a.txt'), 'a\n');
  git(main, 'add', 'a.txt');
  git(main, 'commit', '-q', '-m', 'first');
  git(main, 'push', '-q', '-u', 'origin', 'development');
  git(root, 'clone', '-q', remote, other);
  git(other, 'config', 'user.email', 'test@example.com');
  git(other, 'config', 'user.name', 'test');
  return { main, other };
}

function landUpstream(other: string, file = 'b.txt'): string {
  writeFileSync(join(other, file), 'b\n');
  git(other, 'add', file);
  git(other, 'commit', '-q', '-m', `land ${file}`);
  git(other, 'push', '-q', 'origin', 'development');
  return git(other, 'rev-parse', '--short', 'HEAD');
}

function deps(main: string, overrides: Partial<Parameters<typeof followBase>[0]> = {}) {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      repoRoot: main,
      project: { remote: 'origin', baseBranch: 'development', alwaysInvalidates: ['package.json'], followBase: true },
      dryRun: false,
      log: (m: string) => lines.push(m),
      ...overrides,
    },
  };
}

describe('the main checkout follows the base', () => {
  it('fast-forwards a clean checkout on the base branch', () => {
    const { main, other } = repository();
    const landed = landUpstream(other);
    const { deps: d, lines } = deps(main);
    const outcome = followBase(d, ['b.txt']);
    expect(outcome).toMatchObject({ followed: true, to: landed, invalidating: [] });
    expect(git(main, 'rev-parse', '--short', 'HEAD')).toBe(landed);
    expect(lines.join('\n')).toContain('fast-forwarded');
  });

  it('names the paths that invalidate the install or codegen', () => {
    const { main, other } = repository();
    landUpstream(other, 'package.json');
    const { deps: d, lines } = deps(main);
    const outcome = followBase(d, ['package.json', 'src/x.ts']);
    expect(outcome).toMatchObject({ followed: true, invalidating: ['package.json'] });
    expect(lines.join('\n')).toContain('needs its install or codegen rerun');
  });

  it('leaves a checkout on another branch alone', () => {
    const { main, other } = repository();
    landUpstream(other);
    git(main, 'checkout', '-q', '-b', 'feature');
    const before = git(main, 'rev-parse', 'HEAD');
    const outcome = followBase(deps(main).deps, ['b.txt']);
    expect(outcome).toMatchObject({ followed: false });
    expect((outcome as { why: string }).why).toContain('feature');
    expect(git(main, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('leaves a checkout with tracked edits alone, and ignores untracked files', () => {
    const { main, other } = repository();
    const landed = landUpstream(other);
    writeFileSync(join(main, 'dev.log'), 'noise\n');
    expect(followBase(deps(main).deps, [])).toMatchObject({ followed: true, to: landed });

    landUpstream(other, 'c.txt');
    writeFileSync(join(main, 'a.txt'), 'edited\n');
    const before = git(main, 'rev-parse', 'HEAD');
    const outcome = followBase(deps(main).deps, ['c.txt']);
    expect(outcome).toMatchObject({ followed: false, why: 'it has uncommitted changes to tracked files' });
    expect(git(main, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('refuses a history that has diverged rather than merging it', () => {
    const { main, other } = repository();
    landUpstream(other);
    writeFileSync(join(main, 'local.txt'), 'local\n');
    git(main, 'add', 'local.txt');
    git(main, 'commit', '-q', '-m', 'local');
    const before = git(main, 'rev-parse', 'HEAD');
    const outcome = followBase(deps(main).deps, ['b.txt']);
    expect(outcome).toMatchObject({ followed: false });
    expect((outcome as { why: string }).why).toContain('cannot fast-forward');
    expect(git(main, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('does nothing unless the config asks, and only logs in a dry run', () => {
    const { main, other } = repository();
    landUpstream(other);
    const before = git(main, 'rev-parse', 'HEAD');
    const off = deps(main, { project: { remote: 'origin', baseBranch: 'development', alwaysInvalidates: [] } });
    expect(followBase(off.deps, [])).toMatchObject({ followed: false, why: 'project.followBase is not set' });
    const dry = deps(main, { dryRun: true });
    expect(followBase(dry.deps, [])).toMatchObject({ followed: false, why: 'dry run' });
    expect(dry.lines[0]).toContain('DRY RUN');
    expect(git(main, 'rev-parse', 'HEAD')).toBe(before);
  });
});

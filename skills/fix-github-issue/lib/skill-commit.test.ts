import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectConfig } from './config.ts';
import { createContext } from './context.ts';
import { readSkillCommit } from './skill-commit.ts';

let scratch: string;
let repo: string;
let skill: string;
const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
};

beforeAll(() => {
  scratch = mkdtempSync(join(process.cwd(), '.skill-commit-'));
  repo = join(scratch, 'repo');
  git(scratch, 'init', '-q', '-b', 'main', repo);
  skill = join(repo, 'skills', 'example');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), 'tracked skill\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'initial');
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('the skill commit at run start', () => {
  it('answers the checkout top level and full HEAD for a tracked directory', () => {
    expect(readSkillCommit(skill)).toEqual({ root: repo, commit: git(repo, 'rev-parse', 'HEAD') });
  });

  it('does not attribute an untracked copy to its surrounding repository', () => {
    const copy = join(repo, 'plugin-copy');
    mkdirSync(copy);
    writeFileSync(join(copy, 'SKILL.md'), 'untracked copy\n');
    expect(readSkillCommit(copy)).toBeNull();
  });

  it('answers null outside git', () => {
    const outside = join(scratch, 'outside');
    mkdirSync(outside);
    // Keep the fixture in this worktree, but prevent discovery of its enclosing repository.
    const run = Bun.spawnSync([process.execPath, '--eval', `import { readSkillCommit } from ${JSON.stringify(join(import.meta.dir, 'skill-commit.ts'))}; console.log(JSON.stringify(readSkillCommit(process.cwd())));`], {
      cwd: outside,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: scratch },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().trim()).toBe('null');
  });

  it('answers null when tracked files have no readable HEAD', () => {
    const unborn = join(scratch, 'unborn');
    git(scratch, 'init', '-q', '-b', 'main', unborn);
    writeFileSync(join(unborn, 'SKILL.md'), 'staged only\n');
    git(unborn, 'add', '.');
    expect(readSkillCommit(unborn)).toBeNull();
  });

  it('preserves the option through createContext and the floor spread copy', () => {
    const options: Parameters<typeof createContext>[0] = {
      project: { worktreeRoot: 'wt' } as ProjectConfig,
      knobs: { autoMerge: 'never' as const, maxReviewRounds: 3, checksTimeoutMinutes: 1, smokeTimeoutMinutes: 1 },
      seats: { worker: { engine: 'fixture' }, reviewer: { engine: 'fixture2' } },
      repoRoot: repo,
      invokeRoot: repo,
      promptsDirs: [skill],
      dryRun: true,
      botLogin: 'test',
    };
    const record = readSkillCommit(skill);
    expect(record).not.toBeNull();
    const ctx = createContext({ ...options, skillCommit: record });
    expect(ctx.skillCommit).toEqual(record);
    expect({ ...ctx, integrationQueue: Promise.resolve() }.skillCommit).toEqual(record);
    expect(createContext({ ...options, skillCommit: null }).skillCommit).toBeNull();
    expect(createContext(options).skillCommit).toBeUndefined();
  });
});

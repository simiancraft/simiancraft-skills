import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from './config.ts';
import type { Context } from './context.ts';
import { preserveLaneWork } from './pipeline.ts';

/** A real remote, a real lane: what a failed attempt leaves behind is only interesting on disk. */
let scratch: string;
let repo: string;
const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
};

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lane-work-'));
  repo = join(scratch, 'repo');
  git(scratch, 'init', '-q', '--bare', '-b', 'main', join(scratch, 'origin.git'));
  git(scratch, 'clone', '-q', join(scratch, 'origin.git'), repo);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'one');
  git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PROJECT = { remote: 'origin', baseBranch: 'main', worktreeRoot: 'wt' } as ProjectConfig;
const ctxFor = (lines: string[]) => ({ project: PROJECT, repoRoot: repo, dryRun: false, log: (m: string) => lines.push(m) }) as unknown as Context;

/** A lane as the pipeline makes one, at `<worktreeRoot>/issue-<n>`. */
function lane(issue: number, commit: boolean, branch = `fix/work-${issue}`) {
  const dir = join(repo, 'wt', `issue-${issue}`);
  mkdirSync(join(repo, 'wt'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '--detach', dir, 'origin/main');
  if (commit) {
    git(dir, 'switch', '-q', '-c', branch);
    writeFileSync(join(dir, `work-${issue}.txt`), 'a finished change\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', `fix: the change for ${issue}`);
  }
  return dir;
}

const onRemote = (branch: string) => git(repo, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`) !== '';

describe('what a finished lane leaves behind', () => {
  it('pushes commits that are on no remote, so a failed attempt does not throw its work away', () => {
    const lines: string[] = [];
    const dir = lane(71, true);
    expect(onRemote('fix/work-71')).toBe(false);
    expect(preserveLaneWork(ctxFor(lines), 71, (m) => lines.push(m))).toBe(true);
    expect(onRemote('fix/work-71')).toBe(true);
    expect(git(repo, 'rev-parse', 'origin/fix/work-71')).toBe(git(dir, 'rev-parse', 'HEAD'));
    expect(lines.some((l) => /pushed fix\/work-71/.test(l))).toBe(true);
  });

  it('pushes nothing for a lane that only ever read: no branch, nothing of its own', () => {
    const lines: string[] = [];
    lane(72, false);
    expect(preserveLaneWork(ctxFor(lines), 72, (m) => lines.push(m))).toBe(true);
    expect(lines.filter((l) => /pushed/.test(l))).toEqual([]);
  });

  it('pushes nothing when the remote already has the work, and lets the lane go', () => {
    const lines: string[] = [];
    const dir = lane(73, true);
    git(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/fix/work-73');
    git(dir, 'fetch', '-q', 'origin');
    expect(preserveLaneWork(ctxFor(lines), 73, (m) => lines.push(m))).toBe(true);
    expect(lines.filter((l) => /pushed/.test(l))).toEqual([]);
  });

  it('keeps the lane when the work cannot be pushed: removing it would be the irreversible act', () => {
    const lines: string[] = [];
    const dir = lane(74, true);
    // The remote refuses this branch, as a protection rule or a lost credential would.
    writeFileSync(join(scratch, 'origin.git', 'hooks', 'pre-receive'), '#!/bin/sh\necho "refused by the remote" >&2\nexit 1\n');
    Bun.spawnSync(['chmod', '+x', join(scratch, 'origin.git', 'hooks', 'pre-receive')]);
    expect(preserveLaneWork(ctxFor(lines), 74, (m) => lines.push(m))).toBe(false);
    expect(lines.some((l) => /keeping the lane/.test(l))).toBe(true);
    expect(git(dir, 'rev-parse', 'HEAD')).not.toBe('');
    rmSync(join(scratch, 'origin.git', 'hooks', 'pre-receive'));
  });

  it("keeps the lane, and pushes nothing, when its commits sit on a branch that is not this issue's", () => {
    const lines: string[] = [];
    lane(76, true, 'fix/someone-elses-99');
    expect(preserveLaneWork(ctxFor(lines), 76, (m) => lines.push(m))).toBe(false);
    expect(onRemote('fix/someone-elses-99')).toBe(false);
    expect(lines.some((l) => /not this issue's branch/.test(l))).toBe(true);
  });

  it('never publishes the base branch from a cleanup step', () => {
    const lines: string[] = [];
    const dir = lane(77, false);
    git(dir, 'switch', '-q', '--ignore-other-worktrees', 'main');
    writeFileSync(join(dir, 'sneaky.txt'), 'never reviewed\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'fix: straight onto the base');
    const before = git(repo, 'rev-parse', 'origin/main');
    expect(preserveLaneWork(ctxFor(lines), 77, (m) => lines.push(m))).toBe(false);
    expect(git(repo, 'rev-parse', 'origin/main')).toBe(before);
  });

  it('says a lane that is already gone holds nothing', () => {
    expect(preserveLaneWork(ctxFor([]), 75, () => {})).toBe(true);
  });
});

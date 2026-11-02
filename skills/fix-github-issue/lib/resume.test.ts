import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from './context.ts';
import { claimHolder, judgeLane, parkForInspection } from './resume.ts';
import { RunStopping } from './shell.ts';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';

let scratch: string;
let repo: string;
let head: string;
const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
};
const ctx = () => ({ repoRoot: repo, project: { worktreeRoot: 'wt', repo: 'o/r' } }) as Context;
function lane(issue: number) {
  const dir = join(repo, 'wt', `issue-${issue}`);
  git(repo, 'worktree', 'add', '-q', '-b', `fix/resume-${issue}`, dir, head);
  return dir;
}
beforeAll(() => {
  scratch = mkdtempSync(join(process.cwd(), '.resume-test-'));
  repo = join(scratch, 'repo');
  git(scratch, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(scratch, 'clone', '-q', join(scratch, 'origin.git'), repo);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'one');
  git(repo, 'push', '-q', 'origin', 'HEAD');
  head = git(repo, 'rev-parse', 'HEAD');
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('judgeLane', () => {
  it('does not read a head for a missing or dirty lane', () => {
    const read = () => { throw new Error('must not read'); };
    expect(judgeLane(ctx(), 1, read)).toEqual({ kind: 'no-lane' });
    const dir = lane(2);
    writeFileSync(join(dir, 'unfinished.txt'), 'work');
    expect(judgeLane(ctx(), 2, read)).toMatchObject({ kind: 'dirty', reason: expect.stringContaining('unfinished.txt') });
  });

  it('recognizes the head and leaves an unpushed revision unpublished', () => {
    const dir = lane(3);
    git(dir, 'push', '-q', 'origin', 'HEAD');
    const before = git(repo, 'ls-remote', 'origin');
    expect(judgeLane(ctx(), 3, () => head)).toEqual({ kind: 'clean-at-head' });
    writeFileSync(join(dir, 'revision.txt'), 'revision');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'revision');
    const revision = git(dir, 'rev-parse', 'HEAD');
    const result = judgeLane(ctx(), 3, () => head);
    expect(result.kind).toBe('off-head');
    if (result.kind !== 'off-head') throw new Error('expected off-head');
    expect(result.reason).toContain(head);
    expect(result.reason).toContain(revision);
    expect(git(repo, 'ls-remote', 'origin')).toBe(before);
  });

  it('leaves a failed tracker read pending and tries again next time', () => {
    lane(4);
    expect(judgeLane(ctx(), 4, () => { throw new Error('offline'); })).toMatchObject({ kind: 'unreadable' });
    expect(judgeLane(ctx(), 4, () => head)).toEqual({ kind: 'clean-at-head' });
    const stop = new RunStopping('stop');
    expect(() => judgeLane(ctx(), 4, () => { throw stop; })).toThrow(stop);
  });

  it('names a failed local git read and never reads the tracker', () => {
    const dir = lane(5);
    rmSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git'), 'gitdir: missing-git-directory\n');
    expect(judgeLane(ctx(), 5, () => { throw new Error('must not read'); })).toMatchObject({ kind: 'dirty', reason: expect.stringContaining('git status --porcelain') });
  });

  it('names a failed HEAD read', () => {
    lane(6);
    const original = Bun.spawnSync;
    const spy = spyOn(Bun, 'spawnSync').mockImplementation(((args: string[], opts: unknown) => {
      if (args.join(' ') === 'git rev-parse HEAD') throw new Error('head unavailable');
      return original(args, opts as any);
    }) as typeof Bun.spawnSync);
    try {
      expect(judgeLane(ctx(), 6, () => head)).toMatchObject({ kind: 'dirty', reason: expect.stringContaining('git rev-parse HEAD') });
    } finally { spy.mockRestore(); }
  });
});

it('claimHolder fails closed on a failed read and propagates a stop', () => {
  const io = new FakeTracker('bot', [fakeIssue(7)]);
  const context = { ...ctx(), io, runId: 'this-run', botLogin: 'bot' } as Context;
  const spy = spyOn(io, 'view').mockImplementation(() => { throw new Error('offline'); });
  try {
    expect(claimHolder(context, 7, new Map())).toContain('unreadable claim');
    const stop = new RunStopping('stop');
    spy.mockImplementation(() => { throw stop; });
    expect(() => claimHolder(context, 7, new Map())).toThrow(stop);
  } finally { spy.mockRestore(); }
});

it('records dirty and off-head reasons in the work dead letter', () => {
  const io = new FakeTracker('bot', [fakeIssue(2), fakeIssue(3)]);
  const context = { ...ctx(), io, dryRun: false, log: () => {} } as Context;
  const original = Bun.spawnSync;
  const spy = spyOn(Bun, 'spawnSync').mockImplementation(((args: string[], opts: unknown) => {
    if (args[0] === 'gh') {
      expect(args.slice(0, 3)).toEqual(['gh', 'issue', 'view']);
      return { exitCode: 0, stdout: Buffer.from('OPEN'), stderr: Buffer.from('') };
    }
    return original(args, opts as any);
  }) as typeof Bun.spawnSync);
  try {
    for (const issue of [2, 3]) {
      const judgement = judgeLane(context, issue, () => head);
      if (judgement.kind !== 'dirty' && judgement.kind !== 'off-head') throw new Error('expected held work');
      parkForInspection(context, issue, judgement.reason);
      expect(io.view(issue)?.labels.map(l => l.name)).toContain('loop/dlq: work');
      expect(io.view(issue)?.comments.at(-1)?.body).toContain(judgement.reason);
    }
  } finally { spy.mockRestore(); }
});

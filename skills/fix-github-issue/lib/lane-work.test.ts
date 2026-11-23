import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { laneFilesFault, type ProjectConfig } from './config.ts';
import type { Context } from './context.ts';
import { claim } from '../../carve-github-issue/lib/claims.ts';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import { preserveLaneWork, retireLane } from './pipeline.ts';
import { reconcile } from './resume.ts';
import { dirtyPaths, resetLane, worktreeAtPullRequest, worktreeFor } from './lane.ts';

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
const say = (lines: string[]) => (m: string) => lines.push(m);
const ctxFor = (lines: string[]) => ({ project: PROJECT, repoRoot: repo, dryRun: false, log: (m: string) => lines.push(m) }) as unknown as Context;

/** A lane as the pipeline makes one, at `<worktreeRoot>/issue-<n>`. */
function lane(issue: number, commit: boolean, branch = `fix/work-${issue}`) {
  const dir = join(repo, 'wt', `issue-${issue}`);
  rmSync(dir, { recursive: true, force: true });
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
  it('keeps a lane holding uncommitted edits: a forced removal would delete the only copy', () => {
    const lines: string[] = [];
    const dir = lane(70, false);
    writeFileSync(join(dir, 'half-done.txt'), 'edits nobody committed\n');
    retireLane(ctxFor(lines), 70, (m) => lines.push(m));
    expect(existsSync(join(dir, 'half-done.txt'))).toBe(true);
    expect(lines.some((l) => /keeping the lane: it holds uncommitted changes \(half-done\.txt\)/.test(l))).toBe(true);
  });

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

  it('keeps a detached lane that committed before it made a branch: nothing else has that work', () => {
    const lines: string[] = [];
    const dir = lane(78, false);
    writeFileSync(join(dir, 'detached.txt'), 'committed before branching\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'fix: before the branch');
    const head = git(dir, 'rev-parse', 'HEAD');
    expect(preserveLaneWork(ctxFor(lines), 78, (m) => lines.push(m))).toBe(false);
    // Saved under a ref the whole repository shares, so the work survives even the lane being
    // removed later, by this run's cleanup or by the next run's reconcile.
    const rescues = () => git(repo, 'for-each-ref', '--format=%(objectname)', 'refs/loop/rescued/issue-78/').split('\n').filter(Boolean);
    expect(rescues()).toEqual([head]);
    git(repo, 'worktree', 'remove', '--force', dir);
    expect(rescues()).toEqual([head]);
    expect(lines.some((l) => /saved its detached commits/.test(l))).toBe(true);

    // A second attempt on the same issue, its own unrelated history: it takes no name the first one holds.
    const again = lane(78, false);
    writeFileSync(join(again, 'second-try.txt'), 'another attempt\n');
    git(again, 'add', '.');
    git(again, 'commit', '-q', '-m', 'fix: the second attempt');
    const second = git(again, 'rev-parse', 'HEAD');
    expect(preserveLaneWork(ctxFor(lines), 78, (m) => lines.push(m))).toBe(false);
    git(repo, 'worktree', 'remove', '--force', again);
    expect(rescues().sort()).toEqual([head, second].sort());
  });

  it('says a lane that is already gone holds nothing', () => {
    expect(preserveLaneWork(ctxFor([]), 75, () => {})).toBe(true);
  });

  it('retires a lane by keeping its work first: a hand-off removes nothing it cannot replace', () => {
    const lines: string[] = [];
    const dir = lane(79, false);
    writeFileSync(join(dir, 'handed-off.txt'), 'committed, then needs-human\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'fix: before asking for a person');
    const head = git(dir, 'rev-parse', 'HEAD');
    retireLane(ctxFor(lines), 79, say(lines));
    // The lane stayed, and the commits are referenced whatever happens to it next.
    expect(existsSync(dir)).toBe(true);
    expect(git(repo, 'for-each-ref', '--format=%(objectname)', 'refs/loop/rescued/issue-79/')).toBe(head);
  });

  it('retires a lane that holds nothing by simply removing it', () => {
    const lines: string[] = [];
    const dir = lane(80, false);
    retireLane(ctxFor(lines), 80, say(lines));
    expect(existsSync(dir)).toBe(false);
  });
});

describe('reconcile at a loop start', () => {
  const ctxWith = (io: FakeTracker, runId: string) =>
    ({ project: { ...PROJECT, repo: 'o/r' }, repoRoot: repo, dryRun: false, dryRunLog: [], botLogin: 'loop-bot', runId, io, log: () => {} }) as unknown as Context;

  it('leaves a lane alone while another live run claims its issue, as a hand-run fix does', async () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(81)]);
    const dir = lane(81, false);
    // The hand-run fix: same host, a live pid (this one), a different run.
    const handRun = ctxWith(io, `${hostname()}-${process.pid}-1`);
    const held = await claim(handRun, io, 81, 'working');
    expect(held).not.toBe('busy');
    reconcile(ctxWith(io, `${hostname()}-${process.pid}-2`), new Set());
    expect(existsSync(dir)).toBe(true);
    if (held !== 'busy') held.release();
  });

  it('retires a clean lane nobody claims', () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(82)]);
    const dir = lane(82, false);
    reconcile(ctxWith(io, `${hostname()}-${process.pid}-3`), new Set());
    expect(existsSync(dir)).toBe(false);
  });

  it("saves a closed issue's uncommitted work under a ref and removes its lane, saying once where it went", () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(86, { state: 'CLOSED', stateReason: 'COMPLETED' })]);
    const dir = lane(86, true);
    const head = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'a.txt'), 'edited\n');
    writeFileSync(join(dir, 'new.txt'), 'never added\n');
    git(dir, 'rm', '-q', '--cached', 'work-86.txt');
    const lines: string[] = [];
    const ctx = { ...ctxWith(io, `${hostname()}-${process.pid}-4`), log: (m: string) => lines.push(m) } as Context;
    reconcile(ctx, new Set());
    expect(existsSync(dir)).toBe(false);
    const [ref] = git(repo, 'for-each-ref', '--format=%(refname)', 'refs/loop/rescued/issue-86/').split('\n');
    expect(ref).toMatch(/^refs\/loop\/rescued\/issue-86\/[0-9a-f]{12}$/);
    // The saved commit sits on the lane's HEAD and holds the working tree as it was, untracked files too.
    expect(git(repo, 'rev-parse', `${ref}^`)).toBe(head);
    expect(git(repo, 'show', `${ref}:a.txt`)).toBe('edited');
    expect(git(repo, 'show', `${ref}:new.txt`)).toBe('never added');
    expect(git(repo, 'show', `${ref}:work-86.txt`)).toBe('a finished change');
    expect(lines.filter((l) => l.includes(ref))).toHaveLength(1);
    expect(lines.some((l) => /leaving it for inspection/.test(l))).toBe(false);
    // Nothing is written on a closed issue, and the next start has nothing to say about it.
    expect(io.writes).toEqual([]);
    const again: string[] = [];
    reconcile({ ...ctx, log: (m: string) => again.push(m) } as Context, new Set());
    expect(again.filter((l) => l.includes('#86'))).toEqual([]);
  });

  it("keeps a closed issue's dirty lane while an open pull request is on its branch", () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(87, { state: 'CLOSED', stateReason: 'NOT_PLANNED' })]);
    io.openPulls = ['fix/work-87'];
    const dir = lane(87, true);
    writeFileSync(join(dir, 'half-done.txt'), 'edits nobody committed\n');
    reconcile(ctxWith(io, `${hostname()}-${process.pid}-5`), new Set());
    expect(existsSync(join(dir, 'half-done.txt'))).toBe(true);
    expect(git(repo, 'for-each-ref', 'refs/loop/rescued/issue-87/')).toBe('');
  });

  it("keeps an open issue's dirty lane for inspection, as before", () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(88)]);
    const dir = lane(88, false);
    writeFileSync(join(dir, 'half-done.txt'), 'edits nobody committed\n');
    const lines: string[] = [];
    reconcile({ ...ctxWith(io, `${hostname()}-${process.pid}-6`), dryRun: true, log: (m: string) => lines.push(m) } as Context, new Set());
    expect(existsSync(join(dir, 'half-done.txt'))).toBe(true);
    expect(git(repo, 'for-each-ref', 'refs/loop/rescued/issue-88/')).toBe('');
    expect(lines.some((l) => /#88 has uncommitted work and no pull request; leaving it for inspection/.test(l))).toBe(true);
  });
});

describe('resuming a pull request in its lane', () => {
  it('pushes commits an earlier run left unpushed on the branch, rather than resetting them away', () => {
    const lines: string[] = [];
    const dir = lane(83, true, 'fix/resume-83');
    git(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/fix/resume-83');
    git(dir, 'branch', '-q', '--set-upstream-to=origin/fix/resume-83');
    // The revision a stopped run committed and never pushed.
    writeFileSync(join(dir, 'revision.txt'), 'the reviewer asked for this\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'fix: the revision');
    const revision = git(dir, 'rev-parse', 'HEAD');
    const out = worktreeAtPullRequest(ctxFor(lines), 83, 'fix/resume-83');
    expect(git(out, 'rev-parse', 'HEAD')).toBe(revision);
    expect(git(repo, 'ls-remote', 'origin', 'refs/heads/fix/resume-83').split('\t')[0]).toBe(revision);
  });

  it('keeps commits on another branch under a ref and refuses, rather than resetting them away', () => {
    const lines: string[] = [];
    const dir = lane(84, true, 'fix/elsewhere-84');
    const sha = git(dir, 'rev-parse', 'HEAD');
    git(repo, 'push', '-q', 'origin', 'origin/main:refs/heads/fix/resume-84');
    expect(() => worktreeAtPullRequest(ctxFor(lines), 84, 'fix/resume-84')).toThrow(/holds commits no remote has/);
    expect(existsSync(dir)).toBe(true);
    expect(git(repo, 'rev-parse', `refs/loop/rescued/issue-84/${sha.slice(0, 12)}`)).toBe(sha);
  });
});

describe('resetting a lane for a retry', () => {
  it('gives commits no remote has a ref of their own before deleting the branch that held them', () => {
    const dir = lane(85, true, 'fix/inherited-85');
    const sha = git(dir, 'rev-parse', 'HEAD');
    resetLane(ctxFor([]), 85, dir);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(git(repo, 'rev-parse', `refs/loop/rescued/issue-85/${sha.slice(0, 12)}`)).toBe(sha);
  });
});

describe('lane files: untracked files the main checkout holds and every lane needs', () => {
  const laneCtx = (lines: string[]) =>
    ({ project: { ...PROJECT, laneFiles: ['.env.test.local', 'config/secret.json', 'absent.env', 'loose.txt'] }, repoRoot: repo, dryRun: false, log: (m: string) => lines.push(m) }) as unknown as Context;
  beforeAll(() => {
    // Ignored in every worktree, as a committed .gitignore entry would be, without moving the base.
    appendFileSync(join(repo, '.git', 'info', 'exclude'), '.env.test.local\nconfig/secret.json\n');
    writeFileSync(join(repo, '.env.test.local'), 'TEST_USER=shared\n');
    mkdirSync(join(repo, 'config'), { recursive: true });
    writeFileSync(join(repo, 'config', 'secret.json'), '{"k":1}\n');
    writeFileSync(join(repo, 'loose.txt'), 'untracked and not ignored\n');
  });
  afterAll(() => {
    for (const file of ['.env.test.local', 'config', 'loose.txt']) rmSync(join(repo, file), { recursive: true, force: true });
  });

  it('copies each ignored lane file into a new lane, and warns past a missing or unignored one', () => {
    const lines: string[] = [];
    rmSync(join(repo, 'wt', 'issue-90'), { recursive: true, force: true });
    const dir = worktreeFor(laneCtx(lines), 90);
    expect(readFileSync(join(dir, '.env.test.local'), 'utf8')).toBe('TEST_USER=shared\n');
    expect(readFileSync(join(dir, 'config', 'secret.json'), 'utf8')).toBe('{"k":1}\n');
    expect(existsSync(join(dir, 'absent.env'))).toBe(false);
    expect(existsSync(join(dir, 'loose.txt'))).toBe(false);
    expect(lines.some((l) => l.includes('absent.env') && l.includes('goes without it'))).toBe(true);
    expect(lines.some((l) => l.includes('loose.txt') && l.includes('not ignored'))).toBe(true);
    // Copied files are ignored, so the lane stays clean and is reusable.
    expect(git(dir, 'status', '--porcelain')).toBe('');
    rmSync(join(dir, '.env.test.local'));
    worktreeFor(laneCtx([]), 90);
    expect(existsSync(join(dir, '.env.test.local'))).toBe(true);
  });

  it('puts the lane files back after a reset cleans the ignored files away', () => {
    const dir = lane(91, true);
    resetLane(laneCtx([]), 91, dir);
    expect(readFileSync(join(dir, '.env.test.local'), 'utf8')).toBe('TEST_USER=shared\n');
  });

  it('copies the lane files into a lane made on a pull request\'s branch', () => {
    const dir = lane(92, true, 'fix/lane-files-92');
    git(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/fix/lane-files-92');
    git(repo, 'worktree', 'remove', '--force', dir);
    const out = worktreeAtPullRequest(laneCtx([]), 92, 'fix/lane-files-92');
    expect(existsSync(join(out, '.env.test.local'))).toBe(true);
  });

  it('accepts only relative paths that stay inside the repository', () => {
    expect(laneFilesFault(undefined)).toBeNull();
    expect(laneFilesFault(['.env.test.local', 'config/secret.json'])).toBeNull();
    for (const value of [null, '.env', [''], ['/etc/passwd'], ['../outside'], ['a/../../b'], ['.'], [3]]) {
      expect(laneFilesFault(value)).toContain('project.laneFiles');
    }
  });
});

describe('a prover that staged its receipts inside the lane', () => {
  it('leaves a lane clean when only proof scratch is untracked in it', () => {
    const dir = lane(95, true);
    for (const scratchDir of ['.proof', '.proof-95']) {
      mkdirSync(join(dir, scratchDir), { recursive: true });
      writeFileSync(join(dir, scratchDir, 'gate.log'), 'receipts already on the evidence branch\n');
    }
    expect(dirtyPaths(ctxFor([]), dir)).toEqual([]);
  });

  it('still calls a real code edit beside the scratch dirty', () => {
    const dir = lane(96, true);
    mkdirSync(join(dir, '.proof'), { recursive: true });
    writeFileSync(join(dir, '.proof', 'gate.log'), 'receipts\n');
    writeFileSync(join(dir, 'work-96.txt'), 'an edit nobody committed\n');
    writeFileSync(join(dir, '.proofreader.ts'), 'a new source file whose name only starts like the scratch\n');
    expect(dirtyPaths(ctxFor([]), dir).map((line) => line.trim().split(/\s+/).pop()).sort()).toEqual(['.proofreader.ts', 'work-96.txt']);
  });
});

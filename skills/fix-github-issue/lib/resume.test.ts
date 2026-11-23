import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from './context.ts';
import { claimHolder, findStranded, judgeLane, managedLanes, parkForInspection, resumeOneStranded } from './resume.ts';
import { RunStopping } from './shell.ts';
import { stopComment } from './stop-record.ts';
import { claimMarker } from '../../carve-github-issue/lib/claims.ts';
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

it('managedLanes lists issue lanes and their scratch siblings, and reads a claim once per issue', () => {
  const own = lane(61);
  const sibling = join(repo, 'wt', 'issue-61-evidence');
  git(repo, 'worktree', 'add', '-q', '--detach', sibling, head);
  git(repo, 'worktree', 'add', '-q', '--detach', join(repo, 'wt', 'scratch-61'), head);
  git(repo, 'worktree', 'add', '-q', '--detach', join(scratch, 'issue-62'), head);
  const io = new FakeTracker('bot', [fakeIssue(61)]);
  const context = { ...ctx(), io, runId: 'this-run', botLogin: 'bot' } as Context;
  const view = spyOn(io, 'view');
  try {
    const lanes = managedLanes(context).filter((l) => l.issue === 61 || l.issue === 62);
    expect(lanes.map(({ issue, dir, parent, sibling }) => ({ issue, dir, parent, sibling }))).toEqual([
      { issue: 61, dir: own, parent: own, sibling: false },
      { issue: 61, dir: sibling, parent: own, sibling: true },
    ]);
    expect(view).not.toHaveBeenCalled();
    expect(lanes.map((l) => l.holder())).toEqual([null, null]);
    expect(view).toHaveBeenCalledTimes(1);
  } finally { view.mockRestore(); }
});

it('findStranded leaves a lane alone while another run claims its issue, as a redrive does before it lifts the hold', () => {
  lane(41);
  lane(42);
  const io = new FakeTracker('bot', [fakeIssue(41), fakeIssue(42)]);
  // A redrive's claim, taken before its hold came off; the hold is already gone.
  io.comment(41, 'bot', claimMarker('working', 'redrive-elsewhere', '2026-11-01T00:00:00Z', '2999-01-01T00:00:00Z', 'tok'));
  const lines: string[] = [];
  const context = { ...ctx(), io, runId: 'starting-run', botLogin: 'bot', dryRun: false, knobs: { maxReviewRounds: 3 }, log: (m: string) => lines.push(m) } as unknown as Context;
  const original = Bun.spawnSync;
  const spy = spyOn(Bun, 'spawnSync').mockImplementation(((args: string[], opts: unknown) => {
    if (args[0] === 'gh') return { exitCode: 0, stdout: Buffer.from('OPEN'), stderr: Buffer.from('') };
    return original(args, opts as any);
  }) as typeof Bun.spawnSync);
  try {
    const issues = [41, 42].map((number) => ({ number, title: 't', createdAt: '2026-09-01T00:00:00Z', labels: [] }));
    expect(findStranded(context, issues, [])).toEqual([]);
    expect(lines).toContain('#41  stranded lane is claimed by redrive-elsewhere; leaving it in place');
    expect(io.view(41)?.labels.map((l) => l.name)).toEqual([]);
    expect(io.writes.filter((w) => w.argv.includes('41'))).toEqual([]);
    // The unclaimed lane beside it is still judged.
    expect(io.view(42)?.labels.map((l) => l.name)).toContain('loop/dlq: work');
  } finally { spy.mockRestore(); }
});

describe('resumeOneStranded before it starts', () => {
  const entry = (n: number) => ({ issue: { number: n, title: 't', createdAt: '2026-09-01T00:00:00Z', labels: [] }, cwd: join(repo, 'wt', `issue-${n}`), result: { issue: n, verdict: 'fixed' as const, reason: 'r', pr: 9, branch: `fix/resume-${n}` } });
  const run = async (io: FakeTracker, n: number) => {
    const lines: string[] = [];
    const context = { ...ctx(), io, runId: 'this-run', botLogin: 'bot', dryRun: false, knobs: { maxReviewRounds: 3 }, log: (m: string) => lines.push(m) } as unknown as Context;
    const original = Bun.spawnSync;
    const spy = spyOn(Bun, 'spawnSync').mockImplementation(((args: string[], opts: unknown) => {
      if (args[0] === 'gh') return { exitCode: 0, stdout: Buffer.from(io.view(n)?.labels.some((l) => l.name.startsWith('loop/dlq')) ? 'OPEN loop/dlq' : 'OPEN'), stderr: Buffer.from('') };
      return original(args, opts as any);
    }) as typeof Bun.spawnSync);
    try {
      return { outcome: await resumeOneStranded(context, entry(n), 2), lines };
    } finally { spy.mockRestore(); }
  };
  it('a gate that refuses the issue starts nothing, claims nothing, and leaves a work dead letter for a person', async () => {
    const io = new FakeTracker('bot', [fakeIssue(71, { labels: [{ name: 'needs-human' }] })]);
    const { outcome, lines } = await run(io, 71);
    expect(outcome).toBeNull();
    expect(lines.some((l) => l.startsWith('#71  not resuming: '))).toBe(true);
    expect(io.view(71)?.labels.map((l) => l.name)).toContain('loop/dlq: work');
    expect(io.view(71)?.comments.some((c) => c.body.includes('carve-claim'))).toBe(false);
  });
  it("another run's live claim starts nothing and parks nothing", async () => {
    const io = new FakeTracker('bot', [fakeIssue(72)]);
    io.comment(72, 'bot', claimMarker('working', 'elsewhere', '2026-11-01T00:00:00Z', '2999-01-01T00:00:00Z', 'tok'));
    const { outcome, lines } = await run(io, 72);
    expect(outcome).toBeNull();
    expect(lines.some((l) => l.startsWith('#72  not resuming: '))).toBe(true);
    expect(io.view(72)?.labels.map((l) => l.name)).toEqual([]);
  });
});

describe('findStranded judges a lane before resuming it', () => {
  const trackers = new Map<number, FakeTracker>();
  const stranded = (n: number) => {
    const dir = lane(n);
    writeFileSync(join(dir, 'loop-proof.json'), JSON.stringify({ issue: n, verdict: 'proved', reason: 'shown', pr: 9, branch: `fix/resume-${n}` }));
    return dir;
  };
  const find = (n: number, thread: string[] = []) => {
    const io = new FakeTracker('bot', [fakeIssue(n)]);
    for (const body of thread) io.comment(n, 'bot', body);
    trackers.set(n, io);
    const lines: string[] = [];
    const context = { ...ctx(), io, runId: 'starting-run', botLogin: 'bot', dryRun: false, knobs: { maxReviewRounds: 3 }, log: (m: string) => lines.push(m) } as unknown as Context;
    const original = Bun.spawnSync;
    const spy = spyOn(Bun, 'spawnSync').mockImplementation(((args: string[], opts: unknown) => {
      if (args[0] === 'gh' && args[1] === 'pr') return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ state: 'OPEN', headRefOid: head })), stderr: Buffer.from('') };
      if (args[0] === 'gh') return { exitCode: 0, stdout: Buffer.from('OPEN'), stderr: Buffer.from('') };
      return original(args, opts as any);
    }) as typeof Bun.spawnSync);
    try {
      return { found: findStranded(context, [{ number: n, title: 't', createdAt: '2026-09-01T00:00:00Z', labels: [] }], []), lines };
    } finally { spy.mockRestore(); }
  };
  it('resumes a clean lane at the pull request head', () => {
    stranded(81);
    expect(find(81).found.map((s) => s.issue.number)).toEqual([81]);
  });
  it('leaves a lane holding uncommitted work for a person: a resume would review a tree that is not what would merge', () => {
    const dir = stranded(82);
    writeFileSync(join(dir, 'unfinished.txt'), 'work');
    const { found, lines } = find(82);
    expect(found).toEqual([]);
    expect(lines.some((l) => l.startsWith('#82  stranded worktree holds uncommitted work'))).toBe(true);
    expect(trackers.get(82)?.view(82)?.labels.map((l) => l.name)).toContain('loop/dlq: work');
    expect(trackers.get(82)?.view(82)?.comments.at(-1)?.body).toContain('unfinished.txt');
  });
  it("leaves a lane the loop's hold kept to the pickup, with no dead letter", () => {
    const dir = lane(83);
    writeFileSync(join(dir, 'unfinished.txt'), 'the coder\'s own work');
    const { found, lines } = find(83, [stopComment('outside', { cause: 'needs-person', seat: 'coder' }, 'needs a credential')]);
    expect(found).toEqual([]);
    expect(lines.some((l) => l.includes("#83  stranded worktree is kept by the loop's hold"))).toBe(true);
    expect(trackers.get(83)?.view(83)?.labels.map((l) => l.name)).not.toContain('loop/dlq: work');
  });
});

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PIPELINE_DEFAULTS } from './config.ts';
import type { Context } from './context.ts';
import { claimHolder, findStranded, judgeLane, parkForInspection } from './resume.ts';
import { VERDICT_FILE } from './agent.ts';
import type { Issue } from './pipeline.ts';
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

describe('findStranded', () => {
  let nextIssue = 100;
  function setup(usable = false) {
    const number = nextIssue++;
    const dir = lane(number);
    git(dir, 'push', '-q', 'origin', 'HEAD');
    if (usable) writeFileSync(join(dir, VERDICT_FILE), JSON.stringify({ issue: number, verdict: 'fixed', pr: number + 1000, reason: 'done' }));
    const io = new FakeTracker('bot', [fakeIssue(number)]);
    const logs: string[] = [];
    const context = { ...ctx(), io, runId: 'this-run', botLogin: 'bot', knobs: { ...PIPELINE_DEFAULTS, maxReviewRounds: 3 }, log: (s: string) => logs.push(s) } as Context;
    const issue = { number, labels: [], title: 'issue', body: '', createdAt: '2026-09-01T00:00:00Z' } as Issue;
    return { number, dir, io, logs, context, issue };
  }
  function reads<T>(run: () => T, reply: (args: string[]) => unknown) {
    const before = git(repo, 'ls-remote', 'origin');
    const original = Bun.spawnSync;
    const spy = spyOn(Bun, 'spawnSync').mockImplementation(((args: string[], opts: unknown) => {
      if (args[0] !== 'gh') return original(args, opts as any);
      const value = args[1] === 'issue' ? 'OPEN' : reply(args);
      return { exitCode: 0, stdout: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), stderr: Buffer.from('') };
    }) as typeof Bun.spawnSync);
    try { return run(); } finally {
      spy.mockRestore();
      expect(git(repo, 'ls-remote', 'origin')).toBe(before);
    }
  }
  const pull = (number: number, oid = head) => ({ body: `Fixes #${number}`, title: '', headRefName: 'fix/work', headRefOid: oid });
  function parked(s: ReturnType<typeof setup>, reason: string) {
    expect(s.io.view(s.number)?.labels.map(l => l.name)).toContain('loop/dlq: work');
    expect(s.io.view(s.number)?.comments.at(-1)?.body).toContain(reason);
  }

  for (const usable of [false, true]) {
    for (const dirty of [false, true]) {
      for (const offHead of [false, true]) {
        it(`judges usable=${usable}, dirty=${dirty}, offHead=${offHead} without pushing`, () => {
          const s = setup(usable);
          if (offHead) {
            writeFileSync(join(s.dir, 'revision.txt'), 'revision');
            git(s.dir, 'add', 'revision.txt');
            git(s.dir, 'commit', '-q', '-m', 'revision');
          }
          const localHead = git(s.dir, 'rev-parse', 'HEAD');
          if (dirty) writeFileSync(join(s.dir, 'unfinished.txt'), 'work');
          let calls = 0;
          const found = reads(() => findStranded(s.context, [s.issue], []), () => {
            calls++;
            return usable ? { state: 'OPEN', headRefOid: head } : [pull(s.number)];
          });
          if (usable && !offHead) {
            expect(found.map(f => f.issue.number)).toEqual([s.number]);
            expect(s.io.writes).toEqual([]);
          } else {
            expect(found).toEqual([]);
            if (dirty && !usable) parked(s, 'unfinished.txt');
            else if (offHead) { parked(s, localHead); parked(s, head); }
            else parked(s, `An earlier run died with this issue's lane at ${s.dir} and left no usable verdict. A person inspects the lane and the pull request, if any.`);
          }
          expect(calls).toBe(dirty && !usable ? 0 : 1);
        });
      }
    }

    for (const dirty of usable ? [false, true] : [false]) {
      it(`isolates failed reads and retries next walk, usable=${usable}, dirty=${dirty}`, () => {
        const s = setup(usable);
        const next = setup(true);
        s.io.issues.set(next.number, fakeIssue(next.number));
        if (dirty) writeFileSync(join(s.dir, 'unfinished.txt'), 'work');
        let attempts = 0;
        reads(() => {
          expect(findStranded(s.context, [s.issue, next.issue], []).map(f => f.issue.number)).toEqual([next.number]);
          expect(s.io.writes).toEqual([]);
          expect(findStranded(s.context, [s.issue], [])).toEqual([]);
          expect(attempts).toBe(2);
        }, args => {
          if (args[2] === 'view' && args[3] === String(next.number + 1000)) return { state: 'OPEN', headRefOid: head };
          attempts++;
          throw new Error('tracker offline');
        });
        expect(s.logs.join('\n')).toContain('tracker offline');
      });
    }

    it(`isolates a failed dead-letter write, usable=${usable}`, () => {
      const s = setup(usable);
      const next = setup(true);
      s.io.issues.set(next.number, fakeIssue(next.number));
      s.io.throwOn = /./;
      reads(() => {
        expect(findStranded(s.context, [s.issue, next.issue], []).map(f => f.issue.number)).toEqual([next.number]);
        expect(s.logs.join('\n')).toContain('could not record the dead letter');
        expect(findStranded(s.context, [s.issue], [])).toEqual([]);
        parked(s, head);
      }, args => args[2] === 'list' ? [pull(s.number, 'other-head')] : { state: 'OPEN', headRefOid: args[3] === String(next.number + 1000) ? head : 'other-head' });
    });

    for (const claim of ['live', 'unreadable', 'stop']) {
      it(`leaves a ${claim} claim untouched, usable=${usable}`, () => {
        const s = setup(usable);
        if (claim === 'live') s.io.comment(s.number, 'bot', '<!-- carve-claim kind=working run=other-run at=2026-09-03T12:00:00Z expires=2999-01-01T00:00:00Z -->');
        const prior = s.io.writes.length;
        const stop = new RunStopping('stop');
        const view = claim === 'live' ? null : spyOn(s.io, 'view').mockImplementation(() => { throw claim === 'stop' ? stop : new Error('claim offline'); });
        try {
          reads(() => {
            if (claim === 'stop') expect(() => findStranded(s.context, [s.issue], [])).toThrow(stop);
            else expect(findStranded(s.context, [s.issue], [])).toEqual([]);
            expect(s.io.writes.length).toBe(prior);
          }, () => { throw new Error('must not read PR'); });
        } finally { view?.mockRestore(); }
      });
    }

    for (const dirty of usable ? [false, true] : [false]) {
      it(`propagates a stopped PR read, usable=${usable}, dirty=${dirty}`, () => {
        const s = setup(usable);
        if (dirty) writeFileSync(join(s.dir, 'unfinished.txt'), 'work');
        const stop = new RunStopping('stop');
        reads(() => {
          expect(() => findStranded(s.context, [s.issue], [])).toThrow(stop);
          expect(s.io.writes).toEqual([]);
        }, () => { throw stop; });
      });
    }
  }

  it('lists once per walk and picks the first owning PR, ignoring passing mentions', () => {
    const s = setup();
    const next = setup();
    s.io.issues.set(next.number, fakeIssue(next.number));
    let calls = 0;
    reads(() => {
      expect(findStranded(s.context, [s.issue, next.issue], [])).toEqual([]);
      expect(calls).toBe(1);
      parked(s, 'left no usable verdict');
    }, () => {
      calls++;
      return [{ ...pull(s.number, 'wrong'), body: `mentions #${s.number}` }, pull(s.number), pull(s.number, 'older-head'), pull(next.number)];
    });
  });

  it('caches a failed list only for this walk', () => {
    const s = setup();
    const next = setup();
    s.io.issues.set(next.number, fakeIssue(next.number));
    let calls = 0;
    reads(() => {
      for (let i = 0; i < 2; i++) expect(findStranded(s.context, [s.issue, next.issue], [])).toEqual([]);
      expect(calls).toBe(2);
      expect(s.io.writes).toEqual([]);
    }, () => { calls++; throw new Error('offline'); });
  });

  it('keeps the old park for no PR and a listed lane whose directory is gone', () => {
    for (const missing of [false, true]) {
      const s = setup();
      if (missing) rmSync(s.dir, { recursive: true });
      reads(() => {
        expect(findStranded(s.context, [s.issue], [])).toEqual([]);
        parked(s, 'left no usable verdict');
      }, () => { if (missing) throw new Error('must not read'); return []; });
    }
  });

  it('leaves a mismatched verdict and a closed PR alone', () => {
    const s = setup(true);
    writeFileSync(join(s.dir, VERDICT_FILE), JSON.stringify({ issue: -1, verdict: 'fixed', pr: 1 }));
    reads(() => {
      expect(findStranded(s.context, [s.issue], [])).toEqual([]);
      expect(s.logs.join('\n')).toContain('stranded verdict names issue -1');
      expect(s.io.writes).toEqual([]);
    }, () => { throw new Error('must not read'); });
    for (const dirty of [false, true]) {
      const closed = setup(true);
      if (dirty) writeFileSync(join(closed.dir, 'unfinished.txt'), 'work');
      reads(() => {
        expect(findStranded(closed.context, [closed.issue], [])).toEqual([]);
        expect(closed.io.writes).toEqual([]);
      }, () => ({ state: 'CLOSED', headRefOid: 'old-head' }));
    }
  });
});

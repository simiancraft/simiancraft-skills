import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ClaimHandle, keepClaimed, LeaseLostError, leaseLost } from '../../carve-github-issue/lib/claims.ts';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import { children, DRIVER_GRACE_MS, killAgent, runAgent, shutdownAgents } from './agent.ts';
import type { ProjectConfig } from './config.ts';
import { type Context, createContext } from './context.ts';
import { fixIssue, move } from './pipeline.ts';
import { pool } from './pool.ts';
import { beginStop, finishDespiteStop, isStopping, mutate, resetStop, RunStopping, stoppableSleep } from './shell.ts';

const HERE = import.meta.dir;
let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'stopping-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
// The stop is process-wide, like the signal, so every case ends by lifting it.
afterEach(resetStop);

const PROJECT = { name: 'Test', repo: 'o/stop', remote: 'origin', baseBranch: 'main', evidenceBranch: 'evidence', checkCommand: 'true', installCommand: 'true', conventionDocs: [], sizingScale: 'fib', sharedServices: [], portBase: 9000, portSpan: 10, pathAliases: [], sourceExtensions: ['.ts'], alwaysInvalidates: [], touchPaths: { migration: [], ci: [] }, worktreeRoot: 'wt' } as ProjectConfig;

function context(io: FakeTracker, dryRun: boolean, log: (m: string) => void = () => {}): Context {
  return createContext({
    project: PROJECT,
    knobs: { autoMerge: 'never', maxReviewRounds: 3, checksTimeoutMinutes: 1, smokeTimeoutMinutes: 1 },
    seats: { worker: { engine: 'fixture', model: join(scratch, 'verdict.json') }, reviewer: { engine: 'fixture2' } },
    repoRoot: scratch,
    invokeRoot: scratch,
    promptsDirs: [join(HERE, '..', 'prompts')],
    dryRun,
    runDir: join(scratch, 'runs'),
    botLogin: 'loop-bot',
    io,
    log,
    step: () => {},
  });
}

describe('a stopping run', () => {
  it('begins its stop before shutdownAgents awaits anything', () => {
    const pending = shutdownAgents(0);
    expect(isStopping()).toBe(true);
    return pending;
  });

  it('writes nothing to the tracker but a release', () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(1)]);
    const ctx = context(io, false);
    beginStop();
    expect(() => mutate(ctx, 'label #1 loop/attempts: 1', ['gh', 'issue', 'edit', '1', '--add-label', 'loop/attempts: 1'])).toThrow(RunStopping);
    expect(io.writes).toEqual([]);
    mutate(ctx, 'unclaim #1', ['gh', 'issue', 'comment', '1', '--body', 'released'], { whileStopping: true });
    expect(io.writes.map((w) => w.description)).toEqual(['unclaim #1']);
  });

  it('lets the lane whose merge is confirmed finish its record, and no other lane beside it', async () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(1), fakeIssue(2)]);
    const ctx = context(io, false);
    beginStop();
    let refusedBeside = false;
    const finishing = finishDespiteStop(async () => {
      mutate(ctx, 'close #1 after its merge', ['gh', 'issue', 'comment', '1', '--body', 'Closed by #9.']);
      await new Promise((resolve) => setTimeout(resolve, 5));
      mutate(ctx, 'note the merge on #1', ['gh', 'issue', 'comment', '1', '--body', 'merged']);
    });
    // Another lane, begun outside and unwinding while that record is still being written.
    const beside = Promise.resolve()
      .then(() => mutate(ctx, 'count a failure on #2', ['gh', 'issue', 'comment', '2', '--body', 'x']))
      .catch((error) => {
        refusedBeside = error instanceof RunStopping;
      });
    await Promise.all([finishing, beside]);
    expect(refusedBeside).toBe(true);
    expect(io.writes.map((w) => w.description)).toEqual(['close #1 after its merge', 'note the merge on #1']);
  });

  it('refuses a dry-run rehearsal of a write too, so a stop reads the same in both modes', () => {
    const ctx = context(new FakeTracker('loop-bot', [fakeIssue(1)]), true);
    beginStop();
    expect(() => mutate(ctx, 'anything', ['gh', 'issue', 'edit', '1'])).toThrow(RunStopping);
    expect(ctx.dryRunLog).toEqual([]);
  });

  it('ends a wait within a second, however long the wait was to be', async () => {
    let slept = 0;
    const sleep = async (ms: number) => {
      slept += ms;
      if (slept >= 3000) beginStop();
    };
    await expect(stoppableSleep(60_000, sleep)).rejects.toThrow(RunStopping);
    expect(slept).toBe(3000);
    resetStop();
    slept = 0;
    await stoppableSleep(2500, sleep);
    expect(slept).toBe(2500);
  });

  it('dispatches nothing new from the pool once the stop has begun', async () => {
    const started: number[] = [];
    await pool([1, 2, 3, 4], 1, async (n) => {
      started.push(n);
      if (n === 2) beginStop();
    });
    expect(started).toEqual([1, 2]);
  });

  it('does not report an item the stop unwound as an error', async () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      await pool([1], 1, async () => {
        throw new RunStopping('stopped');
      });
    } finally {
      console.error = original;
    }
    expect(errors).toEqual([]);
  });

  it('starts no agent: the seat is never run, not run and then discarded', async () => {
    const lines: string[] = [];
    const ctx = context(new FakeTracker('loop-bot', []), false, (m) => lines.push(m));
    beginStop();
    await expect(runAgent(ctx, 'worker', 1, join(scratch, 'wt', 'issue-1'), { engine: 'fixture', model: 'unused' }, 'prompt')).rejects.toThrow(/not started/);
    expect(lines).toEqual([]);
  });

  it('settles a lane whose worker ended under the stop as stopped: no failure, no attempt, no Ready card', async () => {
    // The worker would have answered `failed`, which a run that is not stopping counts.
    writeFileSync(join(scratch, 'verdict.json'), JSON.stringify({ issue: 7, verdict: 'failed', reason: 'could not reproduce' }));
    const io = new FakeTracker('loop-bot', [fakeIssue(7, { labels: [{ name: 'size: 1' }] })]);
    const lines: string[] = [];
    const lanes: string[] = [];
    const ctx = context(io, true, (m) => {
      lines.push(m);
      if (/running worker/.test(m)) beginStop();
    });
    ctx.onLane = (e) => lanes.push(e.lane);
    const outcome = await fixIssue(ctx, { number: 7, title: 't', createdAt: '2026-09-01T00:00:00Z', labels: [{ name: 'size: 1' }] }, { maxPoints: 2 });
    expect(outcome.outcome).toBe('stopped');
    expect(lines.some((l) => /was stopped with the run/.test(l))).toBe(true);
    expect(lines.filter((l) => /attempt \d+ of \d+ failed|worker failed/.test(l))).toEqual([]);
    expect(ctx.dryRunLog.filter((d) => /loop\/attempts/.test(d))).toEqual([]);
    expect(lanes).toEqual(['D1']);
  });
});

describe('a lane that lost its lease', () => {
  it('starts no agent and moves no card: a retry after a backoff would otherwise run unowned', async () => {
    const lines: string[] = [];
    const cards: string[] = [];
    const ctx = context(new FakeTracker('loop-bot', [fakeIssue(9)]), false, (m) => lines.push(m));
    ctx.onLane = (e) => cards.push(e.lane);
    const handle: ClaimHandle = { kind: 'working', commentId: 1, label: 'loop/working', issue: 9, key: 'o/stop#9', expires: () => 0, renew: () => { throw new Error('tracker down'); }, release: () => {} };
    const stop = keepClaimed(handle, undefined, () => 0, (fn) => (fn(), () => {}));
    await expect(runAgent(ctx, 'worker', 9, join(scratch, 'wt', 'issue-9'), { engine: 'fixture', model: 'unused' }, 'prompt')).rejects.toThrow(LeaseLostError);
    move(ctx, { number: 9, title: 't', createdAt: '2026-09-01T00:00:00Z', labels: [] }, 'F3', 'PR #1');
    expect(lines).toEqual([]);
    expect(cards).toEqual([]);
    // Once that lease's holder has stopped, the issue is this run's to work again.
    stop();
    move(ctx, { number: 9, title: 't', createdAt: '2026-09-01T00:00:00Z', labels: [] }, 'D1');
    expect(cards).toEqual(['D1']);
  });

  it('settles nothing from the worker its lost lease killed: no attempt counted, no Ready card, and an outcome no driver places a card for', async () => {
    writeFileSync(join(scratch, 'verdict.json'), JSON.stringify({ issue: 8, verdict: 'failed', reason: 'killed mid-change' }));
    const io = new FakeTracker('loop-bot', [fakeIssue(8, { labels: [{ name: 'size: 1' }] })]);
    const lines: string[] = [];
    const lanes: string[] = [];
    const ctx = context(io, true, (m) => {
      lines.push(m);
      // Lost the way it is in a run: a renewal fails with the expiry already past, while the worker runs.
      if (!/running worker/.test(m) || leaseLost(ctx, 8)) return;
      const handle: ClaimHandle = { kind: 'working', commentId: 1, label: 'loop/working', issue: 8, key: 'o/stop#8', expires: () => 0, renew: () => { throw new Error('tracker down'); }, release: () => {} };
      keepClaimed(handle, undefined, () => 0, (fn) => (fn(), () => {}));
    });
    ctx.onLane = (e) => lanes.push(e.lane);
    const outcome = await fixIssue(ctx, { number: 8, title: 't', createdAt: '2026-09-01T00:00:00Z', labels: [{ name: 'size: 1' }] }, { maxPoints: 2 });
    expect(outcome).toEqual({ outcome: 'lease-lost', reason: 'this run lost its lease on the issue' });
    expect(lines.filter((l) => /attempt \d+ of \d+ failed|worker failed/.test(l))).toEqual([]);
    expect(ctx.dryRunLog.filter((d) => /loop\/attempts/.test(d))).toEqual([]);
    expect(lanes).toEqual(['D1']);
  });
});

describe('a stop and a child that is itself a driver', () => {
  /**
   * A child that traps the signal and takes time to leave, as a driver does while it kills its own
   * agent and releases its claims. It writes a file when it gets there, so the test asks the thing
   * that matters: did the stop wait for that, or cut it off?
   */
  const lingering = async (ms: number, ownDriver: boolean) => {
    const tag = Math.random().toString(36).slice(2);
    const ready = join(scratch, `ready-${tag}`);
    const done = join(scratch, `finished-${tag}`);
    const proc = Bun.spawn(['sh', '-c', `trap 'sleep ${ms / 1000}; : > ${done}; exit 0' TERM; : > ${ready}; while :; do sleep 0.05; done`], { stdout: 'ignore', stderr: 'ignore' });
    children.add(ownDriver ? Object.assign(proc, { ownDriver: true as const }) : proc);
    // A signal that arrives before the shell has installed its trap kills it outright, which is a
    // race in the test and not in a driver that has been running for minutes.
    while (!existsSync(ready)) await Bun.sleep(10);
    return { proc, finished: () => existsSync(done) };
  };

  it("waits for it well past an agent's grace, so its own claims are released", async () => {
    const driver = await lingering(1200, true);
    const started = Date.now();
    await shutdownAgents(300);
    expect(driver.finished()).toBe(true);
    expect(Date.now() - started).toBeGreaterThan(1000);
    expect(DRIVER_GRACE_MS).toBeGreaterThanOrEqual(60_000);
  }, 20_000);

  it('escalates to SIGKILL on the grace it was given, not on a fixed ten seconds', async () => {
    // The conflict this guards: a driver given a minute to unwind, with a kill timer set at ten
    // seconds, is cut off in the middle of releasing its claims.
    const short = await lingering(30_000, false);
    killAgent(short.proc, 200);
    const died = await Promise.race([short.proc.exited.then(() => 'exited'), Bun.sleep(3000).then(() => 'alive')]);
    expect(died).toBe('exited');
    expect(short.proc.signalCode).toBe('SIGKILL');
    children.delete(short.proc);

    const patient = await lingering(1200, false);
    killAgent(patient.proc, 30_000);
    await patient.proc.exited;
    expect(patient.finished()).toBe(true);
    children.delete(patient.proc);
  }, 20_000);

  it("still takes an agent down at the agent's pace, which is the shorter one", async () => {
    const agent = await lingering(5000, false);
    const started = Date.now();
    await shutdownAgents(300);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(agent.finished()).toBe(false);
  }, 20_000);
});

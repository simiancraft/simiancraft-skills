import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import { runAgent, shutdownAgents } from './agent.ts';
import type { ProjectConfig } from './config.ts';
import { type Context, createContext } from './context.ts';
import { fixIssue } from './pipeline.ts';
import { pool } from './pool.ts';
import { beginStop, isStopping, mutate, resetStop, RunStopping, stoppableSleep } from './shell.ts';

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

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import type { ProjectConfig } from './config.ts';
import { createContext } from './context.ts';
import type { Seat } from './engines.ts';
import { fixIssue } from './pipeline.ts';

const BOT = 'loop-bot';
const HERE = import.meta.dir;
let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dry-run-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const PROJECT: ProjectConfig = {
  name: 'Test',
  repo: 'o/r',
  remote: 'origin',
  baseBranch: 'main',
  evidenceBranch: 'evidence',
  checkCommand: 'true',
  installCommand: 'true',
  conventionDocs: [],
  sizingScale: 'fib',
  sharedServices: [],
  portBase: 9000,
  portSpan: 10,
  pathAliases: [],
  sourceExtensions: ['.ts'],
  alwaysInvalidates: [],
  touchPaths: { migration: [], ci: [] },
  worktreeRoot: 'wt',
};

const issue7 = { number: 7, title: '[t] small', createdAt: '2026-09-01T00:00:00Z', labels: [{ name: 'size: 1' }] };

/** A dry run of fixIssue on one clean leaf, with everything it said, rehearsed, and placed. */
async function dryRun(worker: Seat) {
  const io = new FakeTracker(BOT, [fakeIssue(7, { title: issue7.title, labels: issue7.labels })]);
  const lines: string[] = [];
  const lanes: string[] = [];
  const ctx = createContext({
    project: PROJECT,
    knobs: { autoMerge: 'never', maxReviewRounds: 3, checksTimeoutMinutes: 1, smokeTimeoutMinutes: 1 },
    seats: { worker, reviewer: { engine: 'fixture2' } },
    repoRoot: scratch,
    invokeRoot: scratch,
    promptsDirs: [join(HERE, '..', 'prompts')],
    dryRun: true,
    runDir: join(scratch, 'runs'),
    botLogin: BOT,
    io,
    log: (m) => lines.push(m),
    step: () => {},
  });
  ctx.onLane = (e) => lanes.push(e.lane);
  const outcome = await fixIssue(ctx, issue7, { maxPoints: 2 });
  return { outcome, lines, lanes, rehearsed: ctx.dryRunLog, writes: io.writes };
}

describe('a dry run and the worker seat', () => {
  it('reports a seat it does not run as not run: no failure, no attempt counted, no Ready card', async () => {
    // A verdict left in the lane by an earlier run is not this run's answer.
    mkdirSync(join(scratch, 'wt', 'issue-7'), { recursive: true });
    writeFileSync(join(scratch, 'wt', 'issue-7', 'loop-verdict.json'), JSON.stringify({ issue: 7, verdict: 'failed', reason: 'stale' }));
    const run = await dryRun({ engine: 'claude', model: 'any' });
    expect(run.outcome).toEqual({ outcome: 'not-run', reason: 'dry run: the worker was not run' });
    expect(run.lines.some((l) => /DRY RUN {2}would run worker/.test(l))).toBe(true);
    expect(run.lines.filter((l) => /failed/.test(l))).toEqual([]);
    expect(run.rehearsed.filter((d) => /loop\/attempts/.test(d))).toEqual([]);
    expect(run.lanes).toEqual(['D1']);
    expect(run.writes).toEqual([]);
  });

  it('still runs a fixture seat, and a failure that seat reports is counted as before', async () => {
    const answer = join(scratch, 'failed-verdict.json');
    writeFileSync(answer, JSON.stringify({ issue: 7, verdict: 'failed', reason: 'could not reproduce' }));
    const run = await dryRun({ engine: 'fixture', model: answer });
    expect(run.outcome.outcome).toBe('failed');
    expect(run.lines.some((l) => /attempt 1 of \d+ failed/.test(l))).toBe(true);
    expect(run.rehearsed.some((d) => /loop\/attempts: 1/.test(d))).toBe(true);
    expect(run.lanes).toEqual(['D1', 'B1']);
    expect(run.writes).toEqual([]);
  });
});

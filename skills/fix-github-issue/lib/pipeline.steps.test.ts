import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import type { ProjectConfig } from './config.ts';
import { createContext } from './context.ts';
import { fixIssue } from './pipeline.ts';
import { newestStep } from './steps.ts';

const BOT = 'loop-bot';
const HERE = import.meta.dir;
const S = 'c'.repeat(40);
let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'steps-'));
  // The pipeline removes its worktree when a lane settles, which asks git about the repository.
  Bun.spawnSync(['git', 'init', '-q', scratch]);
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const PROJECT = { name: 'Test', repo: 'o/steps', remote: 'origin', baseBranch: 'main', evidenceBranch: 'evidence', checkCommand: 'true', installCommand: 'true', conventionDocs: [], sizingScale: 'fib', sharedServices: [], portBase: 9000, portSpan: 10, pathAliases: [], sourceExtensions: ['.ts'], alwaysInvalidates: [], touchPaths: { migration: [], ci: [] }, worktreeRoot: 'wt' } as ProjectConfig;

const coded = (issue: number) => ({ issue, verdict: 'coded', reason: 'done', branch: `fix/x-${issue}`, sha: S, gated: S, handoff: 'Changed the parser. Exercise: bun test parser.', touches: ['code'] });

/** A dry run of one issue with a fixture worker seat that answers as a coder, and as a prover. */
async function run(issue: number, coder: unknown, prover: unknown) {
  const answer = join(scratch, `answer-${issue}.json`);
  writeFileSync(answer, JSON.stringify(coder));
  writeFileSync(`${answer}.prover`, JSON.stringify(prover));
  const io = new FakeTracker(BOT, [fakeIssue(issue, { labels: [{ name: 'size: 1' }] })]);
  const lines: string[] = [];
  const lanes: string[] = [];
  const ctx = createContext({
    project: PROJECT,
    knobs: { autoMerge: 'never', maxReviewRounds: 3, checksTimeoutMinutes: 1, smokeTimeoutMinutes: 1 },
    seats: { worker: { engine: 'fixture', model: answer }, reviewer: { engine: 'fixture2' } },
    repoRoot: scratch,
    invokeRoot: scratch,
    promptsDirs: [join(HERE, '..', 'prompts')],
    dryRun: true,
    runDir: join(scratch, `runs-${issue}`),
    botLogin: BOT,
    io,
    log: (m) => lines.push(m),
    step: () => {},
  });
  ctx.onLane = (e) => lanes.push(e.lane);
  const outcome = await fixIssue(ctx, { number: issue, title: 't', createdAt: '2026-09-01T00:00:00Z', labels: [{ name: 'size: 1' }] }, { maxPoints: 2 });
  return { outcome, lines, lanes, rehearsed: ctx.dryRunLog, roles: lines.filter((l) => /^ {2}running /.test(l)).map((l) => /running (\S+)/.exec(l)?.[1]) };
}

describe('the work turn, as steps', () => {
  it('runs Code, announces the coded head on the issue, then runs Prove on a fresh agent', async () => {
    const r = await run(21, coded(21), { issue: 21, verdict: 'needs-human', reason: 'proof needs a production account' });
    expect(r.roles).toEqual(['worker', 'prover']);
    expect(r.lanes.slice(0, 2)).toEqual(['D1', 'D2']);
    expect(r.rehearsed.some((d) => /^announce coded at c{10} on #21$/.test(d))).toBe(true);
    // Announced before the prover started: the step ended at a durable fact.
    const announced = r.lines.findIndex((l) => l.includes('announce coded'));
    const proving = r.lines.findIndex((l) => l.includes('running prover'));
    expect(announced).toBeGreaterThan(-1);
    expect(announced).toBeLessThan(proving);
    expect(r.outcome.outcome).toBe('handed-off');
  });

  it('stops at Code when the coder takes an escape, and never proves', async () => {
    const r = await run(22, { issue: 22, verdict: 'needs-decision', reason: 'which currency?' }, { issue: 22, verdict: 'fixed', reason: 'x', pr: 1, branch: 'b' });
    expect(r.roles).toEqual(['worker']);
    expect(r.outcome.outcome).toBe('handed-off');
  });

  it('refuses a coder that calls it fixed: opening the pull request is not its step', async () => {
    const r = await run(23, { issue: 23, verdict: 'fixed', reason: 'done', pr: 9, branch: 'b' }, {});
    expect(r.roles).toEqual(['worker']);
    expect(r.outcome.outcome).toBe('failed');
    expect(r.outcome.reason).toContain("verdict 'fixed' is not one the driver knows for this step");
  });

  it('refuses a coded verdict that leaves the prover nothing to start from', async () => {
    const r = await run(24, { ...coded(24), handoff: ' ' }, {});
    expect(r.roles).toEqual(['worker']);
    expect(r.outcome.reason).toContain('coded without');
    expect(r.rehearsed.some((d) => d.startsWith('announce coded'))).toBe(false);
  });

  it("sends a refused proof back a step: an attempt is spent, and the prover's reason is the next coder's brief", async () => {
    const r = await run(25, coded(25), { issue: 25, verdict: 'unprovable', reason: 'the endpoint still returns 500 for an empty list' });
    // Code, Prove (refused), Code again, Prove (refused)... until the attempts are spent.
    expect(r.roles.slice(0, 4)).toEqual(['worker', 'prover', 'worker', 'prover']);
    expect(r.rehearsed.filter((d) => /loop\/attempts: \d/.test(d) && d.startsWith('mark')).length).toBeGreaterThanOrEqual(2);
    expect(r.lines.some((l) => /the proof was refused \(attempt 1 of \d+\)/.test(l))).toBe(true);
    expect(r.outcome.outcome).toBe('dlq');
    expect(r.outcome.reason).toContain('the endpoint still returns 500 for an empty list');
  });
});

describe('what Prove is handed', () => {
  it('is read from the marker on the issue, never from the run that coded it', () => {
    const io = new FakeTracker(BOT, [fakeIssue(30)]);
    io.comment(30, BOT, `<!-- loop-step step=coded run=other-host-9-9 sha=${S} gated=${S} touches=code -->\nExercise: bun test parser.`);
    expect(newestStep(io.view(30)!.comments, BOT)).toMatchObject({ runId: 'other-host-9-9', gated: S, handoff: 'Exercise: bun test parser.' });
  });
});

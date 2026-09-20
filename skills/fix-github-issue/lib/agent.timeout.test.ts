import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import { AGENT_TIMEOUT_MS, agentTimeout, runAgent, TIMED_OUT_EXIT } from './agent.ts';
import type { ProjectConfig } from './config.ts';
import { createContext } from './context.ts';
import { VERDICT_FILE } from './control-files.ts';
import { fixIssue } from './pipeline.ts';

const HERE = import.meta.dir;
let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'timeout-'));
  // The fixture writes its answer, hangs, and exits 0 when killed: an engine that traps SIGTERM.
  process.env.LOOP_FIXTURE_LINGER_MS = '60000';
  agentTimeout.ms = 400;
});
afterAll(() => {
  // Both are process-wide, and other test files run in this process after this one.
  agentTimeout.ms = AGENT_TIMEOUT_MS;
  delete process.env.LOOP_FIXTURE_LINGER_MS;
  rmSync(scratch, { recursive: true, force: true });
});

const PROJECT = { name: 'Test', repo: 'o/cap', remote: 'origin', baseBranch: 'main', evidenceBranch: 'evidence', checkCommand: 'true', installCommand: 'true', conventionDocs: [], sizingScale: 'fib', sharedServices: [], portBase: 9000, portSpan: 10, pathAliases: [], sourceExtensions: ['.ts'], alwaysInvalidates: [], touchPaths: { migration: [], ci: [] }, worktreeRoot: 'wt' } as ProjectConfig;

function context(lines: string[], dryRun: boolean) {
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
    io: new FakeTracker('loop-bot', [fakeIssue(7, { labels: [{ name: 'size: 1' }] })]),
    log: (m) => lines.push(m),
    step: () => {},
  });
}

describe('an agent killed at the cap', () => {
  it('is marked timed out and never given exit 0, though the engine exited 0 with an answer on disk', async () => {
    writeFileSync(join(scratch, 'verdict.json'), JSON.stringify({ issue: 7, verdict: 'fixed', reason: 'done', pr: 1, branch: 'fix/x' }));
    const cwd = join(scratch, 'wt', 'issue-7');
    mkdirSync(cwd, { recursive: true });
    const lines: string[] = [];
    const run = await runAgent(context(lines, false), 'worker', 7, cwd, { engine: 'fixture', model: join(scratch, 'verdict.json') }, 'prompt');
    expect(run.timedOut).toBe(true);
    expect(run.exitCode).toBe(TIMED_OUT_EXIT);
    // The hazard itself: the answer was written before the kill, and the engine said 0.
    expect(existsSync(join(cwd, VERDICT_FILE))).toBe(true);
    expect(lines.some((l) => /timed out at .* minutes and was killed/.test(l))).toBe(true);
    // One attempt only: a run that spent the cap is not asked again.
    expect(lines.filter((l) => /running worker/.test(l))).toHaveLength(1);
  }, 20_000);

  it('settles as a failed attempt that says it timed out, not as the fixed verdict it left behind', async () => {
    writeFileSync(join(scratch, 'verdict.json'), JSON.stringify({ issue: 7, verdict: 'fixed', reason: 'done', pr: 1, branch: 'fix/x' }));
    const lines: string[] = [];
    const ctx = context(lines, true);
    const outcome = await fixIssue(ctx, { number: 7, title: 't', createdAt: '2026-09-01T00:00:00Z', labels: [{ name: 'size: 1' }] }, { maxPoints: 2 });
    expect(outcome.outcome).toBe('failed');
    expect(outcome.reason).toContain('worker timed out at');
    expect(lines.some((l) => /verdict: fixed/.test(l))).toBe(false);
  }, 20_000);

  it('keeps the answer of an agent that exited in time, though something it started held its output past the cap', async () => {
    const script = join(scratch, 'leaves-a-child.ts');
    writeFileSync(script, "Bun.spawn(['sleep', '5'], { stdout: 'inherit', stderr: 'inherit' }).unref(); process.exit(0);");
    const engines = (await import('./engines.ts')).ENGINES as Record<string, { command: (cwd: string, prompt: string, model?: string) => string[] }>;
    const original = engines.fixture.command;
    engines.fixture.command = () => ['bun', script];
    try {
      const cwd = join(scratch, 'wt', 'issue-8');
      mkdirSync(cwd, { recursive: true });
      const lines: string[] = [];
      const run = await runAgent(context(lines, false), 'worker', 8, cwd, { engine: 'fixture', model: 'unused' }, 'prompt');
      expect(run.exitCode).toBe(0);
      expect(run.timedOut).toBeUndefined();
      expect(lines.some((l) => /left a process holding its output/.test(l))).toBe(true);
    } finally {
      engines.fixture.command = original;
    }
  }, 20_000);

  it('keeps the shipped cap at forty-five minutes', () => {
    expect(AGENT_TIMEOUT_MS).toBe(45 * 60 * 1000);
  });
});

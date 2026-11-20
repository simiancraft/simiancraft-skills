import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import { AGENT_TIMEOUT_MS, agentTimeout, children, killAgentsOn, runAgent, stopSignalOf } from './agent.ts';
import type { ProjectConfig } from './config.ts';
import { createContext } from './context.ts';
import { VERDICT_FILE } from './control-files.ts';
import { ENGINES } from './engines.ts';
import { fixIssue } from './pipeline.ts';

let scratch: string;
const engines = ENGINES as Record<string, { command: (cwd: string, prompt: string, model?: string) => string[] }>;
const original = engines.fixture.command;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'outside-stop-'));
});
afterEach(() => {
  engines.fixture.command = original;
  agentTimeout.ms = AGENT_TIMEOUT_MS;
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PROJECT = { name: 'Test', repo: 'o/stop', remote: 'origin', baseBranch: 'main', evidenceBranch: 'evidence', checkCommand: 'true', installCommand: 'true', conventionDocs: [], sizingScale: 'fib', sharedServices: [], portBase: 9000, portSpan: 10, pathAliases: [], sourceExtensions: ['.ts'], alwaysInvalidates: [], touchPaths: { migration: [], ci: [] }, worktreeRoot: 'wt' } as ProjectConfig;

function context(lines: string[], dryRun: boolean) {
  return createContext({
    project: PROJECT,
    knobs: { autoMerge: 'never', maxReviewRounds: 3, checksTimeoutMinutes: 1, smokeTimeoutMinutes: 1 },
    seats: { worker: { engine: 'fixture', model: 'unused' }, reviewer: { engine: 'fixture2' } },
    repoRoot: scratch,
    invokeRoot: scratch,
    promptsDirs: [join(import.meta.dir, '..', 'prompts')],
    dryRun,
    runDir: join(scratch, 'runs'),
    botLogin: 'loop-bot',
    io: new FakeTracker('loop-bot', [fakeIssue(7, { labels: [{ name: 'size: 1' }] })]),
    log: (m) => lines.push(m),
    step: () => {},
  });
}

/**
 * Points the fixture engine at a script that leaves an answer in the lane, then ends as `ending` says.
 * `refused` prints an upstream refusal, so a run that is retried at all would be retried.
 */
function engineThat(name: string, ending: string, refused = false): void {
  const script = join(scratch, `${name}.ts`);
  writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(VERDICT_FILE)}, '{"verdict":"fixed"}'); ${refused ? "console.log('the model is overloaded');" : ''} ${ending}`);
  engines.fixture.command = () => ['bun', script];
}

async function runIn(issue: number, lines: string[] = []) {
  const cwd = join(scratch, 'wt', `issue-${issue}`);
  mkdirSync(cwd, { recursive: true });
  const run = await runAgent(context(lines, false), 'worker', issue, cwd, { engine: 'fixture', model: 'unused' }, 'prompt');
  return { run, cwd, lines };
}

describe('a stop signal the driver did not send', () => {
  it('is named on the run, its answer is removed, and it is not asked again', async () => {
    engineThat('dies-of-sigterm', "process.kill(process.pid, 'SIGTERM'); await Bun.sleep(5000);", true);
    const { run, cwd, lines } = await runIn(11);
    expect(run.fault).toEqual({ kind: 'stopped', signal: 'SIGTERM' });
    expect(run.exitCode).not.toBe(0);
    expect(existsSync(join(cwd, VERDICT_FILE))).toBe(false);
    expect(lines.filter((l) => /running worker/.test(l))).toHaveLength(1);
  }, 20_000);

  it('is read from the exit code of an engine that traps the signal, as `claude -p` exits 143 on SIGTERM', async () => {
    engineThat('exits-143', 'process.exit(143);');
    expect((await runIn(12)).run.fault).toEqual({ kind: 'stopped', signal: 'SIGTERM' });
  }, 20_000);

  it('is not a crash: a process that dies of SIGSEGV is an ordinary failed run', async () => {
    engines.fixture.command = () => ['sh', '-c', 'ulimit -c 0; kill -SEGV $$'];
    const { run } = await runIn(13);
    expect(run.fault).toBeUndefined();
    expect(run.exitCode).not.toBe(0);
  }, 20_000);

  it('is not the driver kill at the cap, though that kill is a SIGTERM too', async () => {
    agentTimeout.ms = 400;
    engines.fixture.command = () => ['sleep', '30'];
    const { run } = await runIn(14);
    expect(run.timedOut).toBe(true);
    expect(run.fault).toBeUndefined();
  }, 20_000);

  it('is not the driver kill of a lost lease', async () => {
    engines.fixture.command = () => ['sleep', '30'];
    const pending = runIn(15);
    while (![...children].some((proc) => proc.issue === 15)) await Bun.sleep(20);
    expect(killAgentsOn(PROJECT.repo, 15)).toBe(1);
    const { run } = await pending;
    expect(run.fault).toBeUndefined();
    expect(run.exitCode).toBe(143);
  }, 20_000);

  it('covers the signals a person stops a process with, and neither SIGKILL nor a crash', () => {
    expect(stopSignalOf('SIGINT', 130)).toBe('SIGINT');
    expect(stopSignalOf('SIGHUP', 129)).toBe('SIGHUP');
    expect(stopSignalOf(null, 130)).toBe('SIGINT');
    expect(stopSignalOf('SIGKILL', 137)).toBeNull();
    expect(stopSignalOf('SIGSEGV', 139)).toBeNull();
    expect(stopSignalOf(null, 137)).toBeNull();
    expect(stopSignalOf(null, 1)).toBeNull();
    expect(stopSignalOf(null, 0)).toBeNull();
  });
});

describe('a coder stopped from outside', () => {
  const issue = { number: 7, title: 't', createdAt: '2026-09-01T00:00:00Z', labels: [{ name: 'size: 1' }] };

  it('counts no attempt, writes no hold, and leaves the work to be rerun', async () => {
    engineThat('coder-stopped', "process.kill(process.pid, 'SIGTERM'); await Bun.sleep(5000);");
    const lines: string[] = [];
    const lanes: string[] = [];
    const ctx = context(lines, true);
    ctx.onLane = (event) => lanes.push(event.lane);
    const outcome = await fixIssue(ctx, issue, { maxPoints: 2 });
    expect(outcome.outcome).toBe('unjudged');
    expect(outcome.fault).toBe('stopped');
    expect(lines.some((l) => /attempt \d+ of/.test(l))).toBe(false);
    expect(lanes).not.toContain('H2');
    expect(lanes).not.toContain('B1');
    expect(ctx.dryRunLog.some((line) => /needs-human|loop\/parked|loop\/dlq|environment-fault/.test(line))).toBe(false);
  }, 20_000);

  it('unlike a coder that failed, which counts the attempt and goes back to Ready', async () => {
    engineThat('coder-failed', 'process.exit(1);');
    const lines: string[] = [];
    const lanes: string[] = [];
    const ctx = context(lines, true);
    ctx.onLane = (event) => lanes.push(event.lane);
    const outcome = await fixIssue(ctx, issue, { maxPoints: 2 });
    expect(outcome.outcome).toBe('failed');
    expect(lines.some((l) => /attempt \d+ of/.test(l))).toBe(true);
    expect(lanes.at(-1)).toBe('B1');
  }, 20_000);
});

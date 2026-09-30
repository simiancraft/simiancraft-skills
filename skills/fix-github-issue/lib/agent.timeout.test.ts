import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import { AGENT_TIMEOUT_MS, agentCapMs, agentTimeout, runAgent, TIMED_OUT_EXIT } from './agent.ts';
import { AGENT_SEATS, agentCapFault, MAX_AGENT_TIMEOUT_MINUTES, type ProjectConfig } from './config.ts';
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
    // The hazard itself: the engine said 0, and the fixture's log line shows it wrote its answer
    // before the kill. The answer is gone again, so the resume path cannot find it in the lane later.
    expect(existsSync(join(cwd, VERDICT_FILE))).toBe(false);
    expect(lines.some((l) => /timed out at .* minutes and was killed/.test(l))).toBe(true);
    // One attempt only: a run that spent the cap is not asked again.
    expect(lines.filter((l) => /running worker/.test(l))).toHaveLength(1);
  }, 20_000);

  it('removes what a timed-out reproof worker left too, a role the clearing table does not name', async () => {
    writeFileSync(join(scratch, 'verdict.json'), JSON.stringify({ issue: 7, verdict: 'fixed', reason: 'done', pr: 1, branch: 'fix/x' }));
    const cwd = join(scratch, 'wt', 'issue-9');
    mkdirSync(cwd, { recursive: true });
    const run = await runAgent(context([], false), 'worker-reprove', 9, cwd, { engine: 'fixture', model: join(scratch, 'verdict.json') }, 'prompt');
    expect(run.timedOut).toBe(true);
    expect(existsSync(join(cwd, VERDICT_FILE))).toBe(false);
  }, 20_000);

  it('settles as a failed attempt that says it timed out, not as the fixed verdict it left behind', async () => {
    writeFileSync(join(scratch, 'verdict.json'), JSON.stringify({ issue: 7, verdict: 'fixed', reason: 'done', pr: 1, branch: 'fix/x' }));
    const lines: string[] = [];
    const ctx = context(lines, true);
    const outcome = await fixIssue(ctx, { number: 7, title: 't', createdAt: '2026-09-01T00:00:00Z', labels: [{ name: 'size: 1' }] }, { maxPoints: 2 });
    expect(outcome.outcome).toBe('failed');
    expect(outcome.reason).toContain('worker timed out at');
    expect(outcome.reason).toContain('nothing it left in its lane is trusted');
    expect(outcome.reason).toContain('a redrive continues from that head');
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

describe('the cap a config sets', () => {
  const capFor = (knob: unknown, role: string) => agentCapMs({ knobs: { agentTimeoutMinutes: knob } } as never, role) / 60_000;

  it('is one number for every seat, or a map by seat with a default, else the shipped cap', () => {
    const shipped = agentTimeout.ms / 60_000;
    expect(capFor(undefined, 'worker')).toBe(shipped);
    expect(capFor(90, 'worker')).toBe(90);
    expect(capFor(90, 'reviewer')).toBe(90);
    expect(capFor({ worker: 120, default: 30 }, 'worker')).toBe(120);
    expect(capFor({ worker: 120, default: 30 }, 'reviewer')).toBe(30);
    expect(capFor({ worker: 120 }, 'carver')).toBe(shipped);
  });

  it("gives a revision and a reproof the worker's cap: they are the worker's turns", () => {
    expect(capFor({ worker: 120 }, 'worker-revise')).toBe(120);
    expect(capFor({ worker: 120 }, 'worker-reprove')).toBe(120);
  });

  it('is refused unless it is a positive integer or a map of them by a seat the driver knows', () => {
    for (const good of [undefined, 1, 90, { worker: 120 }, { default: 30, reviewer: 20 }]) expect(agentCapFault(good)).toBeNull();
    for (const bad of [0, -5, 1.5, '90', null, [90], { worker: 0 }, { worker: '90' }, { wroker: 90 }]) expect(agentCapFault(bad)).toContain('agentTimeoutMinutes must be');
  });

  it('can be set for every role a driver actually runs an agent as', () => {
    // Read from the source, so a new runAgent role cannot arrive without a seat to cap it by.
    const roots = [join(HERE, '..'), join(HERE, '..', '..', 'appraise-github-issues'), join(HERE, '..', '..', 'carve-github-issue'), join(HERE, '..', '..', 'walk-the-floor')];
    const roles = new Set<string>();
    for (const root of roots) {
      for (const file of new Bun.Glob('**/*.ts').scanSync({ cwd: root })) {
        if (file.endsWith('.test.ts')) continue;
        for (const m of readFileSync(join(root, file), 'utf8').matchAll(/runAgent\(\s*[\w.]+,\s*([^,]+),/g)) {
          for (const literal of m[1].matchAll(/'([a-z-]+)'/g)) roles.add(literal[1]);
        }
      }
    }
    expect(roles.size).toBeGreaterThan(6);
    const seats = [...roles].map((role) => (role.startsWith('worker') ? 'worker' : role));
    expect(seats.filter((seat) => !AGENT_SEATS.includes(seat))).toEqual([]);
  });

  it('refuses a cap too long for a timer to hold, which would otherwise kill at once', () => {
    expect(agentCapFault(MAX_AGENT_TIMEOUT_MINUTES)).toBeNull();
    expect(agentCapFault(MAX_AGENT_TIMEOUT_MINUTES + 1)).toContain('no greater than');
    expect(agentCapFault({ worker: MAX_AGENT_TIMEOUT_MINUTES + 1 })).toContain('no greater than');
    expect(MAX_AGENT_TIMEOUT_MINUTES * 60_000).toBeLessThanOrEqual(2_147_483_647);
  });

  it('is the cap the run is killed at, and the one its failure names', async () => {
    // A fraction of a minute is not a value a config may hold (see the case above); it is set on
    // the context directly, only so the test does not wait a minute for the kill.
    const before = agentTimeout.ms;
    agentTimeout.ms = 10 * 60_000;
    try {
      const cwd = join(scratch, 'wt', 'issue-10');
      mkdirSync(cwd, { recursive: true });
      const lines: string[] = [];
      const ctx = context(lines, false);
      (ctx.knobs as { agentTimeoutMinutes?: unknown }).agentTimeoutMinutes = { worker: 0.005, default: 10 };
      const run = await runAgent(ctx, 'worker', 10, cwd, { engine: 'fixture', model: join(scratch, 'verdict.json') }, 'prompt');
      expect(run.timedOut).toBe(true);
      expect(lines.some((l) => l.includes('timed out at 0.005 minutes'))).toBe(true);
    } finally {
      agentTimeout.ms = before;
    }
  }, 20_000);
});


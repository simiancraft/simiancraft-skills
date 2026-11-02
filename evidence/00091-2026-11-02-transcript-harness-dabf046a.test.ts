import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = '/home/the-simian/Simiancraft_Programming/.simiancraft-skills-loop/issue-91/skills/fix-github-issue/lib';
let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'stop-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A driver in a process of its own: a lane that holds a claim and is only waiting, then a signal. */
async function drive(lane: string, signals: number) {
  const script = join(scratch, `driver-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(
    script,
    `import { FakeTracker, fakeIssue } from '${join(HERE, '..', '..', 'carve-github-issue', 'lib', 'fake-tracker.ts')}';
import { claim } from '${join(HERE, '..', '..', 'carve-github-issue', 'lib', 'claims.ts')}';
import { stoppableSleep, yieldToStop } from '${join(HERE, 'shell.ts')}';
import { installStopHandler } from '${join(HERE, 'stop.ts')}';
import { pool } from '${join(HERE, 'pool.ts')}';
import { runAgentOnce } from '${join(HERE, 'agent.ts')}';
import { createContext } from '${join(HERE, 'context.ts')}';
import { fixIssue } from '${join(HERE, 'pipeline.ts')}';
const io = new FakeTracker('loop-bot', [fakeIssue(1)]);
const ctx = { botLogin: 'loop-bot', runId: 'host-1-1', dryRun: false, dryRunLog: [], project: { repo: 'o/r' }, log: () => {}, io } as never;
installStopHandler((m) => console.log('LOG ' + m), () => console.log('BEFORE-EXIT'));
const handle = await claim(ctx, io, 1, 'working');
if (handle === 'busy') throw new Error('busy');
console.log('READY');
try {
  ${lane}
} finally {
  handle.release();
  console.log('RELEASED ' + io.view(1).comments.some((c) => c.body.startsWith('<!-- carve-unclaim')));
}
`,
  );
  const proc = Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'pipe' });
  const reader = proc.stdout.getReader();
  let out = '';
  while (!out.includes('READY')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    out += new TextDecoder().decode(chunk.value);
  }
  for (let i = 0; i < signals; i++) {
    proc.kill('SIGINT');
    await Bun.sleep(150);
  }
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    out += new TextDecoder().decode(chunk.value);
  }
  const result = { code: await proc.exited, lines: out.trim().split('\n') }; console.log(JSON.stringify({signals, ...result})); return result;
}

describe('the stop handler, in a process of its own', () => {
  it('unwinds a waiting lane through its finally, so the claim is released before the exit', async () => {
    const run = await drive('await stoppableSleep(600_000);', 1);
    expect(run.code).toBe(130);
    const at = (needle: string) => run.lines.findIndex((l) => l.includes(needle));
    expect(at('the run is stopping')).toBeGreaterThan(-1);
    expect(at('RELEASED true')).toBeGreaterThan(at('the run is stopping'));
    expect(at('BEFORE-EXIT')).toBeGreaterThan(at('RELEASED true'));
    expect(run.lines.some((l) => l.includes('still held'))).toBe(false);
  }, 20_000);

  it('hears a signal that arrived during synchronous reads before it begins a merge', async () => {
    // The signal lands while the process is inside a synchronous child, as it would inside the
    // tracker reads that precede a merge; nothing has heard it when those reads return.
    const run = await drive("Bun.spawnSync(['sleep', '1']); await yieldToStop('merge PR #1'); console.log('MERGE BEGUN');", 1);
    expect(run.code).toBe(130);
    expect(run.lines.some((l) => l.includes('MERGE BEGUN'))).toBe(false);
    expect(run.lines.some((l) => l.includes('RELEASED true'))).toBe(true);
  }, 20_000);

  it('hears a signal before taking another pool item and ends the lane quietly', async () => {
    const lane = `
      console.error = (message) => console.log('ERROR ' + message);
      await pool([1, 2], 1, async (n) => {
        console.log('ITEM ' + n);
        Bun.spawnSync(['sleep', '1']);
      });
      console.log('POOL RETURNED');
    `;
    const stopped = await drive(lane, 1);
    expect(stopped.code).toBe(130);
    expect(stopped.lines).not.toContain('ITEM 2');
    expect(stopped.lines).toContain('POOL RETURNED');
    expect(stopped.lines).toContain('RELEASED true');
    expect(stopped.lines.some((l) => l.startsWith('ERROR '))).toBe(false);

    const control = await drive(lane, 0);
    expect(control.code).toBe(0);
    expect(control.lines).toContain('ITEM 1');
    expect(control.lines).toContain('ITEM 2');
    expect(control.lines).toContain('POOL RETURNED');
    expect(control.lines).toContain('RELEASED true');
    expect(control.lines.some((l) => l.startsWith('ERROR '))).toBe(false);
  }, 20_000);

  it('hears a signal during reads before posting a claim or its label', async () => {
    const lane = `
      io.issues.set(2, fakeIssue(2));
      Bun.spawnSync(['sleep', '1']);
      try {
        const second = await claim(ctx, io, 2, 'working');
        console.log('CLAIM RETURNED');
        console.log('COMMENTS ' + io.view(2).comments.length);
        console.log('LABELS ' + io.view(2).labels.length);
        if (second !== 'busy') second.release();
      } finally {
        console.log('FINAL COMMENTS ' + io.view(2).comments.length);
        console.log('FINAL LABELS ' + io.view(2).labels.length);
      }
    `;
    const stopped = await drive(lane, 1);
    expect(stopped.code).toBe(130);
    expect(stopped.lines).not.toContain('CLAIM RETURNED');
    expect(stopped.lines).toContain('FINAL COMMENTS 0');
    expect(stopped.lines).toContain('FINAL LABELS 0');
    expect(stopped.lines).toContain('RELEASED true');
    expect(stopped.lines.some((l) => l.includes('still held'))).toBe(false);

    const control = await drive(lane, 0);
    expect(control.code).toBe(0);
    expect(control.lines).toContain('CLAIM RETURNED');
    expect(control.lines).toContain('COMMENTS 1');
    expect(control.lines).toContain('LABELS 1');
    expect(control.lines).toContain('RELEASED true');
  }, 20_000);

  it('hears a signal during reads before starting an agent turn', async () => {
    const root = mkdtempSync(join(scratch, 'agent-'));
    const answer = join(root, 'answer.json');
    const cwd = join(root, 'lane');
    writeFileSync(answer, '{}');
    const lane = `
      Bun.spawnSync(['sleep', '1']);
      try {
        await runAgentOnce({ ...ctx, repoRoot: ${JSON.stringify(root)}, runDir: ${JSON.stringify(join(root, 'runs'))}, log: console.log },
          'worker', 1, ${JSON.stringify(cwd)}, { engine: 'fixture', model: ${JSON.stringify(answer)} }, 'prompt');
        console.log('TURN RETURNED');
      } catch (error) {
        console.log('REFUSED ' + error.message);
        throw error;
      }
    `;
    const stopped = await drive(lane, 1);
    expect(stopped.code).toBe(130);
    expect(stopped.lines.some((l) => l.includes('running worker'))).toBe(false);
    expect(stopped.lines.some((l) => l.includes('not started'))).toBe(true);
    expect(stopped.lines).not.toContain('TURN RETURNED');
    expect(stopped.lines).toContain('RELEASED true');
    expect(existsSync(join(cwd, 'loop-verdict.json'))).toBe(false);

    const control = await drive(lane, 0);
    expect(control.code).toBe(0);
    expect(control.lines.some((l) => l.includes('running worker'))).toBe(true);
    expect(control.lines).toContain('TURN RETURNED');
    expect(control.lines).toContain('RELEASED true');
    expect(existsSync(join(cwd, 'loop-verdict.json'))).toBe(true);
  }, 20_000);

  it('keeps a refused lane stopped without counting an attempt or writing a dead letter', async () => {
    const root = mkdtempSync(join(scratch, 'settlement-'));
    const answer = join(root, 'answer.json');
    writeFileSync(answer, JSON.stringify({ issue: 7, verdict: 'failed', reason: 'could not reproduce' }));
    const lane = `
      io.issues.set(7, fakeIssue(7, { labels: [{ name: 'size: 1' }] }));
      const laneCtx = createContext({
        project: { name: 'Test', repo: 'o/r', remote: 'origin', baseBranch: 'main', evidenceBranch: 'evidence',
          checkCommand: 'true', installCommand: 'true', conventionDocs: [], sizingScale: 'fib', sharedServices: [],
          portBase: 9000, portSpan: 10, pathAliases: [], sourceExtensions: ['.ts'], alwaysInvalidates: [],
          touchPaths: { migration: [], ci: [] }, worktreeRoot: 'wt' },
        knobs: { autoMerge: 'never', maxReviewRounds: 3, checksTimeoutMinutes: 1, smokeTimeoutMinutes: 1 },
        seats: { worker: { engine: 'fixture', model: ${JSON.stringify(answer)} }, reviewer: { engine: 'fixture2' } },
        repoRoot: ${JSON.stringify(root)}, invokeRoot: ${JSON.stringify(root)},
        promptsDirs: [${JSON.stringify(join(HERE, '..', 'prompts'))}], dryRun: true,
        runDir: ${JSON.stringify(join(root, 'runs'))}, botLogin: 'loop-bot', io, log: console.log, step: () => {},
      });
      Bun.spawnSync(['sleep', '1']);
      const result = await fixIssue(laneCtx, { number: 7, title: 't', createdAt: '2026-09-01T00:00:00Z', labels: [{ name: 'size: 1' }] }, { maxPoints: 2 });
      console.log('OUTCOME ' + result.outcome);
      console.log('WRITES ' + JSON.stringify(laneCtx.dryRunLog));
    `;
    const stopped = await drive(lane, 1);
    expect(stopped.code).toBe(130);
    expect(stopped.lines).toContain('OUTCOME stopped');
    expect(stopped.lines).toContain('RELEASED true');
    expect(stopped.lines.some((l) => l.includes('running coder'))).toBe(false);
    expect(stopped.lines.some((l) => l.includes('the lane is kept'))).toBe(true);
    expect(stopped.lines.find((l) => l.startsWith('WRITES '))).not.toMatch(/loop\/attempts|loop\/dlq/);
    expect(existsSync(join(root, 'wt', 'issue-7', 'loop-code.json'))).toBe(false);

    const control = await drive(lane, 0);
    expect(control.code).toBe(0);
    expect(control.lines).toContain('OUTCOME failed');
    expect(control.lines).toContain('RELEASED true');
    expect(control.lines.some((l) => l.includes('running coder'))).toBe(true);
    expect(control.lines.find((l) => l.startsWith('WRITES '))).toMatch(/loop\/attempts/);
    expect(existsSync(join(root, 'wt', 'issue-7', 'loop-code.json'))).toBe(true);
  }, 20_000);

  it('exits at once on a second signal, naming the claim a lane that will not unwind still holds', async () => {
    const run = await drive('await Bun.sleep(600_000);', 2);
    expect(run.code).toBe(130);
    expect(run.lines.some((l) => /again; exiting now, abandoning claim\(s\).*o\/r#1/.test(l))).toBe(true);
    expect(run.lines.some((l) => l.startsWith('RELEASED'))).toBe(false);
  }, 20_000);
});

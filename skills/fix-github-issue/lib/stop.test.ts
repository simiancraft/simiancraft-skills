import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStopping } from './shell.ts';
import { staleStop } from './stale-stop.fixture.ts';

const HERE = import.meta.dir;
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
import { RunStopping, isStopping, stoppableSleep, yieldToStop } from '${join(HERE, 'shell.ts')}';
import { installStopHandler } from '${join(HERE, 'stop.ts')}';
import { runAgentOnce } from '${join(HERE, 'agent.ts')}';
import { createContext } from '${join(HERE, 'context.ts')}';
import { catchUp, fixIssue } from '${join(HERE, 'pipeline.ts')}';
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
  return { code: await proc.exited, lines: out.trim().split('\n'), stderr: await new Response(proc.stderr).text() };
}

describe('the stop handler, in a process of its own', () => {
  it('hears a signal during a synchronous read only after an event loop turn', async () => {
    const run = await drive(`
      Bun.spawnSync(['sleep', '1']);
      console.log('AFTER READ ' + isStopping());
      await Promise.resolve();
      console.log('AFTER MICROTASK ' + isStopping());
      await Bun.sleep(0);
      console.log('AFTER TURN ' + isStopping());
    `, 1);
    expect(run.code).toBe(130);
    expect(run.lines).toContain('AFTER READ false');
    expect(run.lines).toContain('AFTER MICROTASK false');
    expect(run.lines).toContain('AFTER TURN true');
    expect(run.lines).toContain('RELEASED true');
  }, 20_000);

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

  it('hears a signal during reads before a real conflicting catch-up', async () => {
    const cwd = mkdtempSync(join(scratch, 'catch-up-'));
    const remote = join(cwd, 'remote.git');
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    writeFileSync(join(cwd, 'shared.txt'), 'original\n');
    git('add', 'shared.txt'); git('commit', '-m', 'initial');
    git('init', '--bare', remote); git('remote', 'add', 'origin', remote);
    git('push', 'origin', 'main');
    git('switch', '-c', 'fix/test');
    writeFileSync(join(cwd, 'shared.txt'), 'lane\n');
    git('commit', '-am', 'lane'); git('push', 'origin', 'HEAD');
    const head = git('rev-parse', 'HEAD');
    git('switch', 'main');
    writeFileSync(join(cwd, 'shared.txt'), 'base\n');
    git('commit', '-am', 'base'); git('push', 'origin', 'main'); git('switch', 'fix/test');
    const lane = `
      Bun.spawnSync(['sleep', '1']);
      const lanes = [];
      const writes = io.writes.length;
      try {
        const result = await catchUp({ ...ctx, project: { repo: 'o/r', remote: 'origin', baseBranch: 'main', alwaysInvalidates: [], releaseArtifacts: [], pathAliases: [], sourceExtensions: [] },
          onLane: (event) => lanes.push(event.lane) }, { number: 1, title: 'test', labels: [] },
          ${JSON.stringify(cwd)}, ${JSON.stringify(head)}, console.log, 'test');
        console.log('RESULT ' + result);
      } finally {
        console.log('WRITES ' + (io.writes.length - writes));
        console.log('LANES ' + JSON.stringify(lanes));
      }
    `;
    const stopped = await drive(lane, 1);
    expect(stopped.code).toBe(130);
    expect(stopped.lines).toContain('WRITES 0');
    expect(stopped.lines).toContain('LANES []');
    expect(stopped.lines).toContain('RELEASED true');
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('--git-dir', remote, 'rev-parse', 'refs/heads/fix/test')).toBe(head);
    expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(false);

    const control = await drive(lane, 0);
    expect({ code: control.code, stderr: control.stderr }).toEqual({ code: 0, stderr: '' });
    expect(control.lines).toContain('RESULT conflict');
    expect(control.lines).toContain('LANES ["F2"]');
    expect(control.lines).toContain('WRITES 0');
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('--git-dir', remote, 'rev-parse', 'refs/heads/fix/test')).toBe(head);
    expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(false);
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

  // Leave the sibling timer due when the gate is armed, without yielding to the signal handler.
  const siblingRead = (read: string, signal: boolean) => `
    const sibling = Bun.sleep(1).then(() => {
      console.log('SIGNAL');
      if (${signal}) process.kill(process.pid, 'SIGINT');
      ${read}
    });
    Bun.spawnSync(['sleep', '0.05']);
  `;

  for (const [name, read] of [
    ['no read', ''],
    ['short read', "Bun.spawnSync(['true']);"],
    ['long read', "Bun.spawnSync(['sleep', '0.5']);"],
  ]) {
    it(`hears a sibling signal before a gate checks after ${name}`, async () => {
      for (const signal of [true, false]) {
        const run = await drive(`
          ${siblingRead(read!, signal)}
          try {
            await yieldToStop('sibling act');
            console.log('ACT');
          } catch (error) {
            console.log('STOP TYPE ' + (error instanceof RunStopping));
            throw error;
          }
          await sibling;
        `, 0);
        expect(run.code).toBe(signal ? 130 : 0);
        expect(run.lines).toContain('SIGNAL');
        expect(run.lines.includes('ACT')).toBe(!signal);
        expect(run.lines.includes('STOP TYPE true')).toBe(signal);
        expect(run.lines).toContain('RELEASED true');
        if (!signal) expect(run.lines.indexOf('SIGNAL')).toBeLessThan(run.lines.indexOf('ACT'));
      }
    }, 20_000);
  }

  it('does not start an agent behind a sibling signal and short read', async () => {
    const root = mkdtempSync(join(scratch, 'sibling-agent-'));
    const answer = join(root, 'answer.json');
    const cwd = join(root, 'lane');
    writeFileSync(answer, '{}');
    for (const signal of [true, false]) {
      const run = await drive(`
        ${siblingRead("Bun.spawnSync(['true']);", signal)}
        try {
          await runAgentOnce({ ...ctx, repoRoot: ${JSON.stringify(root)}, runDir: ${JSON.stringify(join(root, 'runs'))}, log: console.log },
            'worker', 1, ${JSON.stringify(cwd)}, { engine: 'fixture', model: ${JSON.stringify(answer)} }, 'prompt');
          console.log('TURN RETURNED');
        } catch (error) {
          console.log('REFUSED ' + error.message);
          throw error;
        }
        await sibling;
      `, 0);
      expect(run.code).toBe(signal ? 130 : 0);
      expect(run.lines).toContain('SIGNAL');
      expect(run.lines.some((l) => l.includes('running worker'))).toBe(!signal);
      expect(run.lines.some((l) => l.includes('not started'))).toBe(signal);
      expect(run.lines.includes('TURN RETURNED')).toBe(!signal);
      expect(run.lines).toContain('RELEASED true');
      expect(existsSync(join(cwd, 'loop-verdict.json'))).toBe(!signal);
    }
  }, 20_000);

  it('gives simultaneous gates separate turns to hear a signal after the first gate', async () => {
    for (const signal of [true, false]) {
      const run = await drive(`
        await Promise.all([
          (async () => {
            await yieldToStop('first');
            console.log('FIRST');
            console.log('SIGNAL');
            if (${signal}) process.kill(process.pid, 'SIGINT');
            Bun.spawnSync(['true']);
          })(),
          (async () => {
            try {
              await yieldToStop('second');
              console.log('SECOND');
            } catch (error) {
              console.log('STOP TYPE ' + (error instanceof RunStopping));
              throw error;
            }
          })(),
        ]);
      `, 0);
      expect(run.code).toBe(signal ? 130 : 0);
      expect(run.lines).toContain('FIRST');
      expect(run.lines).toContain('SIGNAL');
      expect(run.lines.includes('SECOND')).toBe(!signal);
      expect(run.lines.includes('STOP TYPE true')).toBe(signal);
      expect(run.lines).toContain('RELEASED true');
    }
  }, 20_000);

  it('hears a signal across seeded lane orderings with timer and I/O waits', async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const run = await drive(`
        let state = ${seed};
        const pick = (n) => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) % n);
        const plans = Array.from({ length: 3 }, () =>
          Array.from({ length: 8 }, () => ({ wait: pick(4), read: pick(3) })));
        const sender = pick(3);
        let delivered = false;
        let misses = 0;
        let refused = 0;
        await Promise.all(plans.map(async (plan, lane) => {
          for (let i = 0; i < plan.length; i++) {
            const { wait, read } = plan[i];
            if (wait === 0) await Bun.sleep(0);
            if (wait === 1) await Bun.sleep(1);
            if (wait === 2) await Bun.file(import.meta.path).text();
            if (wait === 3) await Bun.spawn(['true']).exited;
            if (lane === sender && i === 2) {
              process.kill(process.pid, 'SIGINT');
              delivered = true;
              console.log('SIGNAL');
            }
            if (read === 1) {
              const end = performance.now() + 0.25;
              while (performance.now() < end) {}
            }
            if (read === 2) Bun.spawnSync(['true']);
            try {
              await yieldToStop('ordered act');
              if (delivered) misses++;
            } catch (error) {
              if (!(error instanceof RunStopping)) throw error;
              refused++;
              return;
            }
          }
        }));
        console.log('MISSES ' + misses);
        console.log('REFUSED ' + refused);
      `, 0);
      expect(run.code).toBe(130);
      expect(run.lines).toContain('SIGNAL');
      expect(run.lines).toContain('MISSES 0');
      expect(run.lines).not.toContain('REFUSED 0');
      expect(run.lines).toContain('RELEASED true');
    }
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

describe('staleStop', () => {
  it('keeps an arrival before entry unheard until the yield, then stays stopped', async () => {
    const stop = staleStop(0);
    expect(stop.RunStopping).toBe(RunStopping);
    expect(stop.reads).toBe(0);
    expect(stop.isStopping()).toBe(false);
    stop.act('before yield');
    await expect(stop.yieldToStop('merge')).rejects.toBeInstanceOf(RunStopping);
    expect(stop.isStopping()).toBe(true);
    stop.read();
    stop.act('after yield');
    await expect(stop.yieldToStop('park')).rejects.toThrow('not begun: park');
    expect(stop.isStopping()).toBe(true);
    expect(stop.reads).toBe(1);
    expect(stop.late).toEqual(['before yield', 'after yield']);
  });

  it('records acts after the selected read as late even before the stop is heard', async () => {
    const stop = staleStop(2);
    stop.read();
    await stop.yieldToStop('early act');
    stop.act('early');
    expect(stop.isStopping()).toBe(false);
    expect(stop.late).toEqual([]);
    stop.read();
    stop.act('unheard');
    await Promise.resolve();
    expect(stop.isStopping()).toBe(false);
    expect(stop.late).toEqual(['unheard']);
    await expect(stop.yieldToStop('merge')).rejects.toBeInstanceOf(RunStopping);
    expect(stop.isStopping()).toBe(true);
    stop.read();
    stop.act('heard');
    expect(stop.reads).toBe(3);
    expect(stop.acts).toEqual(['early', 'unheard', 'heard']);
    expect(stop.late).toEqual(['unheard', 'heard']);
  });

  it('counts every read without stopping in the control run', async () => {
    const stop = staleStop();
    await stop.yieldToStop('entry');
    for (let i = 0; i < 3; i++) {
      stop.read();
      await stop.yieldToStop('act');
      stop.act(`act ${i}`);
    }
    expect(stop.reads).toBe(3);
    expect(stop.isStopping()).toBe(false);
    expect(stop.acts).toEqual(['act 0', 'act 1', 'act 2']);
    expect(stop.late).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { stoppableSleep, yieldToStop } from '${join(HERE, 'shell.ts')}';
import { installStopHandler } from '${join(HERE, 'stop.ts')}';
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
  return { code: await proc.exited, lines: out.trim().split('\n') };
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

  it('exits at once on a second signal, naming the claim a lane that will not unwind still holds', async () => {
    const run = await drive('await Bun.sleep(600_000);', 2);
    expect(run.code).toBe(130);
    expect(run.lines.some((l) => /again; exiting now, abandoning claim\(s\).*o\/r#1/.test(l))).toBe(true);
    expect(run.lines.some((l) => l.startsWith('RELEASED'))).toBe(false);
  }, 20_000);
});

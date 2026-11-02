import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBoardWriter, waitForBoard } from './board-writer.ts';

let scratch: string;
beforeAll(() => { scratch = mkdtempSync(join(import.meta.dir, '.board-writer-')); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

/** Exercise the real stop handler in a child, synchronizing signals with its output. */
async function drive(resolveAfter: number | null, timeoutMs?: number, twice = false) {
  const script = join(scratch, `driver-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(script, `
import { waitForBoard } from '${join(import.meta.dir, 'board-writer.ts')}';
import { installStopHandler } from '${join(import.meta.dir, '../../fix-github-issue/lib/stop.ts')}';
installStopHandler(console.log, async () => {
  console.log('WAITING');
  const start = performance.now();
  await waitForBoard({ settled: () => new Promise(resolve => {
    ${resolveAfter === null ? '' : `setTimeout(() => { console.log('SETTLED'); resolve(); }, ${resolveAfter});`}
  }) }${timeoutMs === undefined ? '' : `, ${timeoutMs}`});
  console.log('DRAINED ' + (performance.now() - start));
});
setInterval(() => {}, 1000);
console.log('READY');
`);
  const proc = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
  const reader = proc.stdout.getReader();
  let out = '';
  const until = async (marker: string) => {
    while (!out.includes(marker)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`child ended before ${marker}: ${out}`);
      out += new TextDecoder().decode(chunk.value);
    }
  };
  const watchdog = setTimeout(() => proc.kill('SIGKILL'), 4000);
  try {
    await until('READY');
    proc.kill('SIGTERM');
    await until('WAITING');
    const start = performance.now();
    if (twice) proc.kill('SIGTERM');
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      out += new TextDecoder().decode(chunk.value);
    }
    return { code: await proc.exited, out, elapsed: performance.now() - start };
  } finally {
    clearTimeout(watchdog);
    if (proc.exitCode === null) {
      proc.kill('SIGKILL');
      await proc.exited;
    }
  }
}

describe('board writer settlement', () => {
  it('settles an idle writer and permits a driver without a board', async () => {
    const writer = createBoardWriter({ id: 'board', number: 1, title: 'Board', owner: 'owner', url: 'url' }, 'o/r', () => {});
    await writer.settled();
    await waitForBoard(undefined);
  });

  it('bounds a never-settling writer during SIGTERM', async () => {
    const run = await drive(null, 300);
    expect(run.code).toBe(143);
    const duration = Number(run.out.match(/DRAINED ([\d.]+)/)?.[1]);
    expect(duration).toBeGreaterThanOrEqual(280);
    expect(duration).toBeLessThan(2000);
  });

  it('finishes as soon as the writer settles, inside the default bound', async () => {
    const run = await drive(100);
    expect(run.code).toBe(143);
    expect(run.out.indexOf('SETTLED')).toBeLessThan(run.out.indexOf('DRAINED'));
    const duration = Number(run.out.match(/DRAINED ([\d.]+)/)?.[1]);
    expect(duration).toBeGreaterThanOrEqual(90);
    expect(duration).toBeLessThan(2000);
  });

  it('exits on a second SIGTERM while the writer is still pending', async () => {
    const run = await drive(null, undefined, true);
    expect(run.code).toBe(143);
    expect(run.out).toContain('again; exiting now');
    expect(run.out).not.toContain('DRAINED');
    expect(run.elapsed).toBeLessThan(2000);
  });
});

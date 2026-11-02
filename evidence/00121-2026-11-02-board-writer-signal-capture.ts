import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
const scratch = import.meta.dir;
const writerDir = join(import.meta.dir, '../skills/burn-down-github-issues/lib');
async function drive(resolveAfter: number | null, timeoutMs?: number, twice = false) {
  const script = join(scratch, `driver-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(script, `
import { waitForBoard } from '${join(writerDir, 'board-writer.ts')}';
import { installStopHandler } from '${join(writerDir, '../../fix-github-issue/lib/stop.ts')}';
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


for (const [name, delay, bound, twice] of [
 ['timeout', null, 300, false], ['settles', 100, undefined, false], ['second-signal', null, undefined, true]
] as const) {
 const run = await drive(delay, bound, twice);
 assert.equal(run.code, 143);
 const ms = Number(run.out.match(/DRAINED ([\d.]+)/)?.[1]);
 if (name === 'timeout') assert(ms >= 280 && ms < 2000);
 if (name === 'settles') { assert(ms >= 90 && ms < 2000); assert(run.out.indexOf('SETTLED') < run.out.indexOf('DRAINED')); }
 if (twice) { assert(!run.out.includes('DRAINED')); assert(run.out.includes('again; exiting now')); assert(run.elapsed < 2000); }
 console.log(JSON.stringify({name, ...run}));
}

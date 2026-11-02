import { afterEach, expect, it } from 'bun:test';
import { pool } from '../../fix-github-issue/lib/pool.ts';
import { beginStop, isStopping, resetStop, RunStopping } from '../../fix-github-issue/lib/shell.ts';
import { createLine } from './line.ts';
import { lineFixture } from './line.fixture.ts';

const fixtures: ReturnType<typeof lineFixture>[] = [];
function fixture(sleep: (ms: number) => Promise<void> = async () => { throw new Error('unexpected poll'); }) {
  const f = lineFixture(sleep);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
  resetStop();
});

it.each([
  [undefined, 'go'], ['go', 'go'], ['pause', 'pause'], ['FINISH', 'finish'],
  [' finish ', 'finish'], ['stop', 'pause'],
] as const)('reads %p as %s', (word, state) => {
  const f = fixture();
  if (word !== undefined) f.write(word);
  expect(f.readSwitch().state).toBe(state);
  expect(f.lineFinishing()).toBe(state === 'finish');
});

it.each(['finish', 'go'])('ends a pause hold on %s within one poll', async (word) => {
  let polls = 0;
  const f = fixture(async () => { polls++; f.write(word); });
  f.write('pause');
  expect(await f.holdForDispatch('#1')).toBe(word === 'go');
  expect(polls).toBe(1);
});

it('latches admission while merge holds still release on go', async () => {
  let polls = 0;
  const f = fixture(async () => { polls++; f.write('go'); });
  f.write('finish');
  await f.waitForGo('merge');
  expect(polls).toBe(1);
  expect(f.lineFinishing()).toBe(true);
  expect(await f.holdForDispatch('#2')).toBe(false);
  await f.waitForGo('merge');
  expect(polls).toBe(1);
  expect(f.reports).not.toContain('active');
  expect(createLine(f.options).lineFinishing()).toBe(false);
});

it('passes a floor pause and holds a person or unknown word at the merge', async () => {
  let polls = 0;
  const f = fixture(async () => { polls++; f.write('go'); });
  f.write('pause\nfloor: incident');
  await f.waitForGo('incident merge', true);
  expect(polls).toBe(0);
  for (const word of ['pause\nperson', 'stop', 'pause\nfloor: incident']) {
    f.write(word);
    await f.waitForGo('merge', word !== 'pause\nfloor: incident');
  }
  expect(polls).toBe(3);
});

it.each(['dispatch', 'merge'])('a signal ends the %s hold with RunStopping', async (seam) => {
  const f = fixture(async () => { beginStop(); });
  f.write('pause');
  const held = seam === 'dispatch' ? f.holdForDispatch('#1') : f.waitForGo('merge');
  await expect(held).rejects.toBeInstanceOf(RunStopping);
});

it('refuses queued items without cancelling the admitted child or stopping the pool', async () => {
  const f = fixture();
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const running = pool([1, 2, 3], 1, async (item) => {
      if (!(await f.holdForDispatch(`#${item}`))) return;
      f.dispatch(item);
      child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
      admitted.resolve();
      await release.promise;
    });
    await admitted.promise;
    f.write('finish');
    expect(f.lineFinishing()).toBe(true);
    expect(child?.exitCode).toBeNull();
    expect(isStopping()).toBe(false);
    release.resolve();
    await running;
    expect(f.dispatched).toEqual([1]);
    expect(f.logs.filter((message) => message.includes('refusing'))).toHaveLength(2);
    expect(child?.exitCode).toBeNull();
    expect(isStopping()).toBe(false);
  } finally {
    child?.kill();
    await child?.exited;
  }
});

it('holds an unknown word at dispatch and admits after go', async () => {
  let polls = 0;
  const f = fixture(async () => { polls++; f.write('go'); });
  f.write('stop');
  expect(await f.holdForDispatch('#1')).toBe(true);
  expect(polls).toBe(1);
  expect(f.lineFinishing()).toBe(false);
});

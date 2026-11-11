import { afterEach, describe, expect, it } from 'bun:test';
import { refillingPool } from './pool.ts';
import { beginStop, resetStop } from './shell.ts';

afterEach(() => resetStop());

const tick = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));

describe('refillingPool', () => {
  it('works an item a settle made eligible, in the same pool', async () => {
    const worked: string[] = [];
    let unblocked = false;
    let handed = false;
    await refillingPool(
      ['A'],
      2,
      async (item) => {
        await tick();
        worked.push(item);
        if (item === 'A') unblocked = true;
      },
      async () => {
        if (!unblocked || handed) return [];
        handed = true;
        return ['B'];
      },
    );
    expect(worked).toEqual(['A', 'B']);
  });

  it('works a chain that frees one item at a time, then ends', async () => {
    const worked: number[] = [];
    let freed = 1;
    await refillingPool(
      [1],
      2,
      async (n) => {
        await tick();
        worked.push(n);
        freed = n + 1;
      },
      async () => (freed <= 5 && !worked.includes(freed) ? [freed] : []),
    );
    expect(worked).toEqual([1, 2, 3, 4, 5]);
  });

  it('never runs more items at once than its size, refills included', async () => {
    let active = 0;
    let most = 0;
    let handed = 0;
    await refillingPool(
      [1, 2, 3],
      2,
      async () => {
        active++;
        most = Math.max(most, active);
        await tick(3);
        active--;
      },
      async () => (handed++ < 3 ? [10 + handed, 20 + handed] : []),
    );
    expect(most).toBe(2);
  });

  it('asks once more when idle, so the last settle is never missed', async () => {
    const asks: number[] = [];
    let worked = 0;
    await refillingPool(
      [1],
      1,
      async () => {
        worked++;
        await tick();
      },
      async () => {
        asks.push(worked);
        return [];
      },
    );
    // Once after the settle, once more as the idle check.
    expect(asks).toEqual([1, 1]);
  });

  it('starts nothing and asks for nothing once the run is stopping, and waits for items in flight', async () => {
    const worked: number[] = [];
    let asks = 0;
    await refillingPool(
      [1, 2, 3],
      2,
      async (n) => {
        await tick(1);
        if (n === 1) beginStop();
        await tick(3);
        worked.push(n);
      },
      async () => {
        asks++;
        return [99];
      },
    );
    // 1 and 2 were already in flight when 1 stopped the run; 3 never started; nothing was asked.
    expect(worked.sort()).toEqual([1, 2]);
    expect(asks).toBe(0);
  });

  it('treats a refill that throws as an empty answer and still ends', async () => {
    const worked: number[] = [];
    await refillingPool(
      [1],
      1,
      async (n) => {
        worked.push(n);
      },
      async () => {
        throw new Error('tracker unreachable');
      },
    );
    expect(worked).toEqual([1]);
  });

  it('works nothing and asks once when it starts empty', async () => {
    let asks = 0;
    await refillingPool<number>([], 2, async () => {}, async () => (asks++, []));
    expect(asks).toBe(1);
  });
});

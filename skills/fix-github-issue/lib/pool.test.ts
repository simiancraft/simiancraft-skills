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

  it('starts nothing a refill returned if the run began stopping while the refill was running', async () => {
    const worked: number[] = [];
    await refillingPool(
      [1],
      2,
      async (n) => {
        worked.push(n);
      },
      async () => {
        await tick();
        beginStop();
        return [2, 3];
      },
    );
    expect(worked).toEqual([1]);
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

describe('refillingPool with work beside it', () => {
  it('starts its items before the work beside it settles, and asks the refill only after', async () => {
    const events: string[] = [];
    let finish!: () => void;
    const startup = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const beside = (async () => {
      await startup;
      events.push('startup settled');
    })();
    const pooled = refillingPool(
      ['A', 'B'],
      2,
      async (item) => {
        events.push(`start ${item}`);
        await tick();
        events.push(`end ${item}`);
      },
      async () => {
        events.push('refill');
        return events.includes('start C') ? [] : ['C'];
      },
      String,
      { until: beside },
    );
    await tick(10);
    // Both items ran and settled while the work beside the pool was still going; no refill was asked.
    expect(events).toEqual(['start A', 'start B', 'end A', 'end B']);
    finish();
    await pooled;
    // After C: once for its settle, once more as the idle check.
    expect(events.slice(4)).toEqual(['startup settled', 'refill', 'start C', 'end C', 'refill', 'refill']);
  });

  it('waits for the work beside it when it starts empty, then works what the refill finds', async () => {
    const worked: string[] = [];
    let carved = false;
    const beside = (async () => {
      await tick(5);
      carved = true;
    })();
    await refillingPool<string>(
      [],
      2,
      async (item) => {
        worked.push(item);
      },
      async () => (carved && !worked.includes('child') ? ['child'] : []),
      String,
      { until: beside },
    );
    expect(worked).toEqual(['child']);
  });

  it('fills a free slot as soon as the work beside it settles, without waiting on a lane', async () => {
    const events: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const beside = tick(3);
    const pooled = refillingPool(
      ['slow'],
      2,
      async (item) => {
        events.push(`start ${item}`);
        if (item === 'slow') await slow;
        events.push(`end ${item}`);
      },
      async () => (events.includes('start child') ? [] : ['child']),
      String,
      { until: beside },
    );
    await tick(10);
    expect(events).toEqual(['start slow', 'start child', 'end child']);
    release();
    await pooled;
  });

  it('opens the refill when the work beside it fails, and leaves the failure to the caller', async () => {
    const worked: string[] = [];
    const beside = (async () => {
      await tick();
      throw new Error('sweep failed');
    })();
    await refillingPool<string>(
      [],
      1,
      async (item) => {
        worked.push(item);
      },
      async () => (worked.length === 0 ? ['after'] : []),
      String,
      { until: beside },
    );
    expect(worked).toEqual(['after']);
    await expect(beside).rejects.toThrow('sweep failed');
  });
});

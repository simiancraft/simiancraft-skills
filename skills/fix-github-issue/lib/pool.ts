import { isStopping, RunStopping } from './shell.ts';

/**
 * The worker pool: bounded concurrency over a list, where one slow item does not hold up the rest.
 */

/**
 * Runs `work` over `items` with at most `size` in flight, each lane pulling the next item as its
 * own finishes so one slow item does not hold up the rest. A thrown item does not stop the pool;
 * a stopping run does, since it starts nothing new, and an item the stop unwound is not an error.
 */
export async function pool<T>(
  items: T[],
  size: number,
  work: (item: T) => Promise<void>,
  label: (item: T) => string = (item) => String(item),
): Promise<void> {
  const queue = [...items];
  const lanes = Array.from({ length: Math.max(1, Math.min(size, queue.length)) }, async () => {
    for (;;) {
      if (isStopping()) return;
      const item = queue.shift();
      if (!item) return;
      try {
        await work(item);
      } catch (error) {
        if (error instanceof RunStopping) return;
        console.error(`\n${label(item)} threw: ${(error as Error).message}`);
      }
    }
  });
  await Promise.all(lanes);
}

/**
 * `pool` for work that grows while it runs. After each item settles, and once more when nothing is
 * queued or in flight, `refill` is asked for items that became eligible meanwhile; its answer joins
 * the queue. Refills run one at a time, so two items settling together cannot both admit the same
 * new item, and the caller's refill is the place that decides an item is new. The pool ends when
 * nothing is queued, nothing is in flight, and a refill asked after the last settle returned
 * nothing; a stopping run starts nothing new, asks for nothing, and ends when its items in flight
 * have settled. A refill that throws is reported and counts as an empty answer.
 */
export async function refillingPool<T>(
  items: T[],
  size: number,
  work: (item: T) => Promise<void>,
  refill: () => Promise<T[]>,
  label: (item: T) => string = (item) => String(item),
): Promise<void> {
  const queue = [...items];
  const limit = Math.max(1, size);
  const running = new Map<symbol, Promise<symbol>>();
  const start = (item: T) => {
    const token = Symbol(label(item));
    const settled = (async () => {
      try {
        await work(item);
      } catch (error) {
        if (!(error instanceof RunStopping)) console.error(`\n${label(item)} threw: ${(error as Error).message}`);
      }
      return token;
    })();
    running.set(token, settled);
  };
  const ask = async (): Promise<T[]> => {
    if (isStopping()) return [];
    try {
      return await refill();
    } catch (error) {
      if (!(error instanceof RunStopping)) console.error(`\nrefill threw: ${(error as Error).message}`);
      return [];
    }
  };
  for (;;) {
    while (!isStopping() && running.size < limit && queue.length > 0) start(queue.shift() as T);
    if (running.size > 0) {
      running.delete(await Promise.race(running.values()));
      queue.push(...(await ask()));
      continue;
    }
    if (isStopping()) return;
    if (queue.length > 0) continue;
    const more = await ask();
    if (more.length === 0) return;
    queue.push(...more);
  }
}

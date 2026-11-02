import { RunStopping, yieldToStop } from './shell.ts';

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
  let admission: Promise<unknown> = Promise.resolve();
  const lanes = Array.from({ length: Math.max(1, Math.min(size, queue.length)) }, async () => {
    for (;;) {
      try {
        // Arm each gate after the previous lane's synchronous work has returned.
        const turn = admission.then(() => yieldToStop('take the next pool item'));
        admission = turn.catch(() => {});
        await turn;
      } catch (error) {
        if (error instanceof RunStopping) return;
        throw error;
      }
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

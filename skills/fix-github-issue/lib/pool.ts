/**
 * The worker pool: bounded concurrency over a list, where one slow item does not hold up the rest.
 */

/**
 * Runs `work` over `items` with at most `size` in flight, each lane pulling the next item as its
 * own finishes so one slow item does not hold up the rest. A thrown item does not stop the pool.
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
      const item = queue.shift();
      if (!item) return;
      try {
        await work(item);
      } catch (error) {
        console.error(`\n${label(item)} threw: ${(error as Error).message}`);
      }
    }
  });
  await Promise.all(lanes);
}

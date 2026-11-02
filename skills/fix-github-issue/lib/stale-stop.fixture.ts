import { RunStopping } from './shell.ts';

/** A signal arrives during read n, but only a yield lets the stop handler hear it. */
export function staleStop(n?: number) {
  let reads = 0;
  let arrived = n === 0;
  let stopping = false;
  const acts: string[] = [];
  const late: string[] = [];
  return {
    read(): void {
      reads++;
      if (reads === n) arrived = true;
    },
    get reads() { return reads; },
    isStopping: () => stopping,
    async yieldToStop(before: string): Promise<void> {
      if (!arrived) return;
      stopping = true;
      throw new RunStopping(`the run is stopping; not begun: ${before}`);
    },
    RunStopping,
    act(name: string): void {
      acts.push(name);
      if (arrived) late.push(name);
    },
    acts,
    late,
  };
}

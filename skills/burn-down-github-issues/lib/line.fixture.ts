import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLine, type LineOptions } from './line.ts';

/** Real switch and dispatch spy shared by the admission seam tests. */
export function lineFixture(sleep: LineOptions['sleep']) {
  const dir = mkdtempSync(join(import.meta.dir, '.line-test-'));
  const switchFile = join(dir, 'line-switch');
  const logs: string[] = [];
  const dispatched: number[] = [];
  const reports: string[] = [];
  const options: LineOptions = {
    switchFile, sleep, log: (message) => { logs.push(message); }, silent: () => true,
    report: (state) => { reports.push(state); },
  };
  const line = createLine(options);
  return {
    ...line, options, logs, dispatched, reports,
    write: (word: string) => writeFileSync(switchFile, word),
    dispatch: (item: number) => { dispatched.push(item); },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

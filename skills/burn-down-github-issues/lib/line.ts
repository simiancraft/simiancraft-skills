import { existsSync, readFileSync } from 'node:fs';
import { isStopping, RunStopping } from '../../fix-github-issue/lib/shell.ts';
import { elapsed, lineState, setLine, stamp, type LineState } from '../status.ts';

export type LineWord = 'go' | 'pause' | 'finish';
export type LineOptions = {
  switchFile: string;
  log: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
  silent?: () => boolean;
  report?: (state: LineState['state'], reason?: string) => void;
};

/** One policy per run: observing finish closes admission for the lifetime of this instance. */
export function createLine(options: LineOptions) {
  let finishing = false;
  const report = options.report ?? setLine;

  function readSwitch(): { state: LineWord; reason: string } {
    if (!existsSync(options.switchFile)) return { state: 'go', reason: '' };
    const [first = '', ...rest] = readFileSync(options.switchFile, 'utf8').split('\n');
    const word = first.trim().toLowerCase();
    const state = word === 'go' || word === 'finish' ? word : 'pause';
    const reason = rest.join(' ').trim() || first.trim();
    if (state === 'finish') {
      finishing = true;
      report('finishing', reason);
    }
    return { state, reason };
  }

  function lineFinishing(): boolean {
    readSwitch();
    return finishing;
  }

  async function hold(where: string, dispatch: boolean, passFloorPause = false): Promise<boolean> {
    let announced = false;
    for (;;) {
      if (isStopping()) throw new RunStopping(`the run is stopping; no longer holding ${where}`);
      const sw = readSwitch();
      if (dispatch && finishing) {
        options.log(`line is finishing; refusing ${where}; card left where it is`);
        return false;
      }
      // Keep the merge exception exactly as before, including the reason prefix check.
      if (sw.state === 'go' || (passFloorPause && sw.reason.startsWith('floor:'))) {
        if (sw.state === 'go' && !finishing) report('active');
        if (announced) options.log(`line is go again; resuming ${where}`);
        return true;
      }
      if (!finishing) report('paused', sw.reason);
      if (!announced) {
        options.log(`line is ${finishing ? 'finishing' : 'paused'} (${sw.reason || 'no reason given'}); holding ${where} until ${options.switchFile} says go`);
        announced = true;
      } else if (!options.silent?.()) {
        console.log(`${finishing ? '🏁 finishing' : '⏸️ paused'} ${elapsed(lineState().since)}  holding ${where}  ⏱ ${stamp()}`);
      }
      await options.sleep(30 * 1000);
    }
  }

  /** A pause waits; finish refuses without cancelling any work already admitted. */
  const holdForDispatch = (where: string): Promise<boolean> => hold(where, true);
  /** Merge holds follow the current word, even after admission has latched finish. */
  const waitForGo = async (where: string, passFloorPause = false): Promise<void> => {
    await hold(where, false, passFloorPause);
  };
  return { readSwitch, lineFinishing, holdForDispatch, waitForGo };
}

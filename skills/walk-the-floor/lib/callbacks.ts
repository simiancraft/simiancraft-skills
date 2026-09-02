/**
 * The floor's two callback slots, `on-pass` and `on-fail`, on the shared slot mechanism in
 * fix-github-issue. Either an executable the driver runs with the ledger entry on stdin, or a
 * Markdown prompt handed to the agent, or both. The walker never knows what a callback does; the
 * executable form exists so a safety interlock never depends on an agent following a prompt.
 */

import { type CallbackResult, runCallback as runSlot } from '../../fix-github-issue/lib/callbacks.ts';
import type { LedgerEntry } from './floor.ts';

export type CallbackName = 'on-pass' | 'on-fail';
export type { CallbackResult };

export function runCallback(
  dir: string,
  name: CallbackName,
  entry: LedgerEntry,
  log: (message: string) => void,
): Promise<CallbackResult> {
  return runSlot(dir, name, entry, log);
}

/**
 * The line's pause for a host fault. A seat that failed on a full disk or exhausted memory has
 * judged nothing and counted nothing (`settleEnvironmentFault`); the line is paused so nothing else
 * is dispatched or merged on a host in that state, and only a person releases it, once the host is
 * fixed. The work the fault interrupted is rerun after that.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HOST_PAUSE, standingPause } from './floor/line.ts';

export { HOST_PAUSE } from './floor/line.ts';

/**
 * Writes the host pause to the line switch. A person's pause stands, since their reason is theirs to
 * clear; a floor pause is replaced, because a host that is out of disk or memory must hold an
 * incident's fix too, which a floor pause lets through. Returns what it did; a write that fails
 * (the disk is full) throws, and the caller decides what holds the line instead.
 */
export function pauseForHost(switchFile: string, reason: string): 'paused' | 'kept' {
  if (standingPause(switchFile)?.by === 'person') return 'kept';
  mkdirSync(dirname(switchFile), { recursive: true });
  writeFileSync(switchFile, `pause\n${HOST_PAUSE} ${reason}; fix the host, then write go to this file\n`);
  return 'paused';
}

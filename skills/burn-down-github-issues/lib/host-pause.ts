/**
 * The line's pause for a host error. A lane that failed on a full disk or exhausted memory has
 * counted nothing and kept its worktree; the line is paused so nothing else is dispatched or merged
 * on a host in that state, and only a person releases it, once the host is fixed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { FLOOR_PAUSE } from './floor/floor.ts';

/** The reason prefix a host pause is written with, so the switch says who paused the line and why. */
export const HOST_PAUSE = 'host:';

/**
 * Writes the host pause to the line switch. A person's pause stands, since their reason is theirs to
 * clear; a floor pause is replaced, because a host that is out of disk or memory must hold an
 * incident's fix too, which a floor pause lets through. Returns what it did; a write that fails
 * (the disk is full) throws, and the caller decides what holds the line instead.
 */
export function pauseForHost(switchFile: string, reason: string): 'paused' | 'kept' {
  if (existsSync(switchFile)) {
    const [first = '', second = ''] = readFileSync(switchFile, 'utf8').split('\n');
    // Read as the loop reads it: anything but go is a pause.
    const paused = first.trim().toLowerCase() !== 'go';
    if (paused && !second.startsWith(FLOOR_PAUSE) && !second.startsWith(HOST_PAUSE)) return 'kept';
  }
  mkdirSync(dirname(switchFile), { recursive: true });
  writeFileSync(switchFile, `pause\n${HOST_PAUSE} ${reason}; fix the host, then write go to this file\n`);
  return 'paused';
}

/**
 * The line switch as the floor writes it and the loop reads it. A pause the floor writes carries the
 * cause of what it found wrong in its reason, `floor:<cause>: …`, so the kind of pause is readable
 * from the switch file alone and survives a restart. A reason without the `floor:` prefix is a
 * person's, and a person's pause always holds every seam.
 *
 * The causes say which state of knowledge the floor is in:
 *   undiagnosed         a walk found something wrong and no diagnosis has answered yet
 *   cause-unknown       a diagnosis ran and could not say (it failed, or gave no usable answer)
 *   in-repository       a diagnosis places the remedy in this repository: the floor repairs its own fault
 *   outside-repository  a diagnosis places the remedy outside it: an outage a person or a vendor fixes
 *
 * Only the last is an outage. The other three hold the line as a repair: merges wait, and no new
 * lane starts, so the incident's fix comes first. Not knowing the cause is not knowing it is not ours.
 */

import { existsSync, readFileSync } from 'node:fs';

/** The reason the floor writes when it pauses the line; a pause without this prefix is a person's. */
export const FLOOR_PAUSE = 'floor:';

export const FLOOR_CAUSES = ['undiagnosed', 'cause-unknown', 'in-repository', 'outside-repository'] as const;
export type FloorCause = (typeof FLOOR_CAUSES)[number];

/** Where the loop reads the switch: before the appraisal batch, before a lane starts, and before every merge. */
export type Seam = 'appraisal' | 'dispatch' | 'merge';

export type Pause = { by: 'person' } | { by: 'floor'; cause: FloorCause };

export type Switch = { state: 'go' | 'pause'; reason: string };

/** The switch as it stands: absent means go, an unknown first word means pause, the rest is the reason. */
export function readSwitch(file: string): Switch {
  if (!existsSync(file)) return { state: 'go', reason: '' };
  const [first = '', ...rest] = readFileSync(file, 'utf8').split('\n');
  const word = first.trim().toLowerCase();
  return { state: word === 'go' ? 'go' : 'pause', reason: rest.join(' ').trim() || first.trim() };
}

/** The switch's second line for a floor pause of this cause. */
export function floorReason(cause: FloorCause, text: string): string {
  return `${FLOOR_PAUSE}${cause}: ${text}`;
}

/**
 * Who wrote a pause, and for the floor, the cause it recorded. A bare `floor:` reason, as an earlier
 * version wrote, recorded no cause: it reads as undiagnosed, which holds what it always held.
 */
export function readPause(reason: string): Pause {
  if (!reason.startsWith(FLOOR_PAUSE)) return { by: 'person' };
  const rest = reason.slice(FLOOR_PAUSE.length);
  const cause = FLOOR_CAUSES.find((c) => rest.startsWith(`${c}:`));
  return { by: 'floor', cause: cause ?? 'undiagnosed' };
}

/**
 * The cause of a floor pause over several wrong items: an outage only when every item's remedy is
 * outside the repository. Any item that is the repository's, or not known to be anyone's, makes the
 * whole pause a repair.
 */
export function combineCauses(causes: FloorCause[]): FloorCause {
  for (const cause of ['undiagnosed', 'cause-unknown', 'in-repository'] as const) if (causes.includes(cause)) return cause;
  return 'outside-repository';
}

/** An outage holds only the merge; a repair, or a person's pause, holds every seam. */
export function isOutage(pause: Pause): boolean {
  return pause.by === 'floor' && pause.cause === 'outside-repository';
}

/**
 * Whether the switch holds this seam. `incidentFix` is a floor incident's fix at the merge: it is the
 * merge that clears the floor's own pause, so it passes any pause the floor wrote, and never a person's.
 */
export function lineHolds(sw: Switch, seam: Seam, incidentFix = false): boolean {
  if (sw.state === 'go') return false;
  const pause = readPause(sw.reason);
  if (pause.by === 'person') return true;
  if (seam === 'merge') return !incidentFix;
  return !isOutage(pause);
}

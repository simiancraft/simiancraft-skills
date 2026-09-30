/**
 * The lanes: the burndown's state machine as the Status options of an operator's board, derived
 * from `machine.ts`, which is the one source. A lane is a leaf state of the ticket region that
 * carries a `lane` spec; the board order is the machine's declaration order, and the phase is the
 * state's compound parent. The lane is the fine state; the phase is the coarse view a person or
 * the console collapses to, and it is derived from the lane, never the other way around.
 *
 * Keys (A1, C5, Q3) are the stable identifiers code uses; names are what the board shows and what
 * the lane writer matches on. Colors are GitHub's eight; a phase shares one, and the emoji prefix
 * carries the phase where colors run out.
 */

import { MACHINE, type Phase, PHASE_OF_STATE, walk } from './machine.ts';

export type { Phase } from './machine.ts';

export type LaneColor = 'GRAY' | 'BLUE' | 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'PINK' | 'PURPLE';

export type Lane = {
  key: string;
  phase: Phase;
  name: string;
  description: string;
  /** The state path in the machine, `ticket.work.coding`. */
  state: string;
};

export const PHASES: Record<Phase, { label: string; emoji: string; color: LaneColor; description: string }> = {
  appraisal: { label: 'Appraisal', emoji: '📏', color: 'BLUE', description: 'Is it real, and how big; read-only' },
  ready: { label: 'Ready', emoji: '🟢', color: 'GREEN', description: 'Sized leaf waiting for a worker' },
  carving: { label: 'Carving', emoji: '🔪', color: 'PURPLE', description: 'Too big; being cut into children, or held while they move' },
  work: { label: 'Work', emoji: '🔨', color: 'YELLOW', description: 'A worker in a worktree: code, prove, draft' },
  review: { label: 'Review', emoji: '🔍', color: 'ORANGE', description: 'A second engine judges the evidence' },
  landing: { label: 'Landing', emoji: '🚀', color: 'GREEN', description: 'The serial pull master: freshness, checks, smoke, merge' },
  waits: { label: 'Waits', emoji: '⏳', color: 'GRAY', description: 'Nothing is wrong; something else must move first' },
  'dead-letters': { label: 'Dead letters', emoji: '☠️', color: 'RED', description: 'A machine gave up; its triage may retry' },
  human: { label: 'Human', emoji: '🙋', color: 'PINK', description: 'Only a person can move it' },
  terminal: { label: 'Done', emoji: '✅', color: 'GRAY', description: 'Closed' },
};

/** Every lane, in board order (left to right): the machine's leaf states that carry a lane spec. */
export const LANES: readonly Lane[] = walk(MACHINE)
  .filter(([path, node]) => path.startsWith('ticket.') && node.lane)
  .map(([path, node]) => {
    const phase = PHASE_OF_STATE[path.split('.')[1]];
    if (!phase) throw new Error(`state ${path} carries a lane but sits in no known phase`);
    const spec = node.lane as NonNullable<typeof node.lane>;
    return { key: spec.key, phase, name: spec.name, description: spec.description, state: path };
  });

/** What the board shows for a lane: the phase emoji, then the name. */
export function laneLabel(lane: Lane): string {
  return `${PHASES[lane.phase].emoji} ${lane.name}`;
}

export function laneByKey(key: string): Lane {
  const lane = LANES.find((l) => l.key === key);
  if (!lane) throw new Error(`no lane with key ${key}`);
  return lane;
}

/** The lane a displayed option name denotes, or undefined for an option the table does not know. */
export function laneByLabel(label: string): Lane | undefined {
  return LANES.find((l) => laneLabel(l) === label);
}

/** The board's Phase option name for a lane. */
export function phaseLabel(phase: Phase): string {
  return `${PHASES[phase].emoji} ${PHASES[phase].label}`;
}

/** The GitHub option payload for the Status field: the whole set, in board order. */
export function statusOptions(): Array<{ name: string; color: LaneColor; description: string }> {
  return LANES.map((lane) => ({ name: laneLabel(lane), color: PHASES[lane.phase].color, description: lane.description }));
}

/** The GitHub option payload for the Phase field: one per phase, in board order. */
export function phaseOptions(): Array<{ name: string; color: LaneColor; description: string }> {
  return (Object.keys(PHASES) as Phase[]).map((phase) => ({
    name: phaseLabel(phase),
    color: PHASES[phase].color,
    description: PHASES[phase].description,
  }));
}

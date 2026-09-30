/**
 * An interpreter for `machine.ts`: the statechart executed as data, so a scenario runs against the
 * specification itself rather than against someone's reading of it. It resolves an event the way
 * XState does (the deepest state's own transitions first, then each ancestor's, the first
 * transition in a list whose guard holds), follows a target into a compound state's initial child,
 * and settles a transient state through its `always` list. A transition whose target is the
 * state itself does not re-enter it. It runs no action; it returns the
 * actions a transition names, in order, so a scenario can assert on them.
 *
 * A guard is a name, or names joined by `and` / `or` (`and` binds tighter). A scenario supplies
 * the truth of each name; an unknown name is false, which is the conservative reading.
 */

import { LANES } from './lanes.ts';
import { MACHINE, type StateNode, type Transition, walk } from './machine.ts';

export type Facts = ReadonlySet<string> | ((guard: string) => boolean);

const NODES = new Map<string, StateNode>(walk(MACHINE));

export function holds(guard: string | undefined, facts: Facts): boolean {
  if (!guard) return true;
  const truth = typeof facts === 'function' ? facts : (name: string) => facts.has(name);
  return guard.split(' or ').some((clause) => clause.split(' and ').every((name) => truth(name.trim())));
}

/** The atomic guard names an expression mentions. */
export function atoms(guard: string | undefined): string[] {
  return guard ? guard.split(/ and | or /).map((name) => name.trim()) : [];
}

export type Settled = { state: string; actions: string[]; via: string[] };

export class Leak extends Error {}

/** Follows a target to a resting state: into initial children, and through transient `always` lists. */
export function settle(target: string, facts: Facts, actions: string[] = [], via: string[] = []): Settled {
  const node = NODES.get(target);
  if (!node) throw new Leak(`transition target ${target} is not a state`);
  via.push(target);
  if (via.length > 12) throw new Leak(`settling never rests: ${via.join(' -> ')}`);
  actions.push(...(node.entry ?? []));
  if (node.always) {
    const taken = node.always.find((t) => holds(t.guard, facts));
    if (!taken) throw new Leak(`${target} is transient and no always-transition holds under these facts`);
    actions.push(...(taken.actions ?? []));
    return settle(taken.target, facts, actions, via);
  }
  if (node.states && node.initial) return settle(`${target}.${node.initial}`, facts, actions, via);
  return { state: target, actions, via };
}

/** The transition lists that answer `event` in `state`, deepest first. */
function handlers(state: string, event: string): Array<{ at: string; list: Transition[] }> {
  const out: Array<{ at: string; list: Transition[] }> = [];
  const parts = state.split('.');
  for (let depth = parts.length; depth >= 1; depth--) {
    const at = parts.slice(0, depth).join('.');
    const raw = NODES.get(at)?.on?.[event];
    if (raw) out.push({ at, list: Array.isArray(raw) ? raw : [raw] });
  }
  return out;
}

/** Whether `state` (or an ancestor) answers `event` at all, whatever the facts. */
export function handles(state: string, event: string): boolean {
  return handlers(state, event).length > 0;
}

/**
 * Fires one event. Returns where the card rests, or null when no transition is enabled: the event
 * is dropped and the card stays, which a scenario may or may not accept.
 */
export function fire(state: string, event: string, facts: Facts): Settled | null {
  for (const { list } of handlers(state, event)) {
    const taken = list.find((t) => holds(t.guard, facts));
    if (!taken) continue;
    // A transition to the state the card is already in does not re-enter it (XState v5's
    // default, `reenter: false`): its actions run, its exit and entry actions do not. That is how a
    // lane records something and stays put without starting its own work over.
    if (taken.target === state) return { state, actions: [...(taken.actions ?? [])], via: [state] };
    const exit = NODES.get(state)?.exit ?? [];
    return settle(taken.target, facts, [...exit, ...(taken.actions ?? [])]);
  }
  return null;
}

const KEY_OF = new Map(LANES.map((lane) => [lane.state, lane.key]));
const STATE_OF = new Map(LANES.map((lane) => [lane.key, lane.state]));

export const laneKey = (state: string): string => KEY_OF.get(state) ?? state;
export const laneState = (key: string): string => {
  const state = STATE_OF.get(key);
  if (!state) throw new Error(`no lane ${key}`);
  return state;
};

/**
 * Every lane a card can rest in one event after `from`, under any facts at all: each transition of
 * each handler taken in turn, its target settled under every way its transient states can resolve.
 * This is "is X to Y a legal move", which is what a recorded trace is checked against.
 */
export function successors(from: string, options: { ownEventsOnly?: boolean } = {}): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (state: string, event: string) => out.set(state, [...(out.get(state) ?? []), event]);
  const parts = from.split('.');
  // `ownEventsOnly` stops below the ticket: the lane's events and its phase's. The ticket-wide
  // events (a person's hold, a close, a run start) re-derive the lane from facts and so make nearly
  // any move legal, which is right for a board and useless for checking the moves a driver makes
  // on its own inside one run.
  const floor = options.ownEventsOnly ? 2 : 1;
  for (let depth = parts.length; depth >= floor; depth--) {
    const node = NODES.get(parts.slice(0, depth).join('.'));
    for (const [event, raw] of Object.entries(node?.on ?? {})) {
      for (const t of Array.isArray(raw) ? raw : [raw]) for (const rest of restingStates(t.target)) add(rest, event);
    }
  }
  return out;
}

/** Every resting state a target can settle into, over all facts. */
function restingStates(target: string, seen = new Set<string>()): string[] {
  if (seen.has(target)) return [];
  seen.add(target);
  const node = NODES.get(target);
  if (!node) return [];
  if (node.always) return node.always.flatMap((t) => restingStates(t.target, seen));
  if (node.states && node.initial) return restingStates(`${target}.${node.initial}`, seen);
  return [target];
}

/** A card walking the machine, with the lanes it has rested in and the actions it has run. */
export class Card {
  readonly lanes: string[] = [];
  readonly actions: string[] = [];
  constructor(
    readonly name: string,
    public state: string,
  ) {
    this.lanes.push(laneKey(state));
  }
  /** Fires an event; throws a Leak when nothing answers it, since a scenario only sends events it expects to matter. */
  send(event: string, facts: Facts = new Set()): this {
    const result = fire(this.state, event, facts);
    if (!result) throw new Leak(`${this.name} in ${laneKey(this.state)} dropped ${event}: no transition is enabled`);
    this.state = result.state;
    this.actions.push(...result.actions);
    this.lanes.push(laneKey(result.state));
    return this;
  }
  get lane(): string {
    return laneKey(this.state);
  }
}

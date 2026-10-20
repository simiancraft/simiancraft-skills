#!/usr/bin/env bun
/**
 * Print the burndown's state machine as an XState v5 `createMachine` call, for pasting into
 * https://stately.ai/viz or importing into a project that has xstate installed:
 *
 *   bun run <skill-dir>/export-machine.ts > burndown.machine.js
 *
 * The machine is `lib/machine.ts`; this only rewrites its absolute state paths into XState id
 * references (`#burndown.ticket.work.coding`) and gives each lane state a description the
 * visualizer shows on hover. Nothing here is read by the loop.
 */

import { MACHINE, type StateNode, type Transition } from './lib/machine.ts';

const ID = 'burndown';

function ref(target: string): string {
  return `#${ID}.${target}`;
}

function transition(t: Transition): Record<string, unknown> {
  const out: Record<string, unknown> = { target: ref(t.target) };
  if (t.guard) out.guard = t.guard;
  if (t.actions) out.actions = t.actions;
  return out;
}

function node(n: StateNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (n.type === 'parallel' || n.type === 'history' || n.type === 'final') out.type = n.type;
  if (n.lane) out.description = `${n.lane.key} ${n.lane.name}: ${n.lane.description}`;
  if (n.entry) out.entry = n.entry;
  if (n.exit) out.exit = n.exit;
  if (n.initial) out.initial = n.initial;
  if (n.always) out.always = n.always.map(transition);
  if (n.on) {
    out.on = Object.fromEntries(
      Object.entries(n.on).map(([event, list]) => [event, Array.isArray(list) ? list.map(transition) : transition(list)]),
    );
  }
  if (n.states) out.states = Object.fromEntries(Object.entries(n.states).map(([name, child]) => [name, node(child)]));
  return out;
}

const machine = { id: ID, ...node(MACHINE) };
console.log(`import { createMachine } from 'xstate';\n\nexport const burndown = createMachine(${JSON.stringify(machine, null, 2)});`);

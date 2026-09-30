#!/usr/bin/env bun
/**
 * Render the burndown's state machine as a Graphviz chart, one cluster per phase, so the shape
 * can be looked at rather than read:
 *
 *   bun run <skill-dir>/chart-machine.ts > burndown.dot && dot -Tsvg burndown.dot > burndown.svg
 *   bun run <skill-dir>/chart-machine.ts --phase carving   # one phase and its exits only
 *
 * Ticket-wide transitions (issue closed, a person's hold, a foreign claim, run start) are drawn
 * once from a single node rather than from every state, or they would bury the chart. The
 * reconcile state's always-transitions are drawn dashed. Nothing here is read by the loop.
 */

import { LANES, laneByKey, PHASES } from './lib/lanes.ts';
import { MACHINE, transitions, walk } from './lib/machine.ts';

const args = process.argv.slice(2);
const only = args.includes('--phase') ? args[args.indexOf('--phase') + 1] : undefined;

const COLORS: Record<string, string> = {
  GRAY: '#d0d7de', BLUE: '#b6e3ff', GREEN: '#aceebb', YELLOW: '#fae17d', ORANGE: '#ffd8b5', RED: '#ffcecb', PINK: '#ffc8e6', PURPLE: '#d8b9ff',
};

const phaseOf = (path: string): string | undefined => path.split('.')[1];
const lines: string[] = [];
lines.push('digraph burndown {');
lines.push('  rankdir=LR; fontname="Helvetica"; node [fontname="Helvetica", shape=box, style="rounded,filled"]; edge [fontname="Helvetica", fontsize=9];');

const phases = Object.keys(PHASES) as Array<keyof typeof PHASES>;
const phaseDirs: Record<string, string> = {
  appraisal: 'ticket.appraisal', ready: 'ticket.ready', carving: 'ticket.carving', work: 'ticket.work', review: 'ticket.review',
  landing: 'ticket.landing', waits: 'ticket.waits', 'dead-letters': 'ticket.deadLetters', human: 'ticket.human', terminal: 'ticket.terminal',
};
const keep = (path: string) => !only || path.startsWith(phaseDirs[only]) || path === 'ticket.reconcile';

for (const phase of phases) {
  const dir = phaseDirs[phase];
  const members = walk().filter(([path, node]) => path.startsWith(`${dir}.`) && node.lane && keep(path));
  if (members.length === 0) continue;
  lines.push(`  subgraph "cluster_${phase}" { label="${PHASES[phase].emoji} ${PHASES[phase].label}"; style="rounded"; color="gray50";`);
  for (const [path, node] of members) {
    const lane = laneByKey((node.lane as { key: string }).key);
    const entry = (node.entry ?? []).filter((a) => a !== 'moveCard').join('\\n');
    lines.push(`    "${path}" [label="${lane.key} ${lane.name}${entry ? `\\n${entry}` : ''}", fillcolor="${COLORS[PHASES[phase].color]}"];`);
  }
  lines.push('  }');
}
lines.push('  "ticket.reconcile" [label="reconcile", shape=diamond, fillcolor="#ffffff"];');
lines.push('  "ticket.offBoard" [label="off the board", shape=doublecircle, fillcolor="#ffffff"];');
lines.push('  "ticket-wide" [label="any ticket state", shape=plaintext, fillcolor="#ffffff"];');

for (const { from, event, transition } of transitions()) {
  if (from === 'line' || from.startsWith('line.')) continue;
  const source = from === 'ticket' ? 'ticket-wide' : from;
  if (!keep(source) && source !== 'ticket-wide') continue;
  if (only && !keep(transition.target) && source !== 'ticket-wide') {
    // an exit from the chosen phase into another: draw the target as a plain node
    lines.push(`  "${transition.target}" [label="${transition.target.replace('ticket.', '')}", fillcolor="#ffffff"];`);
  }
  if (only && source === 'ticket-wide' && !keep(transition.target)) continue;
  // In a phase chart the reconcile fan-out is drawn only where it lands inside the phase.
  if (only && source === 'ticket.reconcile' && !transition.target.startsWith(phaseDirs[only])) continue;
  const label = event === 'always' ? (transition.guard ?? '') : `${event}${transition.guard ? `\\n[${transition.guard}]` : ''}`;
  const style = event === 'always' ? ', style=dashed' : '';
  lines.push(`  "${source}" -> "${transition.target}" [label="${label}"${style}];`);
}
lines.push('}');
console.log(lines.join('\n'));

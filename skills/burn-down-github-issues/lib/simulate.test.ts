import { describe, expect, it } from 'bun:test';
import { LANES } from './lanes.ts';
import { MACHINE, transitions, walk } from './machine.ts';
import { atoms, fire, laneKey, laneState, Leak, settle, successors } from './simulate.ts';

/** Lane sequences the real driver wrote to its logs, per issue, from the runs on Ultrathin. */
const RECORDED: Array<{ run: string; issue: number; lanes: string }> = [
  { run: 'stage 1, one issue', issue: 3594, lanes: 'D1 E1 E2 F1 F3 F4 F5 T1' },
  { run: 'stage 2, loop', issue: 3609, lanes: 'D1 E1 E2 F1 F3 F4 F5 T1' },
  { run: 'stage 2, fix.ts, boundary park', issue: 3559, lanes: 'A1 D1 E1 E2 F1 H3' },
  { run: 'stage 3, boundary park', issue: 3590, lanes: 'D1 E1 E2 F1 H3' },
  { run: 'stage 3, base moved into the work', issue: 3593, lanes: 'D1 E1 E2 F1 F2 E1 E2 F1 F3 F4 F5 T1' },
  { run: 'stage 3, appraised then worked', issue: 3567, lanes: 'A2 B1 D1 E1 E2 F1 F3 F4 F5 T1' },
  { run: 'redrive from the review dead letters', issue: 3318, lanes: 'Q4 D4 E1 E2 F1 F2 E1 E2 F1 F3 F4 F5 T1' },
  { run: 'redrive from parked, base moved', issue: 3590, lanes: 'H3 F2 D4 E1 E2 F1 F3 F4 F5 T1' },
];

describe('the machine leaks no card', () => {
  it('settles every transition under the facts that enable it', () => {
    const leaks: string[] = [];
    for (const { from, event, transition } of transitions()) {
      const enabling = new Set(atoms(transition.guard));
      try {
        settle(transition.target, enabling);
      } catch (error) {
        if (error instanceof Leak) leaks.push(`${from} on ${event}: ${error.message}`);
        else throw error;
      }
    }
    expect(leaks).toEqual([]);
  });

  it('rests every card in a lane or the final state, never in a compound or transient state', () => {
    const lanes = new Set(LANES.map((l) => l.state));
    const strays: string[] = [];
    for (const { from, event, transition } of transitions()) {
      const rest = settle(transition.target, new Set(atoms(transition.guard))).state;
      if (!lanes.has(rest) && rest !== 'ticket.offBoard' && !rest.startsWith('line.')) strays.push(`${from} on ${event} rests in ${rest}`);
    }
    expect(strays).toEqual([]);
  });

  it('has no orphan lane: every lane is some lane\'s successor, or a reconcile placement', () => {
    const reached = new Set<string>();
    for (const lane of LANES) for (const next of successors(lane.state).keys()) reached.add(next);
    const orphans = LANES.filter((l) => !reached.has(l.state)).map((l) => l.key);
    expect(orphans).toEqual([]);
  });
});

describe('every event, in every lane, under every combination of facts', () => {
  const NODES = new Map(walk(MACHINE));
  // Facts a transient state reads while a target settles; tried all false and all true.
  const settling = [...NODES.values()].flatMap((node) => (node.always ?? []).flatMap((t) => atoms(t.guard)));
  /** The events a lane answers, itself or through an ancestor, with every fact their guards read. */
  const eventsOf = (state: string) => {
    const events = new Map<string, Set<string>>();
    const parts = state.split('.');
    for (let depth = parts.length; depth >= 1; depth--) {
      for (const [event, raw] of Object.entries(NODES.get(parts.slice(0, depth).join('.'))?.on ?? {})) {
        const names = events.get(event) ?? new Set<string>();
        for (const t of Array.isArray(raw) ? raw : [raw]) for (const name of atoms(t.guard)) names.add(name);
        events.set(event, names);
      }
    }
    return events;
  };
  const valuations = (names: string[]) => Array.from({ length: 1 << names.length }, (_, mask) => names.filter((_, i) => mask & (1 << i)));

  it('never leaks a card', () => {
    const leaks: string[] = [];
    let fired = 0;
    for (const lane of LANES) {
      for (const [event, names] of eventsOf(lane.state)) {
        for (const facts of valuations([...names])) {
          for (const extra of [[], settling]) {
            fired += 1;
            try {
              fire(lane.state, event, new Set([...facts, ...extra]));
            } catch (error) {
              if (!(error instanceof Leak)) throw error;
              leaks.push(`${lane.key} on ${event} [${facts.join(', ')}]: ${error.message}`);
            }
          }
        }
      }
    }
    expect(leaks).toEqual([]);
    expect(fired).toBeGreaterThan(2000);
  });

  it('never drops what a machine reports: a result or a failure always moves the card or rests it on purpose', () => {
    // A dispatch may be refused (the line is paused) and the card waits where it is. A report
    // may not: an agent's verdict, a gate's result, and a failure each have a last branch with no
    // guard, so an answer nobody anticipated is settled as a failure instead of stranding the card.
    const REPORTS = ['APPRAISED', 'CONFIRMED', 'KNIFE_VERDICT', 'CUT_DISPUTED', 'REVISITED', 'WORKER_VERDICT', 'REVIEWED', 'CAUGHT_UP', 'CHECKS', 'SMOKE', 'BASE_MOVED_WHILE_WAITING', 'TRIAGED', 'AGENT_FAILED'];
    const dropped: string[] = [];
    for (const lane of LANES) {
      for (const [event, names] of eventsOf(lane.state)) {
        if (!REPORTS.includes(event)) continue;
        for (const facts of valuations([...names])) {
          if (fire(lane.state, event, new Set(facts)) === null) dropped.push(`${lane.key} drops ${event} under [${facts.join(', ')}]`);
        }
      }
    }
    expect(dropped).toEqual([]);
  });
});

describe('the landing is single file and checks upstream', () => {
  const predecessors = (key: string) =>
    LANES.filter((l) => l.key !== key && successors(l.state, { ownEventsOnly: true }).has(laneState(key)))
      .map((l) => l.key)
      .sort();

  it('reaches Merging only from Checks pending or Smoke', () => {
    expect(predecessors('F5')).toEqual(['F3', 'F4']);
  });
  it('reaches Checks pending only from Approved or Catching up', () => {
    expect(predecessors('F3')).toEqual(['F1', 'F2']);
  });
  it('starts a review only from Ready for review, and only on a lane that holds the base', () => {
    expect(predecessors('E2')).toEqual(['E1']);
    expect(laneKey(fire(laneState('E1'), 'REVIEWER_DISPATCHED', new Set(['behindBase']))?.state ?? '')).toBe('F2');
    expect(laneKey(fire(laneState('E1'), 'REVIEWER_DISPATCHED', new Set())?.state ?? '')).toBe('E2');
  });
  it('never takes an approved card to the merge while it is behind the base', () => {
    expect(laneKey(fire(laneState('F1'), 'FRONT_OF_QUEUE', new Set(['behindBase']))?.state ?? '')).toBe('F2');
  });
});

describe('the driver only makes moves the machine allows', () => {
  for (const { run, issue, lanes } of RECORDED) {
    it(`#${issue}, ${run}: ${lanes}`, () => {
      const keys = lanes.split(' ');
      const illegal: string[] = [];
      for (let i = 0; i + 1 < keys.length; i++) {
        const next = successors(laneState(keys[i]), { ownEventsOnly: true });
        if (!next.has(laneState(keys[i + 1]))) illegal.push(`${keys[i]} -> ${keys[i + 1]}`);
      }
      expect(illegal).toEqual([]);
    });
  }
});

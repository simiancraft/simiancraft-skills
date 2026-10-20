import { describe, expect, it } from 'bun:test';
import { LANES } from './lanes.ts';
import { MACHINE, transitions, walk } from './machine.ts';

const states = new Map(walk());

describe('the machine and the lane table agree', () => {
  it('every lane key is unique across the machine, and no two lanes share a name', () => {
    const keys = LANES.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
    const names = LANES.map((l) => l.name);
    expect(new Set(names).size).toBe(names.length);
    expect(LANES.length).toBe(36);
  });

  it('every lane is exactly one leaf state', () => {
    const byLane = new Map<string, string[]>();
    for (const [path, node] of states) {
      if (!node.lane) continue;
      byLane.set(node.lane.key, [...(byLane.get(node.lane.key) ?? []), path]);
    }
    for (const lane of LANES) {
      expect(byLane.get(lane.key) ?? [], `lane ${lane.key} ${lane.name}`).toHaveLength(1);
    }
    for (const [lane, paths] of byLane) {
      expect(LANES.some((l) => l.key === lane), `state ${paths.join(', ')} names unknown lane ${lane}`).toBe(true);
    }
  });

  it('every leaf state under ticket is a lane, unless it is transient, history, or final', () => {
    for (const [path, node] of states) {
      if (!path.startsWith('ticket.')) continue;
      const leaf = !node.states || Object.keys(node.states).length === 0;
      if (!leaf) continue;
      if (node.type === 'transient' || node.type === 'history' || node.type === 'final') continue;
      expect(node.lane, `leaf ${path} has no lane`).toBeDefined();
    }
  });

  it('every transition target resolves to a state', () => {
    for (const { from, event, transition } of transitions()) {
      expect(states.has(transition.target), `${from} on ${event} targets ${transition.target}`).toBe(true);
    }
  });

  it('every lane state has a way out', () => {
    for (const [path, node] of states) {
      if (!node.lane) continue;
      expect(Object.keys(node.on ?? {}).length, `${path} has no transitions of its own`).toBeGreaterThan(0);
    }
  });

  it('every lane state is reachable from some transition or is the initial state of its phase', () => {
    const targets = new Set(transitions().map((t) => t.transition.target));
    for (const [path, node] of states) {
      if (!node.lane) continue;
      const parent = path.slice(0, path.lastIndexOf('.'));
      const initial = states.get(parent)?.initial;
      const isInitial = initial !== undefined && `${parent}.${initial}` === path;
      expect(targets.has(path) || isInitial, `${path} is never entered`).toBe(true);
    }
  });

  it('a guarded list ends in an unguarded fallback or the guards are exhaustive by construction', () => {
    // Every multi-transition list must end with an unguarded transition, so no event can fall
    // through silently. The one exception is APPRAISED, whose verdicts are a closed set the
    // pipeline already rejects outside of.
    for (const [path, node] of states) {
      for (const [event, list] of Object.entries(node.on ?? {})) {
        if (!Array.isArray(list) || event === 'APPRAISED' || event === 'KNIFE_VERDICT' || event === 'WORKER_VERDICT' || event === 'HOLD_ADDED_BY_PERSON') continue;
        expect(list[list.length - 1].guard, `${path} on ${event} can fall through`).toBeUndefined();
      }
    }
  });

  it('every lane can reach a terminal lane or a human lane, treating guards as optimistic edges', () => {
    // crucible's "cannot reach final" and SPIN's invalid end state; a guard only removes an edge at
    // run time, so a target reachable here is reachable in some run. Ticket-wide transitions
    // (issue closed, a person's hold) would make this vacuous, so they are excluded: the question
    // is whether the machine itself can finish a card.
    const edges = new Map<string, Set<string>>();
    for (const { from, transition } of transitions()) {
      if (from === 'ticket') continue;
      edges.set(from, (edges.get(from) ?? new Set()).add(transition.target));
    }
    const isEnd = (path: string) => path.startsWith('ticket.terminal.') || path.startsWith('ticket.human.');
    const onlyHuman: string[] = [];
    for (const [path, node] of states) {
      if (!node.lane || isEnd(path)) continue;
      const seen = new Set<string>();
      const queue = [path];
      let terminal = false;
      let human = false;
      while (queue.length) {
        const here = queue.shift() as string;
        if (seen.has(here)) continue;
        seen.add(here);
        if (here.startsWith('ticket.terminal.')) terminal = true;
        if (here.startsWith('ticket.human.')) human = true;
        for (const next of edges.get(here) ?? []) queue.push(next);
      }
      expect(terminal || human, `${path} reaches neither a terminal nor a human lane`).toBe(true);
      if (!terminal) onlyHuman.push(path);
    }
    // Known: the waits and dead letters can only leave through reconcile or a human lane; anything
    // else appearing here is a new dead end.
    expect(onlyHuman.filter((p) => !p.startsWith('ticket.waits.') && !p.startsWith('ticket.deadLetters.'))).toEqual([]);
  });

  it('no two transitions in one list share a guard', () => {
    // crucible's dead transition: the second of two identical guards can never be taken.
    for (const [path, node] of states) {
      const lists = [...Object.entries(node.on ?? {}).map(([e, l]) => [e, Array.isArray(l) ? l : [l]] as const), ['always', node.always ?? []] as const];
      for (const [event, list] of lists) {
        const guards = list.map((t) => t.guard ?? '(none)');
        expect(new Set(guards).size, `${path} on ${event} repeats a guard`).toBe(guards.length);
      }
    }
  });

  it('every counter guard has an unguarded sibling into a dead-letter or human lane', () => {
    // Step Functions MaxAttempts and SQS maxReceiveCount: a retry counter without a finite exit is
    // an unbounded retry, and Temporal's default of unlimited attempts is the defect to forbid.
    for (const [path, node] of states) {
      for (const [event, raw] of Object.entries(node.on ?? {})) {
        const list = Array.isArray(raw) ? raw : [raw];
        for (const t of list) {
          if (!t.guard?.includes('UnderCap')) continue;
          const fallback = list.find((o) => o.guard === undefined);
          expect(fallback, `${path} on ${event}: ${t.guard} has no unguarded sibling`).toBeDefined();
          const target = fallback?.target ?? '';
          expect(
            target.startsWith('ticket.deadLetters.') || target.startsWith('ticket.human.'),
            `${path} on ${event}: the cap fallback goes to ${target}, not a dead-letter or human lane`,
          ).toBe(true);
        }
      }
    }
  });

  it('every lane of every phase that runs a machine answers a machine failing, itself or through its phase', () => {
    // Step Functions: every Task can fail. A throw between two turns is a failure too, so this
    // asks it of every lane in the phase and not only of the states whose entry starts an agent.
    const answers = (path: string): boolean => {
      const parts = path.split('.');
      return parts.some((_, depth) => depth >= 1 && Object.keys(states.get(parts.slice(0, depth + 1).join('.'))?.on ?? {}).includes('AGENT_FAILED'));
    };
    const machinePhases = ['ticket.appraisal.', 'ticket.carving.', 'ticket.work.', 'ticket.review.', 'ticket.landing.', 'ticket.deadLetters.'];
    const silent = LANES.map((l) => l.state).filter((path) => machinePhases.some((phase) => path.startsWith(phase)) && !answers(path));
    expect(silent).toEqual([]);
  });

  it('no agent failure anywhere sends a card to a human lane', () => {
    const parked = transitions().filter(({ event, transition }) => event === 'AGENT_FAILED' && transition.target.startsWith('ticket.human.'));
    expect(parked.map(({ from }) => from)).toEqual([]);
  });

  it('dead-letter lanes exit only to their own phase, a human lane, or carving on re-classification', () => {
    // SQS redrive allow policy by queue: a dead letter goes back to its source or to a person.
    const own: Record<string, string> = { appraisal: 'ticket.appraisal.', carve: 'ticket.carving.', work: 'ticket.work.', review: 'ticket.review.', landing: 'ticket.landing.' };
    for (const { from, event, transition } of transitions()) {
      if (!from.startsWith('ticket.deadLetters.')) continue;
      const phase = from.split('.')[2];
      const ok =
        // A failed triage agent leaves the card where it rests: a machine failure is never a hold.
        (event === 'AGENT_FAILED' && transition.target === from) ||
        transition.target.startsWith(own[phase]) ||
        transition.target.startsWith('ticket.human.') ||
        // A person's redrive continues the pull request: catch up first, then the revision, or
        // re-derive from facts when there is no pull request to continue.
        (event === 'REDRIVEN' && ['ticket.landing.catchingUp', 'ticket.work.sentBack', 'ticket.reconcile'].includes(transition.target)) ||
        // Work with a pull request is carried on from the catch-up, never started over.
        (from === 'ticket.deadLetters.work' && ['ticket.carving.toCarve', 'ticket.landing.catchingUp'].includes(transition.target)) ||
        // A retried rejection is a revision, reached through the catch-up when the lane is behind.
        (from === 'ticket.deadLetters.review' && ['ticket.work.sentBack', 'ticket.landing.catchingUp'].includes(transition.target));
      expect(ok, `${from} on ${event} exits to ${transition.target}`).toBe(true);
    }
  });

  it('has no history states', () => {
    // Re-entering a state runs its entry actions, and most entry actions here start an agent.
    for (const [path, node] of states) expect(node.type, `${path} is a history state`).not.toBe('history');
  });

  it('only the three seams are guarded on the line', () => {
    const seams = transitions().filter((t) => t.transition.guard?.includes('lineActive'));
    const events = new Set(seams.map((t) => t.event));
    expect([...events].sort()).toEqual(['APPRAISER_DISPATCHED', 'DISPATCHED', 'FINGERPRINT_CHANGED', 'ALL_CHILDREN_CLOSED', 'KNIFE_DISPATCHED'].sort());
    expect(MACHINE.states?.line?.states?.paused).toBeDefined();
  });
});

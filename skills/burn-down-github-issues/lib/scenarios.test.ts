/**
 * Several cards against one moving base, run on the machine itself. The world here is the least
 * that makes the landing rules mean something: a base that is a list of landed change sets, and
 * per card the files it edits, the import closure its proof covers, and how much of the base its
 * lane holds. Every guard the landing uses is derived from that world, never asserted by hand, so
 * a scenario cannot pass by claiming a fact the world does not support.
 *
 * One invariant is checked at every merge in every scenario: nothing lands that lacks the base.
 */

import { describe, expect, it } from 'bun:test';
import { Card, laneState } from './simulate.ts';

const REFRESH_CAP = 2;
const GLOBAL = ['bun.lock'];

class World {
  readonly base: string[][] = [];
  readonly order: string[] = [];
}

class Work extends Card {
  holds = 0;
  verdict: 'none' | 'merge' | 'reject' = 'none';
  refreshes = 0;
  rounds = 0;
  attempts = 0;
  constructor(
    name: string,
    readonly world: World,
    readonly files: string[],
    /** Modules the change imports, beyond its own files. */
    readonly imports: string[] = [],
    lane = 'B1',
  ) {
    super(name, laneState(lane));
    this.holds = world.base.length;
  }
  private incoming(): string[] {
    return this.world.base.slice(this.holds).flat();
  }
  facts(extra: string[] = []): Set<string> {
    const incoming = this.incoming();
    const closure = new Set([...this.files, ...this.imports]);
    const facts = new Set<string>(extra);
    if (incoming.length > 0) facts.add('behindBase');
    if (!incoming.some((f) => closure.has(f) || GLOBAL.includes(f))) facts.add('movementOutsideClosure');
    if (!incoming.some((f) => this.files.includes(f))) facts.add('netChangeIntact');
    facts.add(this.verdict === 'merge' ? 'standingVerdictMerge' : this.verdict === 'reject' ? 'standingVerdictRejection' : 'noVerdictYet');
    if (this.refreshes < REFRESH_CAP) facts.add('refreshesUnderCap');
    if (this.rounds < 3) facts.add('reviewRoundsUnderCap');
    if (this.attempts < 3) facts.add('attemptsUnderCap');
    facts.add('lineActive');
    facts.add('noOpenPr');
    return facts;
  }
  conflicts(): boolean {
    return this.incoming().some((f) => this.files.includes(f));
  }

  /** Ready to a pull request awaiting review: dispatch, then the worker's verdict. */
  work(): this {
    this.send('DISPATCHED', this.facts());
    this.holds = this.world.base.length; // the lane is cut from the fetched base
    return this.send('WORKER_VERDICT', this.facts(['verdictFixed', 'readyPr']));
  }
  failWorker(): this {
    this.send('DISPATCHED', this.facts());
    this.attempts += 1;
    return this.send('AGENT_FAILED', this.facts());
  }
  /** The driver's catch-up: merge the base forward, then let the closure decide the cost. */
  private catchUp(): this {
    if (this.conflicts()) return this.send('CONFLICT');
    const facts = this.facts(); // judged before the merge, as the pipeline does
    if (!facts.has('movementOutsideClosure') || !facts.has('netChangeIntact')) this.refreshes += 1;
    this.holds = this.world.base.length;
    const was = this.verdict;
    this.send('CAUGHT_UP', facts);
    if (this.lane === 'E1' || this.lane === 'D2') this.verdict = was === 'reject' ? 'reject' : 'none';
    return this;
  }
  review(decision: 'merge' | 'reject'): this {
    this.send('REVIEWER_DISPATCHED', this.facts());
    // `lane` is a getter that `send` changes; read it through a call so the checker does not
    // narrow it to the loop's condition.
    const at = () => this.lane;
    while (at() === 'F2') {
      this.catchUp();
      if (at() === 'D2') this.send('PROOF_REACQUIRED');
      if (at() !== 'E1') return this;
      this.send('REVIEWER_DISPATCHED', this.facts());
    }
    this.verdict = decision;
    if (decision === 'reject') this.rounds += 1;
    return this.send('REVIEWED', this.facts(decision === 'merge' ? ['decisionMerge'] : []));
  }
  /** The pull master's turn; `whileWaiting` lands something else during the checks. */
  land(whileWaiting?: () => void): this {
    this.send('FRONT_OF_QUEUE', this.facts());
    for (;;) {
      if (this.lane === 'F2') this.catchUp();
      if (this.lane !== 'F3') return this;
      this.send('CHECKS', this.facts(['checksGreen', 'smokeConfigured']));
      this.send('SMOKE', this.facts(['smokePassed']));
      whileWaiting?.();
      whileWaiting = undefined;
      if (this.facts().has('behindBase')) {
        this.send('BASE_MOVED_WHILE_WAITING', this.facts());
        continue;
      }
      // The invariant: nothing lands that lacks the base.
      expect(this.holds, `${this.name} merges holding the whole base`).toBe(this.world.base.length);
      this.send('MERGED');
      this.world.base.push(this.files);
      this.world.order.push(this.name);
      return this;
    }
  }
}

describe('two cards, disjoint work', () => {
  it('the second catches up, keeps its approval, and lands without another review', () => {
    const world = new World();
    const a = new Work('A', world, ['app/a.ts']).work().review('merge');
    const b = new Work('B', world, ['app/b.ts']).work().review('merge');
    a.land();
    b.land();
    expect(a.lanes.join(' ')).toBe('B1 D1 E1 E2 F1 F3 F4 F5 T1');
    expect(b.lanes.join(' ')).toBe('B1 D1 E1 E2 F1 F2 F3 F4 F5 T1');
    expect(b.refreshes).toBe(0);
    expect(world.order).toEqual(['A', 'B']);
  });
});

describe('two cards, overlapping work', () => {
  it('A landing into a module B imports revokes B\'s approval: back to review, not to coding, no round spent', () => {
    const world = new World();
    const a = new Work('A', world, ['app/shared.ts']).work().review('merge');
    const b = new Work('B', world, ['app/b.ts'], ['app/shared.ts']).work().review('merge');
    a.land();
    b.land();
    expect(b.lane).toBe('E1');
    expect(b.lanes.join(' ')).toBe('B1 D1 E1 E2 F1 F2 E1');
    expect(b.rounds).toBe(0);
    expect(b.refreshes).toBe(1);
    b.review('merge').land();
    expect(b.lane).toBe('T1');
  });

  it('A landing into B\'s closure before B is reviewed revokes B\'s proof: back to proving, the closest lane', () => {
    const world = new World();
    const a = new Work('A', world, ['app/shared.ts']).work().review('merge');
    const b = new Work('B', world, ['app/b.ts'], ['app/shared.ts']).work();
    a.land();
    b.review('merge');
    expect(b.lanes.join(' ')).toBe('B1 D1 E1 F2 D2 E1 E2 F1');
    expect(b.lanes).not.toContain('D4');
    b.land();
    expect(b.lane).toBe('T1');
  });

  it('a lockfile landing invalidates everything in flight, whatever it imports', () => {
    const world = new World();
    const a = new Work('A', world, ['bun.lock']).work().review('merge');
    const b = new Work('B', world, ['app/b.ts']).work().review('merge');
    a.land();
    b.land();
    expect(b.lane).toBe('E1');
  });

  it('two cards editing the same file: the second is a landing dead letter, and a redrive catches it up first', () => {
    const world = new World();
    const a = new Work('A', world, ['app/same.ts']).work().review('merge');
    const b = new Work('B', world, ['app/same.ts']).work().review('merge');
    a.land();
    b.land();
    expect(b.lane).toBe('Q5');
    b.send('REDRIVEN', b.facts(['prExists']));
    expect(b.lane).toBe('F2');
  });
});

describe('A works, B fails', () => {
  it('B\'s failures never touch A, return B to Ready under the cap, and dead-letter it at the cap', () => {
    const world = new World();
    const a = new Work('A', world, ['app/a.ts']);
    const b = new Work('B', world, ['app/b.ts']);
    b.failWorker();
    expect(b.lane).toBe('B1');
    a.work().review('merge').land();
    b.failWorker();
    expect(b.lane).toBe('B1');
    b.failWorker();
    expect(b.lane).toBe('Q3');
    expect(a.lane).toBe('T1');
    // A person redrives B; there is no pull request, so the facts place it.
    b.send('REDRIVEN', new Set(['sizedWithinCeiling']));
    expect(b.lane).toBe('B1');
  });

  it('a rejection sends B back for a revision and spends a round, while A lands', () => {
    const world = new World();
    const a = new Work('A', world, ['app/a.ts']).work().review('merge');
    const b = new Work('B', world, ['app/b.ts']).work().review('reject');
    expect(b.lane).toBe('D4');
    expect(b.rounds).toBe(1);
    a.land();
    b.send('WORKER_VERDICT', b.facts(['verdictFixed', 'readyPr']));
    b.verdict = 'none';
    b.review('merge').land();
    expect(b.lanes.join(' ')).toBe('B1 D1 E1 E2 D4 E1 F2 E1 E2 F1 F3 F4 F5 T1');
  });
});

describe('single file at the end', () => {
  it('a merge that lands while B waits on its checks sends B to catch up again before it may merge', () => {
    const world = new World();
    const a = new Work('A', world, ['app/a.ts']).work().review('merge');
    const b = new Work('B', world, ['app/b.ts']).work().review('merge');
    b.land(() => a.land());
    expect(world.order).toEqual(['A', 'B']);
    expect(b.lanes.join(' ')).toBe('B1 D1 E1 E2 F1 F3 F4 F5 F2 F3 F4 F5 T1');
  });

  it('three cards land one after another, each holding everything before it', () => {
    const world = new World();
    const cards = ['a', 'b', 'c'].map((n) => new Work(n.toUpperCase(), world, [`app/${n}.ts`]).work().review('merge'));
    for (const card of cards) card.land();
    expect(world.order).toEqual(['A', 'B', 'C']);
    expect(cards.map((c) => c.lane)).toEqual(['T1', 'T1', 'T1']);
  });

  it('a base that keeps landing into B\'s closure dead-letters the landing at the refresh cap', () => {
    const world = new World();
    const b = new Work('B', world, ['app/b.ts'], ['app/shared.ts']).work().review('merge');
    for (let i = 0; i < REFRESH_CAP; i++) {
      world.base.push(['app/shared.ts']);
      b.land();
      expect(b.lane).toBe('E1');
      b.review('merge');
    }
    world.base.push(['app/shared.ts']);
    b.land();
    expect(b.lane).toBe('Q5');
  });
});

describe('a person steps in', () => {
  it('a hold added during review takes the card at once, and lifting it puts the card back with its pull request', () => {
    const world = new World();
    const b = new Work('B', world, ['app/b.ts']).work();
    b.send('REVIEWER_DISPATCHED', b.facts());
    b.send('HOLD_ADDED_BY_PERSON', new Set(['holdIsNeedsHuman']));
    expect(b.lane).toBe('H2');
    b.send('HOLD_REMOVED', new Set(['readyPr']));
    expect(b.lane).toBe('E1');
  });

  it('another run\'s claim moves the card to a wait, and its release re-derives the lane from facts', () => {
    const world = new World();
    const b = new Work('B', world, ['app/b.ts']);
    b.send('FOREIGN_CLAIM');
    expect(b.lane).toBe('W3');
    b.send('CLAIM_RELEASED', new Set(['sizedWithinCeiling']));
    expect(b.lane).toBe('B1');
  });
});

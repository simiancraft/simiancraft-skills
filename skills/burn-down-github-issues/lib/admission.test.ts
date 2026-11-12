import { describe, expect, it } from 'bun:test';
import { refillingPool } from '../../fix-github-issue/lib/pool.ts';
import { type AdmissionPlacement, createAdmission } from './admission.ts';

/**
 * A tracker small enough to read at a glance: issues with an optional size, blockers, and a state.
 * Placement follows the reconcile order the loop uses: a blocker not closed as completed waits (W1),
 * then no size is the Inbox (A1), over the ceiling is To carve (C1), otherwise Ready (B1).
 */
type Fake = { number: number; size?: number; blockers: number[]; closed?: 'COMPLETED' | 'NOT_PLANNED'; sizeOnAppraisal?: number; carveInto?: Fake[] };
type Issue = { number: number; blockedBy: { nodes: Array<{ number: number; state: string; stateReason: string | null }> } };
const CEILING = 5;

function world(fakes: Fake[], opts: { limit?: number; appraiseLimit?: number; lockHeld?: boolean } = {}) {
  const byNumber = new Map(fakes.map((f) => [f.number, f]));
  const lines: string[] = [];
  const worked: number[] = [];
  let stopping = false;
  const issueOf = (f: Fake): Issue => ({
    number: f.number,
    blockedBy: {
      nodes: f.blockers.map((b) => {
        const blocker = byNumber.get(b)!;
        return { number: b, state: blocker.closed ? 'CLOSED' : 'OPEN', stateReason: blocker.closed ?? null };
      }),
    },
  });
  const place = async (): Promise<AdmissionPlacement<Issue>> => {
    const placement: AdmissionPlacement<Issue> = new Map();
    for (const f of byNumber.values()) {
      if (f.closed) continue;
      const issue = issueOf(f);
      const lane = issue.blockedBy.nodes.some((b) => !(b.state === 'CLOSED' && b.stateReason === 'COMPLETED'))
        ? 'W1'
        : f.size === undefined
          ? 'A1'
          : f.size > CEILING
            ? 'C1'
            : 'B1';
      placement.set(f.number, { lane, why: lane, issue });
    }
    return placement;
  };
  const admission = createAdmission<Issue>({
    limit: opts.limit ?? 100,
    appraiseLimit: opts.appraiseLimit ?? 100,
    canAppraise: () => true,
    stopping: () => stopping,
    fetchBase: () => {},
    place,
    appraise: async (placement, skip, limit) => {
      if (opts.lockHeld) return null;
      const inbox = [...placement.values()].filter(({ lane, issue }) => lane === 'A1' && !skip(issue)).slice(0, limit);
      for (const { issue } of inbox) {
        const f = byNumber.get(issue.number)!;
        f.size = f.sizeOnAppraisal ?? 3;
        // An oversized card goes to the knife, whose children arrive unsized.
        if (f.size > CEILING) for (const child of f.carveInto ?? []) byNumber.set(child.number, { ...child });
      }
      return inbox.map(({ issue }) => issue.number);
    },
    select: (placement) => [...placement.values()].filter(({ lane }) => lane === 'B1').map(({ issue }) => issue).sort((a, b) => a.number - b.number),
    log: (line) => lines.push(line),
  });
  /** Runs the work phase as the loop does: the start batch, then the pool refilled by admission. */
  const run = async (work: (n: number) => void = (n) => (byNumber.get(n)!.closed = 'COMPLETED')) => {
    const first = (await place()).values();
    const batch = [...first].filter(({ lane }) => lane === 'B1').map(({ issue }) => issue).slice(0, opts.limit ?? 100);
    admission.start(batch.map((i) => i.number));
    await refillingPool(batch, 2, async (issue) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      worked.push(issue.number);
      work(issue.number);
    }, admission.admit);
  };
  return { run, worked, lines, admission, stop: () => (stopping = true), fakes: byNumber };
}

describe('mid-run admission', () => {
  it('works a dependent in the run that merged its blocker', async () => {
    const w = world([{ number: 1, size: 3, blockers: [] }, { number: 2, size: 3, blockers: [1] }]);
    await w.run();
    expect(w.worked).toEqual([1, 2]);
    expect(w.lines.some((l) => l.startsWith('#2  admitted mid-run'))).toBe(true);
  });

  it('appraises an unsized dependent once its blocker closes, then works it', async () => {
    const w = world([{ number: 1, size: 3, blockers: [] }, { number: 2, blockers: [1] }]);
    await w.run();
    expect(w.worked).toEqual([1, 2]);
    expect([...w.admission.appraised]).toEqual([2]);
  });

  it('leaves a freed dependent over the ceiling for the knife', async () => {
    const w = world([{ number: 1, size: 3, blockers: [] }, { number: 2, blockers: [1], sizeOnAppraisal: 8 }]);
    await w.run();
    expect(w.worked).toEqual([1]);
    expect(w.fakes.get(2)!.size).toBe(8);
  });

  it('sizes and works what the knife carved out of a freed card, two levels down, before the run ends', async () => {
    const grandchild = { number: 20, blockers: [] };
    const child = { number: 10, blockers: [], sizeOnAppraisal: 8, carveInto: [grandchild] };
    // No sibling settles after the carving, so only the refill's own repeated sizing reaches #20.
    const w = world([{ number: 1, size: 3, blockers: [] }, { number: 2, blockers: [1], sizeOnAppraisal: 8, carveInto: [child] }]);
    await w.run();
    expect(w.worked).toEqual([1, 20]);
    expect([...w.admission.appraised].sort((a, b) => a - b)).toEqual([2, 10, 20]);
  });

  it('frees a dependent only when every blocker has closed', async () => {
    const w = world([
      { number: 1, size: 3, blockers: [] },
      { number: 2, size: 3, blockers: [] },
      { number: 3, size: 3, blockers: [1, 2] },
    ]);
    await w.run();
    expect(w.worked.slice(0, 2).sort()).toEqual([1, 2]);
    expect(w.worked).toHaveLength(3);
    expect(w.worked[2]).toBe(3);
  });

  it('works a chain in one run, and counts every admission against the limit', async () => {
    const chain = () => [1, 2, 3, 4, 5].map((n) => ({ number: n, size: 3, blockers: n === 1 ? [] : [n - 1] }));
    const all = world(chain());
    await all.run();
    expect(all.worked).toEqual([1, 2, 3, 4, 5]);
    const limited = world(chain(), { limit: 2 });
    await limited.run();
    expect(limited.worked).toEqual([1, 2]);
  });

  it('does not take an issue again when its lane settled without closing it', async () => {
    const w = world([{ number: 1, size: 3, blockers: [] }]);
    await w.run(() => {}); // a busy claim or a failed worker: the issue stays open and Ready
    expect(w.worked).toEqual([1]);
  });

  it('says once that a dependent waits on a blocker closed not planned, and does not admit it', async () => {
    const w = world([{ number: 1, size: 3, blockers: [] }, { number: 2, size: 3, blockers: [1] }]);
    await w.run((n) => (w.fakes.get(n)!.closed = 'NOT_PLANNED'));
    expect(w.worked).toEqual([1]);
    expect(w.lines.filter((l) => l.startsWith('#2  waits on #1, closed without completing'))).toHaveLength(1);
  });

  it('sizes nothing mid-run while another process holds the appraisal lock', async () => {
    const w = world([{ number: 1, size: 3, blockers: [] }, { number: 2, blockers: [1] }], { lockHeld: true });
    await w.run();
    expect(w.worked).toEqual([1]);
    expect(w.lines.some((l) => l.includes('the appraisal lock is held elsewhere'))).toBe(true);
  });

  it('keeps one appraisal budget across the run', async () => {
    const w = world(
      [{ number: 1, size: 3, blockers: [] }, { number: 2, blockers: [1] }, { number: 3, blockers: [1] }],
      { appraiseLimit: 1 },
    );
    await w.run();
    expect(w.admission.appraised.size).toBe(1);
    expect(w.worked).toHaveLength(2);
  });

  it('admits nothing once the run is stopping', async () => {
    const w = world([{ number: 1, size: 3, blockers: [] }, { number: 2, size: 3, blockers: [1] }]);
    await w.run((n) => {
      w.fakes.get(n)!.closed = 'COMPLETED';
      w.stop();
    });
    expect(w.worked).toEqual([1]);
  });
});

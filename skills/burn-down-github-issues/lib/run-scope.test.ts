import '../../../test/no-real-gh.preload.ts';
import { describe, expect, it, spyOn } from 'bun:test';
import { RunScope } from './run-scope.ts';
import { Carving } from './carving.ts';
import { placeByFacts } from './board-writer.ts';
import { selectForAppraisal } from '../../appraise-github-issues/lib/appraise.ts';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import { CARVE_DEFAULTS } from '../../carve-github-issue/lib/carve.ts';
import { readTree } from '../../carve-github-issue/lib/tree.ts';
import { refusal } from '../../carve-github-issue/lib/claims.ts';
import type { Context } from '../../fix-github-issue/lib/context.ts';

// Children precede their parents, and a selected leaf belongs to an unrelated tree.
function tree() {
  return new FakeTracker('bot', [
    fakeIssue(12, { parentNumber: 11 }),
    fakeIssue(11, { parentNumber: 10, subIssues: [12], labels: [{ name: 'size: 8' }] }),
    fakeIssue(13, { parentNumber: 10, labels: [{ name: 'needs-human' }] }),
    fakeIssue(14, { parentNumber: 10, labels: [{ name: 'size: 2' }], blockedBy: { nodes: [{ number: 20, state: 'OPEN', stateReason: null }] } }),
    fakeIssue(10, { subIssues: [11, 13, 14], labels: [{ name: 'size: 8' }] }),
    fakeIssue(21, { parentNumber: 20 }),
    fakeIssue(22, { parentNumber: 20 }),
    fakeIssue(20, { subIssues: [21, 22], labels: [{ name: 'size: 8' }] }),
  ]);
}
const facts = (io: FakeTracker) => [...io.issues.keys()].map(n => io.view(n)!);
const numbers = (items: { number: number }[]) => items.map(i => i.number).sort((a, b) => a - b);

describe('restricted descendant scope', () => {
  it('retains roots, deduplicates refreshes, and admits new descendants independently of ordering', () => {
    const io = tree();
    const roots = new Set([10, 21]);
    const scope = new RunScope(roots);
    const shared = scope.effective;
    roots.add(20);
    expect(scope.refresh(facts(io)).sort((a, b) => a - b)).toEqual([11, 12, 13, 14]);
    expect([...scope.roots!]).toEqual([10, 21]);
    expect(scope.refresh(facts(io))).toEqual([]);
    io.issues.set(15, fakeIssue(15, { parentNumber: 12 }));
    io.issues.set(23, fakeIssue(23, { parentNumber: 22 }));
    expect(scope.refresh(facts(io))).toEqual([15]);
    expect(scope.refresh(facts(io).reverse())).toEqual([]);
    expect(scope.effective).toBe(shared);
    expect([...shared!].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14, 15, 21]);
  });

  it('terminates on cycles and does not admit disconnected cycles', () => {
    const scope = new RunScope([1]);
    expect(scope.refresh([{ number: 1, parent: { number: 2 } }, { number: 2, parent: { number: 1 } }, { number: 3, parent: { number: 4 } }, { number: 4, parent: { number: 3 } }])).toEqual([2]);
  });

  it('leaves unrestricted mode and its age filter unchanged', () => {
    const scope = new RunScope(null);
    expect(scope.refresh(facts(tree()))).toEqual([]);
    expect(scope.roots).toBeNull();
    expect(scope.effective).toBeNull();
    const old = [{ number: 30, title: 'old', labels: [], createdAt: '2000-01-01' }];
    expect(selectForAppraisal(old, { ageDays: 1, skipLabels: [] }, { allAges: scope.effective !== null })).toEqual([]);
  });

  it('shares placement and appraisal membership without lifting holds or dependencies', () => {
    const io = tree();
    const scope = new RunScope([10, 21]);
    scope.refresh(facts(io));
    const scoped = facts(io).filter(i => scope.effective!.has(i.number));
    expect(numbers(scoped)).toEqual([10, 11, 12, 13, 14, 21]);
    const placement = scoped.map(issue => ({ issue, ...placeByFacts({
      state: 'OPEN', labels: issue.labels.map(l => l.name), pulls: [], ceiling: 3,
      points: issue.number === 14 ? 2 : undefined,
      openChildren: issue.subIssuesSummary!.total > issue.subIssuesSummary!.completed,
      blocked: Boolean(issue.blockedBy?.nodes.length),
    }) }));
    const inbox = placement.filter(p => p.lane === 'A1').map(p => p.issue);
    expect(numbers(selectForAppraisal(inbox, { ageDays: 1, skipLabels: ['needs-human'] }, { allAges: scope.effective !== null }))).toEqual([12, 21]);
    expect(placement.find(p => p.issue.number === 13)!.lane).toBe('H2');
    expect(placement.find(p => p.issue.number === 14)!.lane).not.toBe('B1');
    const ctx = { botLogin: 'bot' } as Context;
    expect(refusal(readTree(ctx, 13, io), 3)).toContain('needs-human');
    expect(refusal(readTree(ctx, 14, io), 3)).toContain('blocked by #20');
  });

  it('uses the shared effective set in the real carving sweep', async () => {
    const io = tree();
    const scope = new RunScope([10, 21]);
    const ctx = { botLogin: 'bot', runId: 'scope-test', io, dryRun: true } as unknown as Context;
    const driver = new Carving({
      ctx, only: scope.effective, ageDays: 1,
      knobs: { ...CARVE_DEFAULTS, ceiling: 3, callbacksDir: '', seats: { carver: { engine: 'fixture' }, confirmer: { engine: 'fixture2' } } },
      appraisal: { seats: { appraiser: { engine: 'fixture' }, confirmer: { engine: 'fixture2' } }, confirmCloses: true, skipLabels: [], maxAppraiseAttempts: 1, sizeCallbackTimeoutMinutes: 1 },
      mark: () => {}, log: () => {},
    });
    const visits: number[] = [];
    const visit = spyOn(driver, 'revisit').mockImplementation(async n => { visits.push(n); });
    try {
      scope.refresh(facts(io));
      await driver.sweep(facts(io));
      expect(visits.sort((a, b) => a - b)).toEqual([10, 11]);
      expect(io.writes).toEqual([]);
    } finally { visit.mockRestore(); }
  });
});

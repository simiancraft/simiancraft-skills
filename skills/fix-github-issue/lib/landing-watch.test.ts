import { describe, expect, it } from 'bun:test';
import { classify, type CheckNode, landingWatch, watchArgv } from './landing-watch.ts';

/** A pull request whose view the test sets between polls, on a clock the test owns. */
function pullRequest(view: { state?: string; headRefOid: string; statusCheckRollup: CheckNode[] | null }) {
  let clock = 0;
  const asked: string[][] = [];
  const io = { now: () => clock, read: (argv: string[]) => (asked.push(argv), JSON.stringify(view)) };
  return { io, asked, view, tick: (ms: number) => (clock += ms) };
}

describe('the landing watch', () => {
  it('reads the state, the head, and the checks in one read', () => {
    const p = pullRequest({ state: 'OPEN', headRefOid: 'abc', statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }] });
    const seen = landingWatch(7, p.io).observe();
    expect(p.asked).toEqual([watchArgv(7)]);
    expect(seen).toMatchObject({ state: 'OPEN', head: 'abc', checks: [{ name: 'build', status: 'passed', verdict: 'SUCCESS', queued: false, firstSeen: 0 }] });
  });

  it('reads a merged or closed pull request as such, and a view with no state as open', () => {
    expect(landingWatch(1, pullRequest({ state: 'MERGED', headRefOid: 'a', statusCheckRollup: [] }).io).observe().state).toBe('MERGED');
    expect(landingWatch(1, pullRequest({ state: 'CLOSED', headRefOid: 'a', statusCheckRollup: [] }).io).observe().state).toBe('CLOSED');
    expect(landingWatch(1, pullRequest({ headRefOid: 'a', statusCheckRollup: null }).io).observe()).toMatchObject({ state: 'OPEN', checks: [] });
  });

  it('keeps when it first saw each check across polls, and dates a check that registers later by its own sighting', () => {
    const p = pullRequest({ headRefOid: 'a', statusCheckRollup: [{ name: 'build', status: 'QUEUED', conclusion: '' }] });
    const watch = landingWatch(1, p.io);
    watch.observe();
    p.tick(60_000);
    p.view.statusCheckRollup = [{ name: 'build', status: 'IN_PROGRESS', conclusion: '' }, { name: 'lint', conclusion: 'SUCCESS' }];
    const seen = watch.observe();
    expect(seen.checks.map((c) => [c.name, c.firstSeen])).toEqual([['build', 0], ['lint', 60_000]]);
  });

  it('tells two runs of one name apart by their details link', () => {
    const p = pullRequest({ headRefOid: 'a', statusCheckRollup: [{ name: 'build', conclusion: 'FAILURE', detailsUrl: 'https://ci.example/1' }] });
    const watch = landingWatch(1, p.io);
    watch.observe();
    p.tick(5_000);
    p.view.statusCheckRollup = [{ name: 'build', status: 'QUEUED', conclusion: '', detailsUrl: 'https://ci.example/2' }, { name: 'build', conclusion: 'FAILURE', detailsUrl: 'https://ci.example/1' }];
    expect(watch.observe().checks.map((c) => c.firstSeen)).toEqual([5_000, 0]);
  });

  it('calls a check run queued only before its provider starts it, and never a commit status', () => {
    const watch = landingWatch(1, pullRequest({
      headRefOid: 'a',
      statusCheckRollup: [
        { name: 'preview', status: 'QUEUED', conclusion: '', detailsUrl: 'https://deploy.example/run/1' },
        { name: 'tests', status: 'IN_PROGRESS', conclusion: '', workflowName: 'CI' },
        { context: 'legacy', state: 'PENDING', targetUrl: 'https://legacy.example/x' },
      ],
    }).io);
    expect(watch.observe().checks.map((c) => [c.name, c.queued, c.provider])).toEqual([
      ['preview', true, 'deploy.example'],
      ['tests', false, 'CI'],
      ['legacy', false, 'legacy.example'],
    ]);
  });

  it('orders runs by completion, else start, else first sighting', () => {
    const watch = landingWatch(1, pullRequest({
      headRefOid: 'a',
      statusCheckRollup: [
        { name: 'a', conclusion: 'SUCCESS', startedAt: '2026-11-21T10:00:00Z', completedAt: '2026-11-21T10:05:00Z' },
        { name: 'b', status: 'IN_PROGRESS', conclusion: '', startedAt: '2026-11-21T10:01:00Z', completedAt: '0001-01-01T00:00:00Z' },
        { name: 'c', status: 'QUEUED', conclusion: '' },
      ],
    }).io);
    expect(watch.observe().checks.map((c) => c.at)).toEqual([Date.parse('2026-11-21T10:05:00Z'), Date.parse('2026-11-21T10:01:00Z'), 0]);
  });

  it('classifies a node as the checks wait always has', () => {
    expect(classify({ conclusion: '', status: 'IN_PROGRESS' })).toBe('pending');
    expect(classify({})).toBe('pending');
    expect(classify({ conclusion: 'NEUTRAL' })).toBe('passed');
    expect(classify({ conclusion: 'SKIPPED' })).toBe('skipped');
    expect(classify({ conclusion: 'CANCELLED' })).toBe('cancelled');
    expect(classify({ conclusion: 'TIMED_OUT' })).toBe('failed');
    expect(classify({ state: 'ERROR' })).toBe('failed');
  });
});

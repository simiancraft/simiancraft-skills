import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import { readTree } from '../../carve-github-issue/lib/tree.ts';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import { appraiseIssue, refusedAsTrunk, validateAppraisal } from './appraise.ts';

const treeOf = (labels: string[]) => {
  const io = new FakeTracker('loop-bot', [fakeIssue(1, { labels: labels.map((name) => ({ name })) })]);
  return readTree({ botLogin: 'loop-bot', runId: 'host-1-1', io } as unknown as Context, 1, io);
};

describe('the trunk gate an appraisal asks at every step', () => {
  it('refuses a released trunk, unless the burndown asked for its release appraisal', () => {
    expect(refusedAsTrunk(treeOf(['loop/released']), undefined)).toBe(true);
    expect(refusedAsTrunk(treeOf(['loop/released']), true)).toBe(false);
  });
  it('never refuses a leaf', () => {
    expect(refusedAsTrunk(treeOf(['bug']), undefined)).toBe(false);
    expect(refusedAsTrunk(treeOf(['bug']), true)).toBe(false);
  });
});

describe('the engines an appraisal requires', () => {
  const ctx = () => ({ botLogin: 'loop-bot', runId: 'host-1-1', io: new FakeTracker('loop-bot', [fakeIssue(1)]), log: () => {}, dryRun: true }) as unknown as Context;
  const seats = { appraiser: { engine: 'claude' }, confirmer: { engine: 'claude' } } as const;
  const run = (confirmCloses: boolean) =>
    appraiseIssue(ctx(), { number: 1, title: 't', createdAt: '2026-09-01T00:00:00Z', labels: [] } as never, { ageDays: null, seats, confirmCloses, skipLabels: [] }).then(
      () => '',
      (error: Error) => error.message,
    );
  it('refuses one engine in both seats when closes are confirmed', async () => {
    expect(await run(true)).toMatch(/must be different engines/);
  });
  it('does not care which engine the confirmer is when closes are not confirmed', async () => {
    expect(await run(false)).not.toMatch(/must be different engines/);
  });
});

describe('an appraisal that closes the issue', () => {
  const base = { issue: 7, reason: 'the spike measured 0.1 ms; nothing remains', closeComment: 'Nothing to do.' };

  it("reads the scale's zero on a closing verdict as no size, not a malformed answer", () => {
    const answer = validateAppraisal({ ...base, verdict: 'obsolete', points: 0 }, 7);
    expect(answer.ok).toBe(true);
    if (answer.ok) expect(answer.result.points).toBeUndefined();
  });

  it('still refuses a zero size on work it calls valid', () => {
    const answer = validateAppraisal({ ...base, verdict: 'valid', points: 0 }, 7);
    expect(answer.ok).toBe(false);
  });

  it('still refuses a negative size on any verdict', () => {
    expect(validateAppraisal({ ...base, verdict: 'already-fixed', points: -1 }, 7).ok).toBe(false);
  });
});

describe('the base an appraisal judges against', () => {
  let scratch: string;
  let checkout: string;
  let elsewhere: string;
  const git = (cwd: string, ...args: string[]) => {
    const run = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
    return run.stdout.toString().trim();
  };
  const commit = (cwd: string, name: string) => {
    writeFileSync(join(cwd, name), `${name}\n`);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-q', '-m', name);
    git(cwd, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    return git(cwd, 'rev-parse', 'HEAD');
  };

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'appraise-base-'));
    git(scratch, 'init', '-q', '--bare', '-b', 'main', join(scratch, 'origin.git'));
    checkout = join(scratch, 'checkout');
    elsewhere = join(scratch, 'elsewhere');
    git(scratch, 'clone', '-q', join(scratch, 'origin.git'), elsewhere);
    commit(elsewhere, 'one');
    git(scratch, 'clone', '-q', join(scratch, 'origin.git'), checkout);
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const appraise = (remote: string, lines: string[]) => {
    const ctx = {
      botLogin: 'loop-bot',
      runId: 'host-1-1',
      io: new FakeTracker('loop-bot', [fakeIssue(1)]),
      log: (m: string) => lines.push(m),
      dryRun: true,
      repoRoot: checkout,
      runDir: join(scratch, 'run'),
      promptsDirs: [join(import.meta.dir, '..', 'prompts')],
      project: { name: 'p', remote, baseBranch: 'main', repo: 'o/r', evidenceBranch: 'e', checkCommand: 'c', installCommand: 'i', sizingScale: 's', portBase: 0, portSpan: 0, sharedServices: [], conventionDocs: [] },
    } as unknown as Context;
    const seats = { appraiser: { engine: 'codex' }, confirmer: { engine: 'claude' } } as never;
    return appraiseIssue(ctx, { number: 1, title: 't', createdAt: '2026-09-01T00:00:00Z', labels: [] } as never, { ageDays: null, seats, confirmCloses: true, skipLabels: [] });
  };

  it('is fetched before the appraiser runs, so a merge that landed since the last fetch is seen', async () => {
    const merged = commit(elsewhere, 'two');
    expect(git(checkout, 'rev-parse', 'origin/main')).not.toBe(merged);
    await appraise('origin', []);
    expect(git(checkout, 'rev-parse', 'origin/main')).toBe(merged);
  });

  it('does not fail the appraisal when the fetch fails, and says so', async () => {
    const lines: string[] = [];
    const outcome = await appraise('no-such-remote', lines);
    expect(outcome.reason).toBe('dry run; no appraiser ran');
    expect(lines.some((line) => line.includes('fetch of the base failed'))).toBe(true);
  });
});

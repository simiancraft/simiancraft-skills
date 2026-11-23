import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appraiseIssue } from '../../appraise-github-issues/lib/appraise.ts';
import { CARVE_DEFAULTS, type CarveKnobs } from '../../carve-github-issue/lib/carve.ts';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import { carveIssue } from '../../carve-github-issue/lib/knife.ts';
import { refuseEnvironmentFault, runAgent } from './agent.ts';
import type { ProjectConfig } from './config.ts';
import { createContext } from './context.ts';
import { REVIEW_FILE } from './control-files.ts';
import { EnvironmentFault, environmentFaultOf, faultMarker, hostFaultIn, rememberFaultMarkers } from './environment-fault.ts';
import { weighHold } from './panel.ts';
import { move, recordThrow } from './pipeline.ts';

const HERE = import.meta.dir;
let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'environment-fault-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const PROJECT = { name: 'Test', repo: 'o/host', remote: 'origin', baseBranch: 'main', evidenceBranch: 'evidence', checkCommand: 'true', installCommand: 'true', conventionDocs: [], sizingScale: 'fib', sharedServices: [], portBase: 9000, portSpan: 10, pathAliases: [], sourceExtensions: ['.ts'], alwaysInvalidates: [], touchPaths: { migration: [], ci: [] }, worktreeRoot: 'wt' } as ProjectConfig;
const DISK_FULL = 'echo "ENOSPC: no space left on device, write" >&2; exit 1\n';

function context(lines: string[], io: FakeTracker, onHostFault?: (reason: string) => void) {
  return createContext({
    project: PROJECT,
    knobs: { autoMerge: 'never', maxReviewRounds: 3, checksTimeoutMinutes: 1, smokeTimeoutMinutes: 1 },
    seats: { worker: { engine: 'fixture', model: join(scratch, 'verdict.json') }, reviewer: { engine: 'fixture2', model: join(scratch, 'review.json') } },
    repoRoot: scratch,
    invokeRoot: scratch,
    promptsDirs: [join(HERE, '..', 'prompts'), join(HERE, '..', '..', 'appraise-github-issues', 'prompts'), join(HERE, '..', '..', 'carve-github-issue', 'prompts')],
    dryRun: false,
    runDir: join(scratch, 'runs'),
    botLogin: 'loop-bot',
    io,
    onHostFault,
    log: (m) => lines.push(m),
    step: () => {},
  });
}

let files = 0;
/** A fixture seat whose answer is `answer`; with `script`, its `<role>` turn runs that lane work after copying it. */
function seat(engine: 'fixture' | 'fixture2', answer: unknown, role?: string, script?: string) {
  const base = join(scratch, `seat-${files++}`);
  writeFileSync(`${base}.json`, JSON.stringify(answer));
  if (role && script) writeFileSync(`${base}.${role}.sh`, script);
  return { engine, model: `${base}.json` };
}

const labelsOf = (io: FakeTracker, n: number) => io.view(n)!.labels.map((l) => l.name);

describe('an environment fault', () => {
  it('is read from an errno code or the text a command prints for it', () => {
    expect(hostFaultIn('fatal: write error: No space left on device')).toBe('ENOSPC');
    expect(hostFaultIn('Error: ENOSPC: no space left on device, write')).toBe('ENOSPC');
    expect(hostFaultIn('bash: fork: Cannot allocate memory')).toBe('ENOMEM');
    expect(hostFaultIn('spawn ENOMEM')).toBe('ENOMEM');
    expect(hostFaultIn('the reviewer found the checks red')).toBeNull();
  });
  it('is read from a thrown error by its type, its errno code, or its message', () => {
    expect(environmentFaultOf(new EnvironmentFault({ kind: 'stopped', signal: 'SIGINT' }, 'coder', 'stopped'))).toEqual({ kind: 'stopped', signal: 'SIGINT', role: 'coder' });
    expect(environmentFaultOf(Object.assign(new Error('write failed'), { code: 'ENOSPC' }))).toEqual({ kind: 'ENOSPC' });
    expect(environmentFaultOf(new Error('git push failed: fatal: No space left on device'))).toEqual({ kind: 'ENOSPC' });
    expect(environmentFaultOf(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBeNull();
  });
});

describe('a seat whose run fails on the host', () => {
  it('is marked with the fault, asked once, its answer cleared, and refused by the seat', async () => {
    const answer = join(scratch, 'review.json');
    writeFileSync(answer, JSON.stringify({ pr: 1, decision: 'block', blocking: ['nothing'], adequacy: 'n/a' }));
    // The tail also names an upstream refusal, which on its own would earn a retry.
    writeFileSync(join(scratch, 'review.reviewer.sh'), `echo "rate limit" >&2; ${DISK_FULL}`);
    const cwd = join(scratch, 'wt', 'issue-7');
    mkdirSync(cwd, { recursive: true });
    const lines: string[] = [];
    const run = await runAgent(context(lines, new FakeTracker('loop-bot')), 'reviewer', 7, cwd, { engine: 'fixture2', model: answer }, 'prompt');
    expect(run.exitCode).toBe(1);
    expect(run.fault).toEqual({ kind: 'ENOSPC', role: 'reviewer' });
    expect(existsSync(join(cwd, REVIEW_FILE))).toBe(false);
    expect(lines.filter((l) => /running reviewer/.test(l))).toHaveLength(1);
    expect(lines.some((l) => /host fault \(ENOSPC\)/.test(l))).toBe(true);
    expect(() => refuseEnvironmentFault(run, 'reviewer', 7)).toThrow(EnvironmentFault);
  });
  it('leaves an ordinary failure alone', () => {
    expect(refuseEnvironmentFault({ logPath: 'x', exitCode: 1 }, 'reviewer', 7).exitCode).toBe(1);
  });
});

describe('a fix lane that ends on an environment fault', () => {
  const diskFull = () => new EnvironmentFault({ kind: 'ENOSPC' }, 'reviewer', 'reviewer on #8 ended on a host fault (ENOSPC)');

  it('the first time: judges nothing, marks the free fault, keeps the card, and pauses the line', () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(8, { labels: [{ name: 'size: 1' }] })]);
    const paused: string[] = [];
    const lanes: string[] = [];
    const ctx = context([], io, (reason) => paused.push(reason));
    ctx.onLane = (event) => lanes.push(event.lane);
    const issue = { number: 8, title: 'a fix under review', labels: [{ name: 'size: 1' }], createdAt: '2026-01-01T00:00:00Z' };
    move(ctx, issue, 'E2', 'round 1');
    const recorded = recordThrow(ctx, issue, diskFull(), () => {}, 3);
    expect(recorded.outcome.outcome).toBe('unjudged');
    expect(recorded.outcome.fault).toBe('ENOSPC');
    expect(labelsOf(io, 8)).toEqual(['size: 1', faultMarker('ENOSPC', 'reviewer')]);
    expect(lanes).toEqual(['E2']);
    expect(paused).toHaveLength(1);
    expect(paused[0]).toContain('ENOSPC');
    expect(paused[0]).toContain('E2');
  });

  it('again on its rerun: the work reproduced the fault, so it is charged as an ordinary failure', () => {
    const marked = [{ name: 'size: 1' }, { name: faultMarker('ENOSPC') }];
    const io = new FakeTracker('loop-bot', [fakeIssue(18, { labels: marked })]);
    const paused: string[] = [];
    const ctx = context([], io, (reason) => paused.push(reason));
    const issue = { number: 18, title: 'a fix under review', labels: marked, createdAt: '2026-01-01T00:00:00Z' };
    move(ctx, issue, 'E2', 'round 1');
    const writes: string[] = [];
    io.beforeWrite = (op) => {
      writes.push(op.argv.join(' '));
    };
    const recorded = recordThrow(ctx, issue, diskFull(), () => {}, 3);
    expect(recorded.outcome.outcome).not.toBe('unjudged');
    expect(recorded.outcome.reason).toContain('reproduced');
    expect(labelsOf(io, 18)).not.toContain(faultMarker('ENOSPC'));
    // Settled as a review that failed: the review dead letter, with the reason that it reproduced the fault.
    expect(writes.some((w) => w.includes('--add-label loop/dlq: review'))).toBe(true);
    // The host is still out of disk, charged or not, so the line is paused either way.
    expect(paused).toHaveLength(1);
  });

  it('after a seat runs cleanly, the same code again is a new occasion and free again', async () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(60, { labels: [{ name: 'size: 1' }] })]);
    const ctx = context([], io);
    const issue = { number: 60, title: 'a fix under review', labels: [{ name: 'size: 1' }], createdAt: '2026-01-01T00:00:00Z' };
    expect(recordThrow(ctx, issue, diskFull(), () => {}, 3).outcome.outcome).toBe('unjudged');
    expect(labelsOf(io, 60)).toContain(faultMarker('ENOSPC', 'reviewer'));

    // The rerun gets past the faulted point: a seat for the issue finishes without a fault.
    const answer = join(scratch, 'clean-review.json');
    writeFileSync(answer, JSON.stringify({ pr: 1, decision: 'merge', blocking: [], adequacy: 'n/a' }));
    const cwd = join(scratch, 'wt', 'issue-60');
    mkdirSync(cwd, { recursive: true });
    expect((await runAgent(ctx, 'reviewer', 60, cwd, { engine: 'fixture2', model: answer }, 'prompt')).exitCode).toBe(0);
    expect(labelsOf(io, 60)).not.toContain(faultMarker('ENOSPC', 'reviewer'));

    // A snapshot read before the clear still shows the marker; what the run knows outranks it.
    const stale = { ...issue, labels: [{ name: 'size: 1' }, { name: faultMarker('ENOSPC', 'reviewer') }] };
    expect(recordThrow(ctx, stale, diskFull(), () => {}, 3).outcome.outcome).toBe('unjudged');
    expect(labelsOf(io, 60)).toContain(faultMarker('ENOSPC', 'reviewer'));
  }, 20_000);

  /** Runs `role` cleanly for `issue`, as the seat would on a rerun that gets past its fault. */
  async function cleanRun(ctx: ReturnType<typeof context>, role: string, issue: number) {
    const answer = join(scratch, `clean-${role}-${issue}.json`);
    writeFileSync(answer, JSON.stringify({ pr: 1, decision: 'merge', blocking: [], adequacy: 'n/a' }));
    const cwd = join(scratch, 'wt', `issue-${issue}-${role}`);
    mkdirSync(cwd, { recursive: true });
    expect((await runAgent(ctx, role, issue, cwd, { engine: 'fixture2', model: answer }, 'prompt')).exitCode).toBe(0);
  }
  const proverDiskFull = (issue: number) => new EnvironmentFault({ kind: 'ENOSPC' }, 'prover', `prover on #${issue} ended on a host fault (ENOSPC)`);

  it("another seat's clean run leaves the marker, so the prover's repeat is charged", async () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(61, { labels: [{ name: 'size: 1' }] })]);
    const ctx = context([], io);
    const issue = { number: 61, title: 'a fix being proved', labels: [{ name: 'size: 1' }], createdAt: '2026-01-01T00:00:00Z' };
    expect(recordThrow(ctx, issue, proverDiskFull(61), () => {}).outcome.outcome).toBe('unjudged');
    expect(labelsOf(io, 61)).toContain(faultMarker('ENOSPC', 'prover'));

    await cleanRun(ctx, 'coder', 61);
    expect(labelsOf(io, 61)).toContain(faultMarker('ENOSPC', 'prover'));

    const again = recordThrow(ctx, issue, proverDiskFull(61), () => {});
    expect(again.outcome.outcome).not.toBe('unjudged');
    expect(again.outcome.reason).toContain('reproduced');
    expect(labelsOf(io, 61)).not.toContain(faultMarker('ENOSPC', 'prover'));
  }, 20_000);

  it("the faulted seat's own clean run clears the marker, so its next fault is free", async () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(62, { labels: [{ name: 'size: 1' }] })]);
    const ctx = context([], io);
    const issue = { number: 62, title: 'a fix being proved', labels: [{ name: 'size: 1' }], createdAt: '2026-01-01T00:00:00Z' };
    expect(recordThrow(ctx, issue, proverDiskFull(62), () => {}).outcome.outcome).toBe('unjudged');

    await cleanRun(ctx, 'prover', 62);
    expect(labelsOf(io, 62)).not.toContain(faultMarker('ENOSPC', 'prover'));

    expect(recordThrow(ctx, issue, proverDiskFull(62), () => {}).outcome.outcome).toBe('unjudged');
    expect(labelsOf(io, 62)).toContain(faultMarker('ENOSPC', 'prover'));
  }, 20_000);

  it('a marker that names no seat, as written before markers named one, is cleared by any clean seat', async () => {
    const legacy = [{ name: 'size: 1' }, { name: faultMarker('ENOSPC') }];
    const io = new FakeTracker('loop-bot', [fakeIssue(63, { labels: legacy })]);
    const ctx = context([], io);
    rememberFaultMarkers(ctx, 63, legacy);
    await cleanRun(ctx, 'coder', 63);
    expect(labelsOf(io, 63)).toEqual(['size: 1']);
  }, 20_000);

  it('a different kind of host fault on the rerun is free again', () => {
    const marked = [{ name: 'size: 1' }, { name: faultMarker('ENOSPC') }];
    const io = new FakeTracker('loop-bot', [fakeIssue(19, { labels: marked })]);
    const ctx = context([], io);
    const issue = { number: 19, title: 'a fix at work', labels: marked, createdAt: '2026-01-01T00:00:00Z' };
    move(ctx, issue, 'D2');
    const recorded = recordThrow(ctx, issue, new Error('git worktree add failed: fatal: Cannot allocate memory'), () => {});
    expect(recorded.outcome.outcome).toBe('unjudged');
    expect(labelsOf(io, 19)).toContain(faultMarker('ENOMEM'));
  });

  it("from a person's stop: judges nothing, marks nothing, and does not pause the line, however often", () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(9, { labels: [{ name: 'size: 1' }] })]);
    const paused: string[] = [];
    const ctx = context([], io, (reason) => paused.push(reason));
    const issue = { number: 9, title: 'a fix at work', labels: [{ name: 'size: 1' }], createdAt: '2026-01-01T00:00:00Z' };
    for (let n = 0; n < 2; n++) {
      move(ctx, issue, 'D2');
      const recorded = recordThrow(ctx, issue, new EnvironmentFault({ kind: 'stopped', signal: 'SIGINT' }, 'coder', 'coder on #9 was stopped'), () => {});
      expect(recorded.outcome.outcome).toBe('unjudged');
      expect(recorded.outcome.fault).toBe('stopped');
    }
    expect(io.writes).toHaveLength(0);
    expect(paused).toHaveLength(0);
  });
});

describe('an appraiser that fails on the host', () => {
  const options = (appraiser: { engine: 'fixture'; model: string }) => ({ ageDays: null, seats: { appraiser, confirmer: { engine: 'fixture2' as const } }, confirmCloses: false, skipLabels: [], maxAppraiseAttempts: 3 });
  const valid = { issue: 30, verdict: 'valid', points: 1, reason: 'small' };

  it('counts no appraisal and marks the free fault; the same fault on the rerun is counted', async () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(30)]);
    const ctx = context([], io);
    const appraiser = seat('fixture', valid, 'appraiser', DISK_FULL) as { engine: 'fixture'; model: string };
    const issue = { number: 30, title: 'issue 30', createdAt: '2026-09-01T00:00:00Z', labels: [] as Array<{ name: string }> };
    const first = await appraiseIssue(ctx, issue, options(appraiser));
    expect(first.unjudged).toBe(true);
    expect(first.retry).toBe(true);
    expect(labelsOf(io, 30)).toEqual([faultMarker('ENOSPC', 'appraiser')]);

    const rerun = await appraiseIssue(ctx, { ...issue, labels: io.view(30)!.labels }, options(appraiser));
    expect(rerun.unjudged).toBeUndefined();
    expect(rerun.reason).toContain('reproduced');
    expect(labelsOf(io, 30)).toEqual(['loop/appraisals: 1']);
  }, 20_000);
});

describe('a carver that fails on the host', () => {
  it('counts no carve and marks the free fault; the same fault on the rerun is counted', async () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(40, { title: '[t] big', body: 'Criteria: A1 A2', labels: [{ name: 'size: 8' }] })]);
    const ctx = context([], io);
    const carver = seat('fixture', {}, 'carver', DISK_FULL);
    const knobs: CarveKnobs = { ceiling: 2, ...CARVE_DEFAULTS, callbacksDir: join(scratch, 'callbacks'), seats: { carver, confirmer: { engine: 'fixture2', model: carver.model } } };
    const issue = { number: 40, title: '[t] big', createdAt: '2026-09-01T00:00:00Z', labels: [{ name: 'size: 8' }] };
    await expect(carveIssue(ctx, issue, knobs, io)).rejects.toThrow(EnvironmentFault);
    expect(labelsOf(io, 40)).toContain(faultMarker('ENOSPC', 'carver'));
    expect(labelsOf(io, 40).some((l) => l.startsWith('loop/carves:'))).toBe(false);

    await expect(carveIssue(ctx, issue, knobs, io)).rejects.toThrow(EnvironmentFault);
    expect(labelsOf(io, 40)).toContain('loop/carves: 1');
    expect(labelsOf(io, 40)).not.toContain(faultMarker('ENOSPC', 'carver'));
  }, 20_000);
});

describe('a decision panel whose seat fails on the host', () => {
  it('writes no hold, gives its round back, and passes the fault on to the seat that raised the question', async () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(50, { labels: [{ name: 'loop/panels: 1' }] })]);
    const ctx = context([], io);
    const questions = { issue: 50, questions: [{ id: 'Q1', text: 'Which?' }] };
    const raiser = seat('fixture', { issue: 50, answers: [], review: 'r' });
    writeFileSync(raiser.model.replace(/\.json$/, '.panel-framer.json'), JSON.stringify(questions));
    const others = [seat('fixture2', {}, 'panelist', DISK_FULL), seat('fixture', { issue: 50, answers: [], review: 'r' })];
    ctx.panel = { seats: others, maxPanels: 3, effort: 'high' };
    const request = { issue: 50, title: 'issue 50', question: 'Which?', raiser };
    await expect(weighHold(ctx, request, { reachable: () => true, readAtBase: () => null })).rejects.toThrow(EnvironmentFault);
    expect(labelsOf(io, 50).sort()).toEqual(['loop/panels: 1']);
    expect(io.view(50)!.comments.some((c) => c.body.includes('outcome=hold'))).toBe(false);
  }, 20_000);
});

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import { assertNoHostError, runAgent } from './agent.ts';
import type { ProjectConfig } from './config.ts';
import { createContext } from './context.ts';
import { REVIEW_FILE } from './control-files.ts';
import { HostError, hostErrorIn, hostErrorOf } from './host-error.ts';
import { move, recordThrow } from './pipeline.ts';

const HERE = import.meta.dir;
let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'host-error-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const PROJECT = { name: 'Test', repo: 'o/host', remote: 'origin', baseBranch: 'main', evidenceBranch: 'evidence', checkCommand: 'true', installCommand: 'true', conventionDocs: [], sizingScale: 'fib', sharedServices: [], portBase: 9000, portSpan: 10, pathAliases: [], sourceExtensions: ['.ts'], alwaysInvalidates: [], touchPaths: { migration: [], ci: [] }, worktreeRoot: 'wt' } as ProjectConfig;

function context(lines: string[], io: FakeTracker, onHostError?: (reason: string) => void) {
  return createContext({
    project: PROJECT,
    knobs: { autoMerge: 'never', maxReviewRounds: 3, checksTimeoutMinutes: 1, smokeTimeoutMinutes: 1 },
    seats: { worker: { engine: 'fixture', model: join(scratch, 'verdict.json') }, reviewer: { engine: 'fixture2', model: join(scratch, 'review.json') } },
    repoRoot: scratch,
    invokeRoot: scratch,
    promptsDirs: [join(HERE, '..', 'prompts')],
    dryRun: false,
    runDir: join(scratch, 'runs'),
    botLogin: 'loop-bot',
    io,
    onHostError,
    log: (m) => lines.push(m),
    step: () => {},
  });
}

describe('a host error', () => {
  it('is read from an errno code or the text a command prints for it', () => {
    expect(hostErrorIn('fatal: write error: No space left on device')).toBe('ENOSPC');
    expect(hostErrorIn('Error: ENOSPC: no space left on device, write')).toBe('ENOSPC');
    expect(hostErrorIn('bash: fork: Cannot allocate memory')).toBe('ENOMEM');
    expect(hostErrorIn('spawn ENOMEM')).toBe('ENOMEM');
    expect(hostErrorIn('the reviewer found the checks red')).toBeNull();
  });
  it('is read from a thrown error by its type, its errno code, or its message', () => {
    expect(hostErrorOf(new HostError('ENOMEM', 'reviewer failed'))).toBe('ENOMEM');
    expect(hostErrorOf(Object.assign(new Error('write failed'), { code: 'ENOSPC' }))).toBe('ENOSPC');
    expect(hostErrorOf(new Error('git push failed: fatal: No space left on device'))).toBe('ENOSPC');
    expect(hostErrorOf(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBeNull();
  });
});

describe('a seat that fails on the host', () => {
  it('is marked a host error, asked once, its answer cleared, and thrown by the pipeline seats', async () => {
    const answer = join(scratch, 'review.json');
    writeFileSync(answer, JSON.stringify({ pr: 1, decision: 'block', blocking: ['nothing'], adequacy: 'n/a' }));
    // The fixture copies its answer, then the lane work fails the way a full disk does. The tail
    // also names an upstream refusal, which on its own would earn a retry.
    writeFileSync(join(scratch, 'review.reviewer.sh'), 'echo "rate limit" >&2; echo "ENOSPC: no space left on device, write" >&2; exit 1\n');
    const cwd = join(scratch, 'wt', 'issue-7');
    mkdirSync(cwd, { recursive: true });
    const lines: string[] = [];
    const run = await runAgent(context(lines, new FakeTracker('loop-bot')), 'reviewer', 7, cwd, { engine: 'fixture2', model: answer }, 'prompt');
    expect(run.exitCode).toBe(1);
    expect(run.hostError).toBe('ENOSPC');
    expect(existsSync(join(cwd, REVIEW_FILE))).toBe(false);
    expect(lines.filter((l) => /running reviewer/.test(l))).toHaveLength(1);
    expect(lines.some((l) => /host error \(ENOSPC\)/.test(l))).toBe(true);
    expect(() => assertNoHostError(run, 'reviewer', 7)).toThrow(HostError);
  });
  it('leaves an ordinary failure alone', () => {
    expect(assertNoHostError({ logPath: 'x', exitCode: 1 }, 'reviewer', 7).exitCode).toBe(1);
  });
});

describe('a lane that throws a host error', () => {
  it('in review writes nothing on the issue, keeps the card and the lane, and asks the driver to pause the line', () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(8, { labels: [{ name: 'size: 1' }] })]);
    const lines: string[] = [];
    const paused: string[] = [];
    const lanes: string[] = [];
    const ctx = context(lines, io, (reason) => paused.push(reason));
    ctx.onLane = (event) => lanes.push(event.lane);
    const issue = { number: 8, title: 'a fix under review', labels: [], createdAt: '2026-01-01T00:00:00Z' };
    move(ctx, issue, 'E2', 'round 1');
    const recorded = recordThrow(ctx, issue, new HostError('ENOSPC', 'reviewer on #8 failed on the host (ENOSPC)'), (m) => lines.push(m), 3);
    expect(recorded.outcome.outcome).toBe('paused');
    expect(recorded.keepLane).toBe(true);
    expect(io.writes).toHaveLength(0);
    expect(lanes).toEqual(['E2']);
    expect(paused).toHaveLength(1);
    expect(paused[0]).toContain('ENOSPC');
    expect(paused[0]).toContain('E2');
  });
  it('from a command the driver ran is the same, and a driver with no line is only told nothing', () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(9, { labels: [{ name: 'size: 1' }] })]);
    const ctx = context([], io);
    const issue = { number: 9, title: 'a fix at work', labels: [], createdAt: '2026-01-01T00:00:00Z' };
    move(ctx, issue, 'D2');
    const recorded = recordThrow(ctx, issue, new Error('git worktree add failed: fatal: Cannot allocate memory'), () => {});
    expect(recorded.outcome.outcome).toBe('paused');
    expect(recorded.keepLane).toBe(true);
    expect(io.writes).toHaveLength(0);
  });
});

import { describe, expect, it } from 'bun:test';
import { claimMarker } from '../../carve-github-issue/lib/claims.ts';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import { liveClaim, readTree } from '../../carve-github-issue/lib/tree.ts';
import type { ProjectConfig } from './config.ts';
import { type Context, createContext } from './context.ts';
import { claimLane } from './pipeline.ts';
import { mutate } from './shell.ts';

const PROJECT = { name: 'Test', repo: 'o/claim-lane', remote: 'origin', baseBranch: 'main', evidenceBranch: 'evidence', checkCommand: 'true', installCommand: 'true', conventionDocs: [], sizingScale: 'fib', sharedServices: [], portBase: 9000, portSpan: 10, pathAliases: [], sourceExtensions: ['.ts'], alwaysInvalidates: [], touchPaths: { migration: [], ci: [] }, worktreeRoot: 'wt' } as ProjectConfig;

function context(io: FakeTracker, lines: string[] = []): Context {
  return createContext({
    project: PROJECT,
    knobs: { autoMerge: 'never', maxReviewRounds: 3, checksTimeoutMinutes: 1, smokeTimeoutMinutes: 1 },
    seats: { worker: { engine: 'fixture', model: 'unused' }, reviewer: { engine: 'fixture2' } },
    repoRoot: process.cwd(),
    invokeRoot: process.cwd(),
    promptsDirs: [],
    dryRun: false,
    runDir: process.cwd(),
    botLogin: 'loop-bot',
    io,
    log: (m) => lines.push(m),
    step: () => {},
  });
}

const labels = (io: FakeTracker, n: number) => io.view(n)?.labels.map((l) => l.name) ?? [];
const unlabel = (ctx: Context, n: number, name: string) => mutate(ctx, `lift ${name} on #${n}`, ['gh', 'issue', 'edit', String(n), '--remove-label', name]);

describe('claimLane with a lift', () => {
  it('lifts the hold only under its own claim, so a reader never finds the issue with neither', async () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(5, { labels: [{ name: 'loop/dlq: work' }] })]);
    const ctx = context(io);
    // What a starting run would see after every write: a hold, a live claim, or both.
    const unguarded: string[] = [];
    io.beforeWrite = (op) => {
      const tree = readTree(ctx, 5, io);
      const held = tree.issue.labels.some((l) => l.name === 'loop/dlq: work');
      if (!held && !liveClaim(tree, new Date().toISOString(), 'a-starting-run')) unguarded.push(op.description);
    };
    let seenAtLift = null as { held: boolean; claimed: string | undefined } | null;
    const handle = await claimLane(ctx, io, 5, 3, () => {}, () => {
      const tree = readTree(ctx, 5, io);
      seenAtLift = { held: labels(io, 5).includes('loop/dlq: work'), claimed: liveClaim(tree, new Date().toISOString(), 'a-starting-run')?.runId };
      unlabel(ctx, 5, 'loop/dlq: work');
    });
    io.beforeWrite = null;
    if ('outcome' in handle) throw new Error(`expected a claim, got ${handle.outcome}`);
    expect(seenAtLift).toEqual({ held: true, claimed: ctx.runId });
    expect(unguarded).toEqual([]);
    expect(labels(io, 5)).toEqual(['loop/working']);
    handle.release();
  });

  it('lifts nothing when another run holds the issue', async () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(6, { labels: [{ name: 'loop/dlq: work' }] })]);
    io.comment(6, 'loop-bot', claimMarker('working', 'elsewhere', '2026-11-01T00:00:00Z', '2999-01-01T00:00:00Z', 'tok'));
    const ctx = context(io);
    let lifted = false;
    const outcome = await claimLane(ctx, io, 6, 3, () => {}, () => {
      lifted = true;
    });
    expect(outcome).toEqual({ outcome: 'busy', reason: 'another run holds this issue' });
    expect(lifted).toBe(false);
    expect(labels(io, 6)).toEqual(['loop/dlq: work']);
  });

  it('releases its claim when a hold the lift left still refuses the issue', async () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(7, { labels: [{ name: 'loop/dlq: work' }, { name: 'needs-human' }] })]);
    const lines: string[] = [];
    const ctx = context(io, lines);
    const outcome = await claimLane(ctx, io, 7, 3, (m) => lines.push(m), () => unlabel(ctx, 7, 'loop/dlq: work'));
    expect(outcome).toEqual({ outcome: 'left-alone', reason: 'it carries needs-human' });
    expect(labels(io, 7)).toEqual(['needs-human']);
    expect(liveClaim(readTree(ctx, 7, io), new Date().toISOString(), 'a-starting-run')).toBeNull();
  });

  it('releases its claim when the lift throws', async () => {
    const io = new FakeTracker('loop-bot', [fakeIssue(8, { labels: [{ name: 'loop/parked' }] })]);
    const ctx = context(io);
    const failure = new Error('label write refused');
    await expect(claimLane(ctx, io, 8, 3, () => {}, () => {
      throw failure;
    })).rejects.toBe(failure);
    expect(labels(io, 8)).toEqual(['loop/parked']);
    expect(liveClaim(readTree(ctx, 8, io), new Date().toISOString(), 'a-starting-run')).toBeNull();
  });
});

it('claimLane without a lift claims nothing for an issue the gate refuses', async () => {
  const io = new FakeTracker('loop-bot', [fakeIssue(9, { labels: [{ name: 'loop/parked' }] })]);
  const outcome = await claimLane(context(io), io, 9, 3, () => {});
  expect(outcome).toEqual({ outcome: 'left-alone', reason: 'it carries loop/parked' });
  expect(io.writes).toEqual([]);
});

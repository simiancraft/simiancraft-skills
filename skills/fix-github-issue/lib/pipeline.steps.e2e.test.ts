import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import type { ProjectConfig } from './config.ts';
import { createContext } from './context.ts';
import { ENGINES } from './engines.ts';
import { fixIssue } from './pipeline.ts';
import { newestStep } from './steps.ts';

/**
 * The work turn for real: a bare remote, a clone the lanes are cut from, a tracker, a stub `gh`,
 * and an agent that really commits and pushes. Nothing here is a dry run, which is where the
 * split's recovery defects were found.
 */
const BOT = 'loop-bot';
const HERE = import.meta.dir;
let scratch: string;
let repo: string;
let agentLog: string;
const originalCommand = ENGINES.fixture.command;
const spawnSync = Bun.spawnSync;

const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
};

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'steps-e2e-'));
  const origin = join(scratch, 'origin.git');
  repo = join(scratch, 'repo');
  agentLog = join(scratch, 'agent.log');
  git(scratch, 'init', '-q', '--bare', '-b', 'main', origin);
  git(scratch, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'one');
  git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');

  // No pull request exists in any of these runs, and gh is asked only that. The suite's preload
  // refuses every real `gh` process, and stays in force: for this file alone a `gh` call is sent to
  // a stub under its own name, which answers `pr list` and fails loudly on anything else.
  const stub = join(scratch, 'gh-stub');
  writeFileSync(stub, '#!/bin/sh\ncase "$1 $2" in "pr list") echo "[]";; *) echo "gh-stub: unexpected $*" >&2; exit 1;; esac\n');
  chmodSync(stub, 0o755);
  Bun.spawnSync = ((first: string[] | { cmd: string[] }, ...rest: unknown[]) => {
    const argv = Array.isArray(first) ? first : first.cmd;
    const sent = argv[0] === 'gh' ? [stub, ...argv.slice(1)] : argv;
    return (spawnSync as (...args: unknown[]) => unknown)(Array.isArray(first) ? sent : { ...first, cmd: sent }, ...rest);
  }) as typeof Bun.spawnSync;

  // The agent: a coder that commits, pushes, and reports the head it pushed; a prover that hands off.
  const agent = join(scratch, 'agent.ts');
  writeFileSync(
    agent,
    `import { appendFileSync, writeFileSync } from 'node:fs';
const [cwd, issue] = process.argv.slice(2);
const role = process.env.LOOP_ROLE ?? '';
const git = (...args: string[]) => { const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };
appendFileSync(${JSON.stringify(agentLog)}, role + ' on ' + git('rev-parse', '--abbrev-ref', 'HEAD') + '\\n');
if (role.startsWith('worker')) {
  if (git('rev-parse', '--abbrev-ref', 'HEAD') === 'HEAD') git('switch', '-q', '-c', 'fix/change-' + issue);
  writeFileSync(cwd + '/change-' + Date.now() + '.txt', 'work\\n');
  git('add', '.'); git('commit', '-q', '-m', 'fix: the change');
  git('push', '-q', '-u', 'origin', 'HEAD');
  const sha = git('rev-parse', 'HEAD');
  writeFileSync(cwd + '/loop-verdict.json', JSON.stringify({ issue: Number(issue), verdict: 'coded', reason: 'done', branch: 'fix/change-' + issue, sha, gated: sha, handoff: 'Exercise: cat the new file.', touches: ['code', 'data'] }));
} else {
  writeFileSync(cwd + '/loop-verdict.json', JSON.stringify({ issue: Number(issue), verdict: process.env.E2E_PROVER ?? 'needs-human', reason: 'the proof needs a production account' }));
}
`,
  );
  (ENGINES.fixture as { command: typeof originalCommand }).command = (cwd, _prompt, model) => ['bun', agent, cwd, model ?? ''];
});

afterAll(() => {
  (ENGINES.fixture as { command: typeof originalCommand }).command = originalCommand;
  Bun.spawnSync = spawnSync;
  rmSync(scratch, { recursive: true, force: true });
});

const PROJECT = { name: 'Test', repo: 'o/e2e', remote: 'origin', baseBranch: 'main', evidenceBranch: 'evidence', checkCommand: 'true', installCommand: 'true', conventionDocs: [], sizingScale: 'fib', sharedServices: [], portBase: 9000, portSpan: 10, pathAliases: [], sourceExtensions: ['.ts'], alwaysInvalidates: [], touchPaths: { migration: [], ci: [] }, worktreeRoot: '../wt' } as ProjectConfig;

function context(io: FakeTracker, issue: number, runId: string) {
  const lines: string[] = [];
  const lanes: string[] = [];
  const ctx = createContext({
    project: PROJECT,
    knobs: { autoMerge: 'never', maxReviewRounds: 3, checksTimeoutMinutes: 1, smokeTimeoutMinutes: 1 },
    seats: { worker: { engine: 'fixture', model: String(issue) }, reviewer: { engine: 'fixture2' } },
    repoRoot: repo,
    invokeRoot: repo,
    promptsDirs: [join(HERE, '..', 'prompts')],
    dryRun: false,
    runDir: join(scratch, `runs-${runId}`),
    botLogin: BOT,
    io,
    log: (m) => lines.push(m),
    step: () => {},
  });
  ctx.runId = runId;
  ctx.onLane = (e) => lanes.push(e.lane);
  return { ctx, lines, lanes };
}

const ISSUE = (n: number) => ({ number: n, title: 't', createdAt: '2026-09-01T00:00:00Z', labels: [{ name: 'size: 1' }] });
const roles = () => readFileSync(agentLog, 'utf8').trim().split('\n').filter(Boolean);

describe('the work turn against a real remote and a tracker', () => {
  it('codes, announces the head it has seen on the remote, catches up, and proves', async () => {
    writeFileSync(agentLog, '');
    const io = new FakeTracker(BOT, [fakeIssue(61, { labels: [{ name: 'size: 1' }] })]);
    const { ctx, lanes } = context(io, 61, 'host-1-1');
    const outcome = await fixIssue(ctx, ISSUE(61), { maxPoints: 2 });
    expect(outcome.outcome).toBe('handed-off');
    expect(roles()).toEqual(['worker on HEAD', 'prover on fix/change-61']);
    expect(lanes.slice(0, 2)).toEqual(['D1', 'D2']);
    const marker = newestStep(io.view(61)!.comments, BOT, 'coded');
    // The announced head is the one the remote branch holds, and the coder's warning rides with it.
    expect(marker?.sha).toBe(git(repo, 'ls-remote', 'origin', 'refs/heads/fix/change-61').split(/\s+/)[0]);
    expect(marker?.touches).toEqual(['code', 'data']);
    expect(marker?.handoff).toBe('Exercise: cat the new file.');
  }, 60_000);

  it('resumes at Prove when a later run takes an issue an earlier one coded, and does not code it again', async () => {
    // Run one codes and announces, and its prover dies without a word: the lane is gone, the branch
    // and the marker are not. The base moves on meanwhile, as it does after any other landing.
    writeFileSync(agentLog, '');
    const io = new FakeTracker(BOT, [fakeIssue(62, { labels: [{ name: 'size: 1' }] })]);
    process.env.E2E_PROVER = 'failed';
    const first = context(io, 62, 'host-1-1');
    await fixIssue(first.ctx, ISSUE(62), { maxPoints: 2 });
    delete process.env.E2E_PROVER;
    const announced = newestStep(io.view(62)!.comments, BOT, 'coded');
    expect(announced).not.toBeNull();
    writeFileSync(join(repo, 'b.txt'), 'landed elsewhere\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'another landing');
    git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');

    writeFileSync(agentLog, '');
    const issue = { ...ISSUE(62), labels: io.view(62)!.labels };
    const second = context(io, 62, 'host-2-2');
    const outcome = await fixIssue(second.ctx, issue, { maxPoints: 2 });
    expect(outcome.outcome).toBe('handed-off');
    // Prove alone, on the coder's branch: no second Code turn, though the fresh lane sat on a newer base.
    expect(roles()).toEqual(['prover on fix/change-62']);
    expect(second.lines.some((l) => l.includes('resuming at Prove'))).toBe(true);
    // The catch-up moved the head, so the marker was announced again at the head that now stands.
    const after = newestStep(io.view(62)!.comments, BOT, 'coded');
    expect(after?.sha).toBe(git(repo, 'ls-remote', 'origin', 'refs/heads/fix/change-62').split(/\s+/)[0]);
    expect(after?.sha).not.toBe(announced?.sha);
    expect(after?.gated).toBe(announced?.gated);
  }, 90_000);

  it('sends a refused proof back to Code on the same branch, caught up and never reset, until the attempts are spent', async () => {
    writeFileSync(agentLog, '');
    const io = new FakeTracker(BOT, [fakeIssue(63, { labels: [{ name: 'size: 1' }] })]);
    process.env.E2E_PROVER = 'unprovable';
    const { ctx, lanes } = context(io, 63, 'host-1-1');
    const outcome = await fixIssue(ctx, ISSUE(63), { maxPoints: 2 });
    delete process.env.E2E_PROVER;
    expect(outcome.outcome).toBe('dlq');
    // The first coder starts detached on the base; every later one continues the pushed branch.
    expect(roles()).toEqual(['worker on HEAD', 'prover on fix/change-63', 'worker-revise on fix/change-63', 'prover on fix/change-63', 'worker-revise on fix/change-63', 'prover on fix/change-63']);
    expect(lanes.filter((l) => l === 'D1' || l === 'D2')).toEqual(['D1', 'D2', 'D1', 'D2', 'D1', 'D2']);
    const refusals = io.view(63)!.comments.filter((c) => c.body.includes('step=refused')).map((c) => /attempt=(\d)/.exec(c.body)?.[1]);
    expect(refusals).toEqual(['1', '2', '3']);
    // Counted once each, and the dead letter at the cap counted nothing more.
    expect(io.view(63)!.labels.map((l) => l.name).filter((n) => n.startsWith('loop/attempts'))).toEqual(['loop/attempts: 3']);
  }, 120_000);

  it('dispatches nothing, and repairs the label once, when the refusal a run starts from spent the last attempt', async () => {
    // A run announced its third refusal and died before the label: the issue shows 2, the marker 3.
    writeFileSync(agentLog, '');
    const io = new FakeTracker(BOT, [fakeIssue(64, { labels: [{ name: 'size: 1' }, { name: 'loop/attempts: 2' }] })]);
    io.comment(64, BOT, `<!-- loop-step step=refused run=host-0-0 sha=${'e'.repeat(40)} gated=${'e'.repeat(40)} touches=none attempt=3 -->\nthe endpoint still returns 500 for an empty list`);
    const { ctx } = context(io, 64, 'host-3-3');
    const outcome = await fixIssue(ctx, { ...ISSUE(64), labels: [{ name: 'size: 1' }, { name: 'loop/attempts: 2' }] }, { maxPoints: 2 });
    expect(roles()).toEqual([]);
    expect(outcome.outcome).toBe('dlq');
    expect(outcome.reason).toContain('the endpoint still returns 500 for an empty list');
    expect(io.view(64)!.labels.map((l) => l.name).filter((n) => n.startsWith('loop/attempts'))).toEqual(['loop/attempts: 3']);
  }, 60_000);
});

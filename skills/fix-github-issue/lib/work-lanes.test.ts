import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCode } from '../../code-github-issue/lib/code.ts';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import { runProve } from '../../prove-github-issue/lib/prove.ts';
import type { ProjectConfig } from './config.ts';
import { type Context, createContext } from './context.ts';
import { placeWork } from './pipeline.ts';
import { codedComment, latestStep, unprovedComment } from './work-markers.ts';

/** A real remote and real lanes: whether a push happened is only a fact on disk. */
let scratch: string;
let repo: string;
let base: string;
const BOT = 'loop-bot';
const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
};

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'work-lanes-'));
  repo = join(scratch, 'repo');
  git(scratch, 'init', '-q', '--bare', '-b', 'main', join(scratch, 'origin.git'));
  git(scratch, 'clone', '-q', join(scratch, 'origin.git'), repo);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'one');
  git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  base = git(repo, 'rev-parse', 'HEAD');
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PROJECT = { name: 'Test', repo: 'o/lanes', remote: 'origin', baseBranch: 'main', evidenceBranch: 'evidence', checkCommand: 'true', installCommand: 'true', conventionDocs: [], sizingScale: 'fib', sharedServices: [], portBase: 9000, portSpan: 10, pathAliases: [], sourceExtensions: ['.ts'], alwaysInvalidates: [], touchPaths: { migration: [], ci: [] }, worktreeRoot: 'wt' } as ProjectConfig;

function context(io: FakeTracker, answer: string): Context {
  return createContext({
    project: PROJECT,
    knobs: { autoMerge: 'never', maxReviewRounds: 3, checksTimeoutMinutes: 1, smokeTimeoutMinutes: 1 },
    seats: { worker: { engine: 'fixture', model: answer }, reviewer: { engine: 'fixture2' } },
    repoRoot: repo,
    invokeRoot: repo,
    promptsDirs: [join(import.meta.dir, '..', 'prompts')],
    dryRun: false,
    runDir: join(scratch, 'runs'),
    botLogin: BOT,
    io,
    log: () => {},
    step: () => {},
  });
}

/** A lane as the pipeline cuts one, detached at the base. */
function lane(issue: number): string {
  const dir = join(repo, 'wt', `issue-${issue}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(repo, 'wt'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '--detach', dir, 'origin/main');
  return dir;
}

/** A coder's work: a commit on its branch, pushed unless told otherwise. */
function code(dir: string, branch: string, push = true): string {
  git(dir, 'switch', '-q', '-c', branch);
  writeFileSync(join(dir, `${branch.replaceAll('/', '-')}.txt`), 'the change\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', `fix: ${branch}`);
  if (push) git(dir, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
  return git(dir, 'rev-parse', 'HEAD');
}

const answerFile = (name: string, body: object) => {
  const path = join(scratch, `${name}.json`);
  writeFileSync(path, JSON.stringify(body));
  return path;
};
const issue = (n: number) => ({ number: n, title: 't', createdAt: '2026-10-27T00:00:00Z', labels: [{ name: 'size: 1' }] });

describe('the Work markers', () => {
  it('round-trip a coded push and its hand-off, and the newest of two is the standing fact', () => {
    const coded = codedComment('run-1', { branch: 'fix/x-1', sha: 'a'.repeat(40), gated: 'b'.repeat(40), touches: ['code', 'ci'] }, 'changed x; run the x test');
    const step = latestStep([{ author: BOT, body: coded }], BOT);
    expect(step).toEqual({ kind: 'coded', sha: 'a'.repeat(40), branch: 'fix/x-1', gated: 'b'.repeat(40), touches: ['code', 'ci'], handoff: 'changed x; run the x test' });
    const refused = unprovedComment('run-1', 'fix/x-1', 'a'.repeat(40), 'the x test still fails on an empty list');
    expect(latestStep([{ author: BOT, body: coded }, { author: BOT, body: refused }], BOT)).toEqual({ kind: 'unproved', sha: 'a'.repeat(40), branch: 'fix/x-1', brief: 'the x test still fails on an empty list' });
  });

  it("trusts only the bot's markers: a person pasting one moves nothing", () => {
    const coded = codedComment('run-1', { branch: 'fix/x-1', sha: 'a'.repeat(40), gated: 'a'.repeat(40), touches: [] }, 'h');
    expect(latestStep([{ author: 'someone', body: coded }], BOT)).toBeNull();
  });

  it('refuses a field that would break the marker apart', () => {
    expect(() => codedComment('run-1', { branch: 'fix/x 1', sha: 'a', gated: 'a', touches: [] }, 'h')).toThrow(/one token/);
  });
});

describe('where a first attempt starts, read from the remote and the tracker', () => {
  it('starts from the base when the issue carries no announcement', () => {
    const io = new FakeTracker(BOT, [fakeIssue(10)]);
    expect(placeWork(context(io, 'unused'), issue(10), lane(10), () => {})).toEqual({ kind: 'code', brief: { kind: 'first' } });
  });

  it('proves, never codes again, a commit announced coded that is still the head of its branch: a kill during Proving costs only Proving', () => {
    const dir = lane(11);
    const sha = code(dir, 'fix/eleven-11');
    const fresh = lane(110);
    const io = new FakeTracker(BOT, [fakeIssue(11)]);
    io.comment(11, BOT, codedComment('run-1', { branch: 'fix/eleven-11', sha, gated: sha, touches: ['code'] }, 'changed eleven'));
    const placed = placeWork(context(io, 'unused'), issue(11), fresh, () => {});
    expect(placed).toEqual({ kind: 'prove', sha, handoff: 'changed eleven', coded: { branch: 'fix/eleven-11', gated: sha, touches: ['code'] } });
    // The lane is switched onto the announced branch, at the announced commit.
    expect(git(fresh, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('fix/eleven-11');
    expect(git(fresh, 'rev-parse', 'HEAD')).toBe(sha);
  });

  it('codes again, on the same branch and with what could not be shown, after a refused proof', () => {
    const dir = lane(12);
    const sha = code(dir, 'fix/twelve-12');
    const io = new FakeTracker(BOT, [fakeIssue(12)]);
    io.comment(12, BOT, codedComment('run-1', { branch: 'fix/twelve-12', sha, gated: sha, touches: [] }, 'h'));
    io.comment(12, BOT, unprovedComment('run-1', 'fix/twelve-12', sha, 'an empty list still throws'));
    const placed = placeWork(context(io, 'unused'), issue(12), lane(120), () => {});
    expect(placed).toEqual({ kind: 'code', brief: { kind: 'unproved', branch: 'fix/twelve-12', text: 'an empty list still throws' } });
  });

  it('continues with a coder a branch that moved past its announcement: nobody declared that work finished', () => {
    const dir = lane(13);
    const announced = code(dir, 'fix/thirteen-13');
    writeFileSync(join(dir, 'more.txt'), 'unannounced\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'wip');
    git(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/fix/thirteen-13');
    const io = new FakeTracker(BOT, [fakeIssue(13)]);
    io.comment(13, BOT, codedComment('run-1', { branch: 'fix/thirteen-13', sha: announced, gated: announced, touches: [] }, 'h'));
    const placed = placeWork(context(io, 'unused'), issue(13), lane(130), () => {});
    expect(placed.kind).toBe('code');
    expect(placed.kind === 'code' && placed.brief.kind).toBe('continue');
  });

  it('starts from the base when the announced branch is gone from the remote', () => {
    const io = new FakeTracker(BOT, [fakeIssue(14)]);
    io.comment(14, BOT, codedComment('run-1', { branch: 'fix/never-pushed-14', sha: base, gated: base, touches: [] }, 'h'));
    expect(placeWork(context(io, 'unused'), issue(14), lane(14), () => {})).toEqual({ kind: 'code', brief: { kind: 'first' } });
  });
});

describe('placement finds the work a dead coder left, and ignores what already landed', () => {
  it('continues a branch of this issue that was pushed and never announced', () => {
    const dir = lane(15);
    code(dir, 'fix/fifteen-15');
    const fresh = lane(150);
    const placed = placeWork(context(new FakeTracker(BOT, [fakeIssue(15)]), 'unused'), issue(15), fresh, () => {});
    expect(placed.kind === 'code' && placed.brief).toMatchObject({ kind: 'continue', branch: 'fix/fifteen-15' });
    expect(git(fresh, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('fix/fifteen-15');
  });

  it('starts from the base when the announced commit is already in the base', () => {
    const dir = lane(16);
    const sha = code(dir, 'fix/sixteen-16');
    git(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    const io = new FakeTracker(BOT, [fakeIssue(16)]);
    io.comment(16, BOT, codedComment('run-1', { branch: 'fix/sixteen-16', sha, gated: sha, touches: [] }, 'h'));
    expect(placeWork(context(io, 'unused'), issue(16), lane(160), () => {})).toEqual({ kind: 'code', brief: { kind: 'first' } });
  });

  it('proves, after a seam catch-up, the head the catch-up announced', () => {
    const dir = lane(17);
    const coded = code(dir, 'fix/seventeen-17');
    // The driver's catch-up at the seam: a merge pushed onto the coder's commit, then announced.
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'Merge the base');
    git(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/fix/seventeen-17');
    const merged = git(dir, 'rev-parse', 'HEAD');
    const io = new FakeTracker(BOT, [fakeIssue(17)]);
    io.comment(17, BOT, codedComment('run-1', { branch: 'fix/seventeen-17', sha: coded, gated: coded, touches: [] }, 'h'));
    io.comment(17, BOT, codedComment('run-1', { branch: 'fix/seventeen-17', sha: merged, gated: coded, touches: [] }, 'h'));
    expect(placeWork(context(io, 'unused'), issue(17), lane(170), () => {})).toMatchObject({ kind: 'prove', sha: merged, coded: { gated: coded } });
  });
});

describe("the coder's answer is believed only as far as the remote bears it out", () => {
  it('believes a coded push that is the lane head and on the remote', async () => {
    const dir = lane(20);
    const sha = code(dir, 'fix/twenty-20');
    const answer = answerFile('coded-20', { issue: 20, verdict: 'coded', reason: 'done', branch: 'fix/twenty-20', sha, gated: sha, handoff: 'changed twenty', touches: ['code', 'nonsense'] });
    const result = await runCode(context(new FakeTracker(BOT), answer), issue(20), dir, 2, { kind: 'first' });
    expect(result.verdict).toBe('coded');
    expect(result.touches).toEqual(['code']);
  });

  it('refuses a coded answer whose commit never reached the remote: the push is the fact', async () => {
    const dir = lane(21);
    const sha = code(dir, 'fix/twentyone-21', false);
    const answer = answerFile('coded-21', { issue: 21, verdict: 'coded', reason: 'done', branch: 'fix/twentyone-21', sha, gated: sha, handoff: 'h' });
    const result = await runCode(context(new FakeTracker(BOT), answer), issue(21), dir, 2, { kind: 'first' });
    expect(result.verdict).toBe('failed');
    expect(result.reason).toContain('the push is the fact, and it did not happen');
  });

  it('refuses a coded answer pushed onto the base branch', async () => {
    const dir = lane(22);
    const answer = answerFile('coded-22', { issue: 22, verdict: 'coded', reason: 'done', branch: 'main', sha: base, gated: base, handoff: 'h' });
    const result = await runCode(context(new FakeTracker(BOT), answer), issue(22), dir, 2, { kind: 'first' });
    expect(result.verdict).toBe('failed');
    expect(result.reason).toContain('onto the base branch');
  });

  it('refuses a coded answer with no hand-off for the prover', async () => {
    const dir = lane(23);
    const sha = code(dir, 'fix/twentythree-23');
    const answer = answerFile('coded-23', { issue: 23, verdict: 'coded', reason: 'done', branch: 'fix/twentythree-23', sha, gated: sha, handoff: ' ' });
    const result = await runCode(context(new FakeTracker(BOT), answer), issue(23), dir, 2, { kind: 'first' });
    expect(result.verdict).toBe('failed');
  });

  it("removes an earlier proof when it starts: a revision's old proof must never be resumed into review", async () => {
    const dir = lane(25);
    writeFileSync(join(dir, 'loop-proof.json'), JSON.stringify({ issue: 25, verdict: 'proved', reason: 'old', pr: 1, sha: base }));
    const answer = answerFile('escape-25', { issue: 25, verdict: 'needs-human', reason: 'stopped' });
    await runCode(context(new FakeTracker(BOT), answer), issue(25), dir, 2, { kind: 'revision', branch: 'fix/x-25', text: 'blocked' });
    expect(existsSync(join(dir, 'loop-proof.json'))).toBe(false);
  });

  it('passes an escape through untouched', async () => {
    const dir = lane(24);
    const answer = answerFile('escape-24', { issue: 24, verdict: 'needs-decision', reason: 'which currency?' });
    const result = await runCode(context(new FakeTracker(BOT), answer), issue(24), dir, 2, { kind: 'first' });
    expect(result).toMatchObject({ verdict: 'needs-decision', reason: 'which currency?' });
  });
});

describe("the prover's answer is believed only on the head it was given", () => {
  it('believes a proof pinned to the lane head, naming its pull request', async () => {
    const dir = lane(30);
    const sha = code(dir, 'fix/thirty-30');
    const answer = answerFile('proved-30', { issue: 30, verdict: 'proved', reason: 'proved', pr: 300, sha });
    const result = await runProve(context(new FakeTracker(BOT), answer), issue(30), dir, { branch: 'fix/thirty-30', gated: sha }, { kind: 'handoff', text: 'h' });
    expect(result).toMatchObject({ verdict: 'proved', pr: 300, branch: 'fix/thirty-30' });
  });

  it('refuses a proof pinned to any other head: it describes a tree nobody will review', async () => {
    const dir = lane(31);
    code(dir, 'fix/thirtyone-31');
    const answer = answerFile('proved-31', { issue: 31, verdict: 'proved', reason: 'proved', pr: 310, sha: base });
    const result = await runProve(context(new FakeTracker(BOT), answer), issue(31), dir, { branch: 'fix/thirtyone-31', gated: base }, { kind: 'handoff', text: 'h' });
    expect(result.verdict).toBe('failed');
  });

  it('refuses a proof of a head the remote does not hold', async () => {
    const dir = lane(33);
    const sha = code(dir, 'fix/thirtythree-33', false);
    const answer = answerFile('proved-33', { issue: 33, verdict: 'proved', reason: 'proved', pr: 330, sha });
    const result = await runProve(context(new FakeTracker(BOT), answer), issue(33), dir, { branch: 'fix/thirtythree-33', gated: sha }, { kind: 'handoff', text: 'h' });
    expect(result.verdict).toBe('failed');
    expect(result.reason).toContain('is not there');
  });

  it('refuses an unprovable that tells the coder nothing to fix', async () => {
    const dir = lane(32);
    const sha = code(dir, 'fix/thirtytwo-32');
    const answer = answerFile('unprovable-32', { issue: 32, verdict: 'unprovable', reason: 'no' });
    const result = await runProve(context(new FakeTracker(BOT), answer), issue(32), dir, { branch: 'fix/thirtytwo-32', gated: sha }, { kind: 'handoff', text: 'h' });
    expect(result.verdict).toBe('failed');
  });
});

describe('the lane prompts', () => {
  const prompts = {
    code: readFileSync(join(import.meta.dir, '..', '..', 'code-github-issue', 'prompts', 'code.md'), 'utf8'),
    prove: readFileSync(join(import.meta.dir, '..', '..', 'prove-github-issue', 'prompts', 'prove.md'), 'utf8'),
  };
  for (const [name, text] of Object.entries(prompts)) {
    it(`${name}.md tells its seat never to chase the base: staying current is the driver's, at the seams`, () => {
      expect(text).not.toMatch(/git merge(?!-base)/);
      expect(text).not.toContain('git fetch {{REMOTE}} {{BASE_BRANCH}}');
      expect(text).toMatch(/do not chase it/);
    });
  }
  it('code.md never asks its seat to prove or open a pull request, and prove.md never to push to the branch', () => {
    expect(prompts.code).not.toContain('gh pr create');
    expect(prompts.code).not.toContain('prove-work-on-github');
    expect(prompts.prove).toContain('You push nothing to `{{BRANCH}}`');
  });
});

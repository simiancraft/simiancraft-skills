/**
 * The Coding lane's seat: one agent turn that makes the smallest change for an issue, gates it,
 * commits it, and pushes it, then stops. It proves nothing and opens no pull request; the prover
 * does that in a fresh turn. The driver moves the card and announces the push; this module only
 * runs the seat and decides whether its answer is believable.
 */

import { join } from 'node:path';
import { agentCapMs, logTail, readResult, renderPrompt, runAgent, runAgentOnce } from '../../fix-github-issue/lib/agent.ts';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import { CODE_FILE } from '../../fix-github-issue/lib/control-files.ts';
import { sh } from '../../fix-github-issue/lib/shell.ts';
import type { Touch } from '../../fix-github-issue/lib/work-markers.ts';

const PROMPTS = join(import.meta.dir, '..', 'prompts');

export type CodeVerdict = 'coded' | 'already-fixed' | 'obsolete' | 'needs-decision' | 'needs-human' | 'out-of-band' | 'answered' | 'failed';

export type CodeResult = {
  issue: number;
  /** `not-run` is never the coder's word: it is the driver's, for a seat a dry run did not run. */
  verdict: CodeVerdict | 'not-run';
  reason: string;
  points?: number;
  closeComment?: string;
  answer?: string;
  branch?: string;
  /** The coded head; a conflict turn leaves it local for the driver to verify and push. */
  sha?: string;
  /** The commit the check command passed on; the prover reruns the gate only on a head that differs. */
  gated?: string;
  /** What the prover reads first: what changed, how to exercise it, what was not checked. */
  handoff?: string;
  touches?: Touch[];
};

/**
 * Why this turn exists, in the coder's own terms. A first attempt starts from the base; every other
 * kind continues the branch it names with the words that sent the work back.
 */
export type CodeBrief =
  | { kind: 'first' }
  | { kind: 'continue'; branch: string; text: string }
  | { kind: 'revision'; branch: string; text: string }
  | { kind: 'unproved'; branch: string; text: string }
  | { kind: 'conflict'; branch: string; base: string; paths: string[]; text: string };

const KNOWN: CodeVerdict[] = ['coded', 'already-fixed', 'obsolete', 'needs-decision', 'needs-human', 'out-of-band', 'answered', 'failed'];
const TOUCHES: Touch[] = ['code', 'data', 'migration', 'stored-string', 'ci'];

function briefText(brief: CodeBrief): string {
  switch (brief.kind) {
    case 'first':
      return 'This is the first attempt at this issue. Start from the base the lane holds.';
    case 'conflict':
      return `This is one conflict turn for branch \`${brief.branch}\`. The driver has already started merging pinned base commit \`${brief.base}\` and stopped on these unmerged paths:\n${brief.paths.map((path) => `- ${path}`).join('\n')}\n\nThe lane is detached on purpose. Stay on it; do not switch to or create a branch. Resolve every path keeping both sides' intent, stage the resolutions, and conclude this merge with a merge commit whose parent is the pinned base commit. Start no other merge; never abort this merge, rebase, or force-push. Run the install and check commands on the result. Do not push: the driver pushes only what it has verified. Answer \`coded\` with branch \`${brief.branch}\`, sha and gated both equal to the lane's final HEAD, and a nonempty handoff; or answer \`failed\` with the reason or the exact question a person must answer. These rules override the ordinary branch, base, push, and verdict instructions below.\n\n${brief.text}`;
    case 'continue':
      return `Branch \`${brief.branch}\` already holds commits for this issue that were never announced as finished: an earlier coder stopped before it could say so. Switch to that branch, read what it holds, finish the change on it, and push to it again; never start a second branch.\n\n${brief.text}`;
    case 'revision':
      return `The change on branch \`${brief.branch}\` was sent back over the code. Switch to that branch, address every point below, and push to it again; the pull request, if one exists, stays the same one.\n\n${brief.text}`;
    case 'unproved':
      return `The change on branch \`${brief.branch}\` could not be proved: the prover found what it does not yet do, below. Switch to that branch, fix that, and push to it again.\n\n${brief.text}`;
  }
}

const fail = (issue: number, reason: string): CodeResult => ({ issue, verdict: 'failed', reason });

/**
 * Runs the coder and returns its answer, or `failed` when the answer cannot be believed: a crash, a
 * kill at the cap, a verdict the driver does not know, or a `coded` whose commit is not this lane's
 * head and on the remote. Work the coder pushed before failing survives on the remote either way.
 */
export async function runCode(
  ctx: Context,
  issue: { number: number; title: string },
  cwd: string,
  maxPoints: number,
  brief: CodeBrief,
  onRetry?: () => void,
): Promise<CodeResult> {
  const prompt = renderPrompt({ ...ctx, promptsDirs: [...ctx.promptsDirs, PROMPTS] }, 'code.md', {
    ISSUE: String(issue.number),
    TITLE: issue.title,
    MAX_POINTS: String(maxPoints),
    BRIEF: briefText(brief),
  });
  const role = brief.kind === 'conflict' ? 'coder-conflict' : brief.kind === 'first' ? 'coder' : 'coder-revise';
  const { logPath, exitCode, notRun, timedOut } = brief.kind === 'conflict'
    ? await runAgentOnce(ctx, role, issue.number, cwd, ctx.seats.worker, prompt)
    : await runAgent(ctx, role, issue.number, cwd, ctx.seats.worker, prompt, onRetry);
  if (notRun) return { issue: issue.number, verdict: 'not-run', reason: 'dry run: the coder was not run' };
  if (exitCode !== 0) {
    return fail(
      issue.number,
      timedOut
        ? `coder timed out at ${agentCapMs(ctx, role) / 60000} minutes and was killed, so nothing it left in its lane is trusted; anything it had already pushed survives; log ends: ${logTail(logPath)}`
        : `coder exited ${exitCode}, so its verdict is not trusted; anything it had already pushed survives; log ends: ${logTail(logPath)}`,
    );
  }

  const result = readResult<CodeResult>(cwd, CODE_FILE);
  if (!result || !KNOWN.includes(result.verdict as CodeVerdict)) {
    return fail(issue.number, result ? `coder verdict '${result.verdict}' is not one the driver knows; log ends: ${logTail(logPath)}` : `no verdict from the coder; log ends: ${logTail(logPath)}`);
  }
  if (Number(result.issue) !== issue.number || typeof result.reason !== 'string') {
    return fail(issue.number, `coder verdict names issue ${JSON.stringify(result.issue)} or has no reason; log ends: ${logTail(logPath)}`);
  }
  // A malformed classification must read as no classification, which fails closed at the merge.
  result.touches = Array.isArray(result.touches) ? result.touches.filter((t) => TOUCHES.includes(t)) : undefined;
  if (result.verdict === 'out-of-band') {
    const points = Number(result.points);
    if (!ctx.knobs.pointScale.includes(points) || points <= maxPoints) {
      return fail(issue.number, `out-of-band with points ${result.points ?? 'unstated'}, which is not on the scale above ${maxPoints}; log ends: ${logTail(logPath)}`);
    }
  }
  if (result.verdict === 'answered' && typeof result.answer !== 'string') return fail(issue.number, `answered without an answer; log ends: ${logTail(logPath)}`);
  // A dry run's fixture seat writes an answer and pushes nothing; there is no remote fact to check.
  if (result.verdict === 'coded' && !ctx.dryRun) {
    const why = brief.kind === 'conflict' ? unbelievableConflict(ctx, cwd, result, brief.branch) : unbelievableCoded(ctx, cwd, result);
    if (why) return fail(issue.number, `${why}; log ends: ${logTail(logPath)}`);
  }
  return result;
}

/** Why a `coded` answer cannot be believed, or null: the named commit must be this lane's head and on the remote. */
function unbelievableCoded(ctx: Context, cwd: string, result: CodeResult): string | null {
  const { branch, sha, gated, handoff } = result;
  if (typeof branch !== 'string' || typeof sha !== 'string' || typeof gated !== 'string' || typeof handoff !== 'string' || handoff.trim() === '') {
    return 'coded without a branch, a pushed sha, a gated sha, and a hand-off';
  }
  if (branch === ctx.project.baseBranch) return `coded onto the base branch ${branch}, which no change may push to`;
  const head = sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);
  if (head !== sha) return `coded at ${sha.slice(0, 12)}, but the lane's head is ${head.slice(0, 12)}`;
  // Two argument-array processes, no shell: a branch name is data and must never be read as syntax.
  const remote = Bun.spawnSync(['git', 'ls-remote', '--heads', ctx.project.remote, `refs/heads/${branch}`], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const onRemote = remote.stdout.toString().trim().split(/\s+/)[0] ?? '';
  if (remote.exitCode !== 0) return `could not read ${ctx.project.remote}/${branch}: ${remote.stderr.toString().trim()}`;
  if (onRemote !== sha) return `coded at ${sha.slice(0, 12)}, but ${ctx.project.remote}/${branch} is ${onRemote ? onRemote.slice(0, 12) : 'not there'}; the push is the fact, and it did not happen`;
  return null;
}

/** A conflict turn reports a local head; the driver verifies the merge before publishing it. */
function unbelievableConflict(ctx: Context, cwd: string, result: CodeResult, branch: string): string | null {
  if (result.branch !== branch) return `coded on ${result.branch}, but the conflict brief names ${branch}`;
  const head = sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);
  if (result.sha !== head) return `coded at ${result.sha}, but the lane's head is ${head}`;
  if (result.gated !== head) return `coded with gated ${result.gated}, but the lane's head is ${head}`;
  if (typeof result.handoff !== 'string' || result.handoff.trim() === '') return 'coded without a hand-off';
  return null;
}

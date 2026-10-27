/**
 * The Proving lane's seat: one agent turn, on a fresh context, that proves a commit a coder pushed
 * and hands it to review as a ready pull request. It changes no code and pushes nothing to the
 * branch. When the change cannot be proved, its answer says what is missing, which the driver
 * hands back to a coder. The driver moves the card; this module runs the seat and decides whether
 * its answer is believable.
 */

import { join } from 'node:path';
import { agentCapMs, logTail, readResult, renderPrompt, runAgent } from '../../fix-github-issue/lib/agent.ts';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import { PROOF_FILE } from '../../fix-github-issue/lib/control-files.ts';
import { sh } from '../../fix-github-issue/lib/shell.ts';
import type { Touch } from '../../fix-github-issue/lib/work-markers.ts';

const PROMPTS = join(import.meta.dir, '..', 'prompts');

export type ProveVerdict = 'proved' | 'unprovable' | 'needs-decision' | 'needs-human' | 'failed';

export type ProveResult = {
  issue: number;
  /** `not-run` is never the prover's word: it is the driver's, for a seat a dry run did not run. */
  verdict: ProveVerdict | 'not-run';
  reason: string;
  pr?: number;
  branch?: string;
  /** The head the proof is pinned to. For `proved`, the lane's head. */
  sha?: string;
  /** For `unprovable`: what the coder must fix. */
  brief?: string;
  touches?: Touch[];
};

/**
 * Why this turn exists. `handoff` is the coder's, from its announcement on the issue; the other
 * kinds carry the words that asked for proof again.
 */
export type ProveBrief =
  | { kind: 'handoff'; text: string }
  | { kind: 'more-evidence'; text: string }
  | { kind: 'reproof'; text: string };

const KNOWN: ProveVerdict[] = ['proved', 'unprovable', 'needs-decision', 'needs-human', 'failed'];
const TOUCHES: Touch[] = ['code', 'data', 'migration', 'stored-string', 'ci'];

function briefText(brief: ProveBrief): string {
  switch (brief.kind) {
    case 'handoff':
      return `This is the first proof of this change. The coder's hand-off:\n\n${brief.text}`;
    case 'more-evidence':
      return `A reviewer read the existing proof on this pull request and asked for more. Acquire what the points below ask for, update the proof on the same pull request, and mark it ready again.\n\n${brief.text}`;
    case 'reproof':
      return `Nobody rejected this work. The base moved beneath its proof, and the branch has been caught up for you. Confirm the change still holds on this head, reacquire the receipts the movement reached, update the proof on the same pull request, and mark it ready again.\n\n${brief.text}`;
  }
}

const fail = (issue: number, reason: string): ProveResult => ({ issue, verdict: 'failed', reason });

/**
 * Runs the prover on the lane's current head and returns its answer, or `failed` when the answer
 * cannot be believed: a crash, a kill at the cap, a verdict the driver does not know, a `proved`
 * pinned to a head that is not the lane's, or an `unprovable` that tells the coder nothing.
 */
export async function runProve(
  ctx: Context,
  issue: { number: number; title: string },
  cwd: string,
  coded: { branch: string; gated: string },
  brief: ProveBrief,
): Promise<ProveResult> {
  const head = ctx.dryRun ? coded.gated : sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);
  const prompt = renderPrompt({ ...ctx, promptsDirs: [...ctx.promptsDirs, PROMPTS] }, 'prove.md', {
    ISSUE: String(issue.number),
    TITLE: issue.title,
    BRANCH: coded.branch,
    HEAD: head,
    GATED: coded.gated,
    BRIEF: briefText(brief),
  });
  const { logPath, exitCode, notRun, timedOut } = await runAgent(ctx, 'prover', issue.number, cwd, ctx.seats.worker, prompt);
  if (notRun) return { issue: issue.number, verdict: 'not-run', reason: 'dry run: the prover was not run' };
  if (exitCode !== 0) {
    return fail(
      issue.number,
      timedOut
        ? `prover timed out at ${agentCapMs(ctx, 'prover') / 60000} minutes and was killed, so nothing it left is trusted; the coded commit stands, and the next attempt proves it again rather than coding again; log ends: ${logTail(logPath)}`
        : `prover exited ${exitCode}, so its verdict is not trusted; the coded commit stands, and the next attempt proves it again; log ends: ${logTail(logPath)}`,
    );
  }

  const result = readResult<ProveResult>(cwd, PROOF_FILE);
  if (!result || !KNOWN.includes(result.verdict as ProveVerdict)) {
    return fail(issue.number, result ? `prover verdict '${result.verdict}' is not one the driver knows; log ends: ${logTail(logPath)}` : `no verdict from the prover; log ends: ${logTail(logPath)}`);
  }
  if (Number(result.issue) !== issue.number || typeof result.reason !== 'string') {
    return fail(issue.number, `prover verdict names issue ${JSON.stringify(result.issue)} or has no reason; log ends: ${logTail(logPath)}`);
  }
  result.touches = Array.isArray(result.touches) ? result.touches.filter((t) => TOUCHES.includes(t)) : undefined;
  if (result.verdict === 'proved') {
    if (!Number.isInteger(Number(result.pr)) || Number(result.pr) <= 0) return fail(issue.number, `proved without naming the pull request; log ends: ${logTail(logPath)}`);
    result.pr = Number(result.pr);
    // The prover pushes nothing, so the head it proved is the head it was given, and the remote
    // must hold it: a proof pinned anywhere else describes a tree that will not be reviewed.
    if (!ctx.dryRun) {
      const now = sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);
      if (result.sha !== head || now !== head) return fail(issue.number, `proved ${String(result.sha).slice(0, 12)} on a lane now at ${now.slice(0, 12)}, but it was given ${head.slice(0, 12)}, and pushes nothing; log ends: ${logTail(logPath)}`);
      const remote = Bun.spawnSync(['git', 'ls-remote', '--heads', ctx.project.remote, `refs/heads/${coded.branch}`], { cwd, stdout: 'pipe', stderr: 'pipe' });
      const onRemote = remote.stdout.toString().trim().split(/\s+/)[0] ?? '';
      if (onRemote !== head) return fail(issue.number, `proved ${head.slice(0, 12)}, but ${ctx.project.remote}/${coded.branch} is ${onRemote ? onRemote.slice(0, 12) : 'not there'}; log ends: ${logTail(logPath)}`);
    }
    result.branch = coded.branch;
  }
  if (result.verdict === 'unprovable' && (typeof result.brief !== 'string' || result.brief.trim() === '')) {
    return fail(issue.number, `unprovable without saying what the coder must fix; log ends: ${logTail(logPath)}`);
  }
  return result;
}

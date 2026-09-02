/**
 * Size callbacks: what happens after an issue is sized is not the appraiser's to decide. A
 * producer (the issue burndown, a person, another skill) puts files named for a size into a
 * directory, and the appraiser looks one up for the points it just applied and runs it, knowing
 * nothing about what it does. The lookup is a ladder so a Fibonacci scale does not need a file
 * per rung:
 *
 *   on-size-<N>          exactly this size
 *   on-size-over-<M>     the largest M below N that has a file
 *   on-size              anything sized
 *
 * Each name may exist as an executable (run with the appraisal outcome as JSON on stdin) and as a
 * `.md` prompt (an agent turn on the callback seat, rendered with the issue vocabulary). The
 * executable is for anything load-bearing; the prompt is for anything that needs judgement, such
 * as invoking another skill to break the issue apart.
 */

import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readResult, renderTemplate, runAgent } from '../../fix-github-issue/lib/agent.ts';
import { hasCallback, runCallback } from '../../fix-github-issue/lib/callbacks.ts';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import type { Seat } from '../../fix-github-issue/lib/engines.ts';
import type { Issue } from '../../fix-github-issue/lib/pipeline.ts';

/** What the appraiser hands a size callback, on stdin and as prompt vocabulary. */
export type SizePayload = {
  issue: number;
  title: string;
  points: number;
  priorPoints: number | null;
  verdict: 'valid';
  reason: string;
  repo: string;
  baseBranch: string;
};

/** What a callback prompt may write to `loop-callback.json` to be recorded; optional. */
export type CallbackVerdict = { outcome: string; reason: string };

export type SizeCallbackResult = {
  /** The slot name that matched, or null when the directory holds nothing for this size. */
  name: string | null;
  executable?: { exitCode: number };
  prompt?: { exitCode: number; verdict: CallbackVerdict | null };
};

export const CALLBACK_FILE = 'loop-callback.json';

/** The slot name the ladder resolves to for `points`, or null. */
export function resolveSizeCallback(dir: string, points: number): string | null {
  const exact = `on-size-${points}`;
  if (hasCallback(dir, exact)) return exact;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let best: number | null = null;
  for (const file of names) {
    const match = /^on-size-over-(\d+)(?:\.md)?$/.exec(file);
    if (!match) continue;
    const threshold = Number(match[1]);
    if (threshold < points && (best === null || threshold > best) && hasCallback(dir, `on-size-over-${threshold}`)) {
      best = threshold;
    }
  }
  if (best !== null) return `on-size-over-${best}`;
  return hasCallback(dir, 'on-size') ? 'on-size' : null;
}

/**
 * Runs whatever the directory holds for this size. The executable runs first with the payload on
 * stdin; the prompt, when present, is one agent turn in its own scratch directory. Neither can
 * fail the appraisal: the size is already on the issue, and what follows is the producer's
 * business.
 */
export async function runSizeCallback(
  ctx: Context,
  dir: string,
  seat: Seat,
  issue: Issue,
  payload: SizePayload,
  say: (message: string) => void,
): Promise<SizeCallbackResult> {
  const name = resolveSizeCallback(dir, payload.points);
  if (!name) return { name: null };
  say(`size callback ${name} for ${payload.points} points`);
  const result: SizeCallbackResult = { name };
  const slot = await runCallback(dir, name, payload, say);
  if (slot.ran && slot.exitCode !== undefined) result.executable = { exitCode: slot.exitCode };
  if (slot.prompt === undefined) return result;

  if (ctx.dryRun) {
    say(`DRY RUN  would run the ${name}.md prompt on ${seat.engine}`);
    return result;
  }
  const cwd = join(ctx.runDir, `callback-${issue.number}-${process.pid}`);
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  const prompt = renderTemplate(ctx, slot.prompt, {
    ISSUE: String(payload.issue),
    TITLE: payload.title,
    POINTS: String(payload.points),
    PRIOR_POINTS: payload.priorPoints === null ? 'none' : String(payload.priorPoints),
    REASON: payload.reason,
    CALLBACK_FILE,
  });
  const run = await runAgent(ctx, 'callback', issue.number, cwd, seat, prompt);
  const verdict = run.exitCode === 0 ? readResult<CallbackVerdict>(cwd, CALLBACK_FILE) : null;
  const usable = verdict && typeof verdict.outcome === 'string' && typeof verdict.reason === 'string' ? verdict : null;
  if (usable) say(`${name}.md: ${usable.outcome}; ${usable.reason}`);
  else if (run.exitCode !== 0) say(`${name}.md exited ${run.exitCode}`);
  else say(`${name}.md finished without a recorded outcome`);
  rmSync(cwd, { recursive: true, force: true });
  result.prompt = { exitCode: run.exitCode, verdict: usable };
  return result;
}

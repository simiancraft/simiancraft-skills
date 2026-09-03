/**
 * Appraisal: is an issue still real, and how big is it. One read-only agent turn per issue, no
 * worktree, no install, no writes to the repository. The answer lands on the issue as labels, a
 * comment, or a close, which is the only contract another skill (the burndown, a heartbeat, a
 * person) needs: they read the tracker, never this process.
 *
 * A close is the one verdict that is a write with consequences, so it gets a second opinion: a
 * confirmer on another engine re-checks the appraiser's receipt against the fetched base ref and
 * either agrees, in which case the issue closes, or disagrees, in which case the issue goes to a
 * human with both opinions on the thread. Sizing and hand-offs stay single-opinion; they are labels
 * a person can change.
 *
 * Fail-closed rules this file enforces itself, so no prompt drift can lose them: an agent's
 * answer is validated field by field and anything malformed reads as no answer; a close needs a
 * confirmation written by this run, for this issue; the prior size is read from the issue, never
 * from the agent; the issue's live state is re-read before anything is written; and every comment
 * lands before the label that would hide the issue from selection.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readResult, renderPrompt, runAgent } from '../../fix-github-issue/lib/agent.ts';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import { APPRAISAL_FILE, CONFIRMATION_FILE } from '../../fix-github-issue/lib/control-files.ts';
import type { Seat } from '../../fix-github-issue/lib/engines.ts';
import { closeIssue } from '../../fix-github-issue/lib/labels.ts';
import type { Issue } from '../../fix-github-issue/lib/pipeline.ts';
import { mutate, sh } from '../../fix-github-issue/lib/shell.ts';
import { runSizeCallback, type SizeCallbackResult } from './callbacks.ts';

export const APPRAISAL_VERDICTS = ['valid', 'already-fixed', 'obsolete', 'needs-decision', 'needs-human', 'failed'] as const;
export type AppraisalVerdict = (typeof APPRAISAL_VERDICTS)[number];

/** What the appraiser writes to `loop-appraisal.json`, after validation. */
export type AppraisalResult = {
  issue: number;
  verdict: AppraisalVerdict;
  points?: number;
  reason: string;
  closeComment?: string;
};

/** What the confirmer writes to `loop-confirmation.json`, after validation. */
export type Confirmation = { issue: number; agree: boolean; reason: string };

/** What an appraisal did to the issue, for a caller that reports on it. */
export type AppraisalOutcome = {
  verdict: AppraisalVerdict;
  points?: number;
  reason: string;
  /** How the close was settled, when the verdict was a close. */
  close?: 'confirmed' | 'disputed' | 'unconfirmed' | 'skipped';
  /** True when the verdict changed nothing on the issue and the next run should try again. */
  retry?: boolean;
  /** What the size callback did, when a directory was given and a slot matched. */
  callback?: SizeCallbackResult;
};

export type AppraiseKnobs = {
  /** Only issues opened this recently are appraised. */
  ageDays: number;
  /** Issues appraised per run. */
  appraiseLimit: number;
  /** Appraisers at once; no worktree, so they are cheap. */
  appraiserConcurrency: number;
  /** Whether a close verdict needs the confirmer's agreement before the issue closes. */
  confirmCloses: boolean;
  /** Labels that keep an issue out of appraisal until a human removes them. */
  skipLabels: string[];
  /**
   * Where size callbacks live, relative to the repository root. A producer writes `on-size-<N>`
   * files there; the appraiser only looks them up. See lib/callbacks.ts for the ladder.
   */
  callbacksDir: string;
  seats: { appraiser: string; confirmer: string; callback: string };
};

export const APPRAISE_DEFAULTS: AppraiseKnobs = {
  ageDays: 30,
  appraiseLimit: 12,
  appraiserConcurrency: 3,
  confirmCloses: true,
  skipLabels: ['needs-decision', 'needs-human', 'loop/skip', 'loop/parked'],
  callbacksDir: '<worktreeRoot>/appraisal-callbacks',
  seats: {
    appraiser: 'codex:gpt-5.6-sol',
    confirmer: 'claude:claude-opus-5',
    /** A callback prompt runs here; by default the appraiser's own seat. */
    callback: 'codex:gpt-5.6-sol',
  },
};

/** `callbacksDir` resolved: `<worktreeRoot>` expands to the project's worktree root, else the path is relative to the repository root. */
export function resolveCallbacksDir(ctx: Context, configured: string): string {
  const expanded = configured.replace('<worktreeRoot>', ctx.project.worktreeRoot);
  return resolve(ctx.repoRoot, expanded);
}

/**
 * `confirmCloses` is the one boolean whose falsy misreadings all fail open, so it is validated
 * strictly rather than coerced. Call after `loadProjectConfig`, which validates only its own knobs.
 */
export function assertConfirmCloses(value: unknown, fileName: string): void {
  if (typeof value !== 'boolean') {
    console.error(`config ${fileName} is invalid:\n  - confirmCloses must be true or false, got ${JSON.stringify(value)}`);
    process.exit(1);
  }
}

const SIZE_LABEL = /^size:\s*(\d+)$/;

/** The largest size label the issue carries, or null when unsized. Max, because a relabel is add-then-remove. */
export function pointsFromLabels(labels: Array<{ name: string }>): number | null {
  let points: number | null = null;
  for (const label of labels) {
    const match = SIZE_LABEL.exec(label.name);
    if (match) points = Math.max(points ?? 0, Number(match[1]));
  }
  return points;
}

/** The size label names the issue carries, as they are spelled on the issue. */
function sizeLabels(labels: Array<{ name: string }>): string[] {
  return labels.map((l) => l.name).filter((name) => SIZE_LABEL.test(name));
}

export function allOpenIssues(ctx: Context): Issue[] {
  return JSON.parse(
    sh(ctx, ['gh', 'issue', 'list', '--state', 'open', '--limit', '500', '--json', 'number,title,createdAt,labels']),
  );
}

/**
 * The population an appraiser run works: open, inside the window unless `allAges`, not held by a
 * skip label or the dead-letter queue, and unsized unless `includeSized`. Newest first.
 */
export function selectForAppraisal(
  all: Issue[],
  knobs: Pick<AppraiseKnobs, 'ageDays' | 'skipLabels'>,
  options: { allAges?: boolean; includeSized?: boolean } = {},
): Issue[] {
  const cutoff = Date.now() - knobs.ageDays * 24 * 60 * 60 * 1000;
  return all
    .filter((issue) => options.allAges || Date.parse(issue.createdAt) >= cutoff)
    .filter((issue) => !isHeld(issue.labels, knobs.skipLabels))
    .filter((issue) => options.includeSized || pointsFromLabels(issue.labels) === null)
    .sort((a, b) => b.number - a.number);
}

/** True when a person's label holds the issue out of the loop's reach. */
export function isHeld(labels: Array<{ name: string }>, skipLabels: string[]): boolean {
  return labels.some((l) => skipLabels.includes(l.name) || l.name === 'loop/dlq');
}

// ---------------------------------------------------------------------------
// Validation: an agent's answer is data, and malformed data is no answer.
// ---------------------------------------------------------------------------

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

function validateAppraisal(raw: unknown, issue: number): { ok: true; result: AppraisalResult } | { ok: false; why: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, why: 'not an object' };
  const r = raw as Record<string, unknown>;
  if (r.issue !== issue) return { ok: false, why: `names issue ${JSON.stringify(r.issue)}, not #${issue}` };
  if (!APPRAISAL_VERDICTS.includes(r.verdict as AppraisalVerdict)) return { ok: false, why: `unknown verdict ${JSON.stringify(r.verdict)}` };
  if (!nonEmptyString(r.reason)) return { ok: false, why: 'no reason' };
  if (r.points !== undefined && r.points !== null && (!Number.isInteger(r.points) || (r.points as number) <= 0)) {
    return { ok: false, why: `points must be a positive integer, got ${JSON.stringify(r.points)}` };
  }
  if (r.closeComment !== undefined && r.closeComment !== null && typeof r.closeComment !== 'string') {
    return { ok: false, why: 'closeComment must be a string' };
  }
  return {
    ok: true,
    result: {
      issue,
      verdict: r.verdict as AppraisalVerdict,
      points: typeof r.points === 'number' ? r.points : undefined,
      reason: r.reason.trim(),
      closeComment: nonEmptyString(r.closeComment) ? r.closeComment.trim() : undefined,
    },
  };
}

function validateConfirmation(raw: unknown, issue: number): { ok: true; result: Confirmation } | { ok: false; why: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, why: 'not an object' };
  const r = raw as Record<string, unknown>;
  if (r.issue !== issue) return { ok: false, why: `names issue ${JSON.stringify(r.issue)}, not #${issue}` };
  if (typeof r.agree !== 'boolean') return { ok: false, why: `agree must be true or false, got ${JSON.stringify(r.agree)}` };
  if (!nonEmptyString(r.reason)) return { ok: false, why: 'no reason' };
  return { ok: true, result: { issue, agree: r.agree, reason: r.reason.trim() } };
}

// ---------------------------------------------------------------------------
// The two agent turns
// ---------------------------------------------------------------------------

/**
 * Asks a second engine whether the appraiser's close holds. Returns the confirmation, or null when
 * the confirmer crashed, wrote nothing, or wrote something malformed; none of those is evidence.
 * The scratch directory is unique to this process so two drivers cannot read each other's answer.
 */
async function confirmClose(
  ctx: Context,
  issue: Issue,
  appraisal: AppraisalResult,
  confirmer: Seat,
  say: (message: string) => void,
): Promise<Confirmation | null> {
  const cwd = join(ctx.runDir, `confirm-${issue.number}-${process.pid}`);
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  const prompt = renderPrompt(ctx, 'confirm-close.md', {
    ISSUE: String(issue.number),
    TITLE: issue.title,
    VERDICT: appraisal.verdict,
    APPRAISER_REASON: appraisal.reason,
    CLOSE_COMMENT: appraisal.closeComment ?? appraisal.reason,
  });
  const run = await runAgent(ctx, 'confirmer', issue.number, cwd, confirmer, prompt);
  if (run.exitCode !== 0) {
    rmSync(cwd, { recursive: true, force: true });
    return null;
  }
  const checked = validateConfirmation(readResult<unknown>(cwd, CONFIRMATION_FILE), issue.number);
  if (!checked.ok) {
    say(`confirmer's answer is unusable (${checked.why}); kept at ${cwd}`);
    return null;
  }
  rmSync(cwd, { recursive: true, force: true });
  return checked.result;
}

/** The issue as GitHub holds it now; a verdict is applied to this, not to the snapshot selection made. */
function liveIssue(ctx: Context, number: number): { state: string; labels: Array<{ name: string }> } {
  return JSON.parse(sh(ctx, ['gh', 'issue', 'view', String(number), '--json', 'state,labels']));
}

/**
 * Appraises one issue and applies the verdict to the tracker. `onVerdict` fires once the
 * appraiser has answered and before anything is written, for a caller that keeps a board.
 */
export async function appraiseIssue(
  ctx: Context,
  issue: Issue,
  options: {
    ageDays: number;
    seats: { appraiser: Seat; confirmer: Seat };
    confirmCloses: boolean;
    skipLabels: string[];
    /** Where a producer put its size callbacks, and the seat a callback prompt runs on. */
    callbacks?: { dir: string; seat: Seat };
    onVerdict?: (outcome: AppraisalOutcome) => void;
  },
): Promise<AppraisalOutcome> {
  const say = (message: string) => ctx.log(`#${issue.number}  ${message}`);
  const cwd = join(ctx.runDir, `appraise-${issue.number}-${process.pid}`);
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });

  const prompt = renderPrompt(ctx, 'appraise.md', {
    ISSUE: String(issue.number),
    TITLE: issue.title,
    AGE_DAYS: String(options.ageDays),
  });
  const run = await runAgent(ctx, 'appraiser', issue.number, cwd, options.seats.appraiser, prompt);
  if (run.exitCode !== 0) {
    say(`appraiser exited ${run.exitCode}; its verdict is not trusted and the issue stays unsized`);
    rmSync(cwd, { recursive: true, force: true });
    return { verdict: 'failed', reason: `appraiser exited ${run.exitCode}`, retry: true };
  }
  if (ctx.dryRun) {
    rmSync(cwd, { recursive: true, force: true });
    return { verdict: 'failed', reason: 'dry run; no appraiser ran', retry: true };
  }
  const checked = validateAppraisal(readResult<unknown>(cwd, APPRAISAL_FILE), issue.number);
  if (!checked.ok) {
    say(`appraiser's answer is unusable (${checked.why}); leaving the issue unsized, scratch kept at ${cwd}`);
    return { verdict: 'failed', reason: `no usable appraisal: ${checked.why}`, retry: true };
  }
  const result = checked.result;
  say(`appraisal: ${result.verdict}${result.points ? ` at ${result.points} points` : ''}; ${result.reason}`);
  const outcome: AppraisalOutcome = { verdict: result.verdict, points: result.points, reason: result.reason };
  options.onVerdict?.(outcome);

  // The selection was a snapshot; a person, another driver, or a merge may have moved the issue
  // while the appraiser read it. Apply the verdict to the issue as it is now, or not at all.
  const live = liveIssue(ctx, issue.number);
  if (live.state !== 'OPEN') {
    say(`closed while being appraised; nothing applied`);
    rmSync(cwd, { recursive: true, force: true });
    return { ...outcome, verdict: 'failed', reason: 'issue closed while being appraised' };
  }
  if (isHeld(live.labels, options.skipLabels)) {
    say(`a hold label landed while it was being appraised; nothing applied`);
    rmSync(cwd, { recursive: true, force: true });
    return { ...outcome, verdict: 'failed', reason: 'issue held while being appraised' };
  }
  const priorSizes = sizeLabels(live.labels);
  const priorPoints = pointsFromLabels(live.labels);

  switch (result.verdict) {
    case 'already-fixed':
    case 'obsolete': {
      const closeComment = result.closeComment ?? result.reason;
      if (!options.confirmCloses) {
        await closeIssue(ctx, issue.number, closeComment, { kind: 'closed', reason: result.verdict, by: 'appraiser' });
        outcome.close = 'skipped';
        break;
      }
      const confirmation = await confirmClose(ctx, issue, result, options.seats.confirmer, say);
      if (!confirmation) {
        say('no usable confirmation; the close is not made and the issue stays unsized');
        outcome.close = 'unconfirmed';
        outcome.retry = true;
        break;
      }
      if (confirmation.agree) {
        say(`confirmer agrees: ${confirmation.reason}`);
        await closeIssue(ctx, issue.number, `${closeComment}\n\nIndependently re-checked: ${confirmation.reason}`, { kind: 'closed', reason: result.verdict, by: 'appraiser' });
        outcome.close = 'confirmed';
      } else {
        say(`confirmer disagrees: ${confirmation.reason}`);
        // Comment first, then the label that hides the issue from selection, so a crash between
        // the two leaves an issue that is still selectable rather than one held without a reason.
        mutate(ctx, `comment on #${issue.number}`, [
          'gh',
          'issue',
          'comment',
          String(issue.number),
          '--body',
          [
            `Appraisal proposed closing this as \`${result.verdict}\`, and an independent re-check disagreed; a person needs to settle it.`,
            '',
            `**Proposed close:** ${closeComment}`,
            '',
            `**Re-check:** ${confirmation.reason}`,
          ].join('\n'),
        ]);
        mutate(ctx, `label #${issue.number} needs-human`, ['gh', 'issue', 'edit', String(issue.number), '--add-label', 'needs-human']);
        outcome.close = 'disputed';
      }
      break;
    }

    case 'needs-decision':
    case 'needs-human':
      mutate(ctx, `comment on #${issue.number}`, ['gh', 'issue', 'comment', String(issue.number), '--body', result.reason]);
      mutate(ctx, `label #${issue.number} ${result.verdict}`, ['gh', 'issue', 'edit', String(issue.number), '--add-label', result.verdict]);
      break;

    case 'valid':
      if (!result.points) {
        say('appraiser called it valid but gave no size; leaving it for the next pass');
        outcome.retry = true;
        break;
      }
      if (priorPoints === result.points) {
        say(`already sized at ${result.points}; nothing to change`);
      } else {
        // Add the new size and only then note the disagreement; the prior label is left in place
        // because a person put it there, and `pointsFromLabels` reads the larger of the two.
        mutate(ctx, `size #${issue.number} at ${result.points}`, ['gh', 'issue', 'edit', String(issue.number), '--add-label', `size: ${result.points}`]);
        if (priorSizes.length > 0) {
          mutate(ctx, `note the sizing disagreement on #${issue.number}`, [
            'gh',
            'issue',
            'comment',
            String(issue.number),
            '--body',
            `Re-sized at ${result.points} points, previously \`${priorSizes.join('`, `')}\`. ${result.reason}`,
          ]);
        }
      }
      // The size is on the issue; what happens next for an issue of this size is the producer's.
      if (options.callbacks) {
        outcome.callback = await runSizeCallback(ctx, options.callbacks.dir, options.callbacks.seat, issue, {
          issue: issue.number,
          title: issue.title,
          points: result.points,
          priorPoints,
          verdict: 'valid',
          reason: result.reason,
          repo: ctx.project.repo,
          baseBranch: ctx.project.baseBranch,
        }, say);
      }
      break;

    case 'failed':
      outcome.retry = true;
      break;
  }
  if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  return outcome;
}

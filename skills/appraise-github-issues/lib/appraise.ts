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
import { isTrunk, trackerIo } from '../../carve-github-issue/lib/claims.ts';
import { liveClaim, readTree } from '../../carve-github-issue/lib/tree.ts';
import { logTail, readResult, renderPrompt, runAgent } from '../../fix-github-issue/lib/agent.ts';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import { APPRAISAL_FILE, CONFIRMATION_FILE } from '../../fix-github-issue/lib/control-files.ts';
import { assertDistinctEngines, type Seat } from '../../fix-github-issue/lib/engines.ts';
import { appraisalCount, clearAppraisals, closeIssue, recordAppraisal } from '../../fix-github-issue/lib/labels.ts';
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
  /** Failed appraisals an issue may absorb before it goes to a person; kept on the issue as `loop/appraisals: N`. */
  maxAppraiseAttempts: number;
  /** How long a size callback's executable may run; 0 means no timer, for a callback that runs agents. */
  sizeCallbackTimeoutMinutes: number;
  seats: { appraiser: string; confirmer: string; callback: string };
};

export const APPRAISE_DEFAULTS: AppraiseKnobs = {
  ageDays: 30,
  appraiseLimit: 12,
  appraiserConcurrency: 3,
  confirmCloses: true,
  maxAppraiseAttempts: 3,
  sizeCallbackTimeoutMinutes: 0,
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

export const ISSUE_LIST_FIELDS = 'number,title,createdAt,labels,parent,subIssuesSummary,blockedBy';

export function allOpenIssues(ctx: Context): Issue[] {
  return JSON.parse(sh(ctx, ['gh', 'issue', 'list', '--state', 'open', '--limit', '5000', '--json', ISSUE_LIST_FIELDS]));
}

/** The labels that mark a trunk or a claimed issue without reading its thread. */
const TRUNK_LABELS = ['loop/carved', 'loop/released', 'loop/carving', 'loop/working'];

/** True when the listing alone says the issue is a trunk or claimed: a trunk label, or an open child. */
export function looksLikeTrunk(issue: Issue): boolean {
  if (issue.labels.some((l) => TRUNK_LABELS.includes(l.name) || l.name.startsWith('loop/carve-gen'))) return true;
  const summary = issue.subIssuesSummary;
  return summary !== undefined && summary.total > summary.completed;
}

/**
 * The population an appraiser run works: open, inside the window unless `allAges` (an issue with a
 * parent is exempt from the window), not held by a skip label or the dead-letter queue, not a trunk
 * or a claimed issue, and unsized unless `includeSized`. Newest first.
 */
export function selectForAppraisal(
  all: Issue[],
  knobs: Pick<AppraiseKnobs, 'ageDays' | 'skipLabels'>,
  options: { allAges?: boolean; includeSized?: boolean } = {},
): Issue[] {
  const cutoff = Date.now() - knobs.ageDays * 24 * 60 * 60 * 1000;
  return all
    .filter((issue) => options.allAges || issue.parent || Date.parse(issue.createdAt) >= cutoff)
    .filter((issue) => !isHeld(issue.labels, knobs.skipLabels))
    .filter((issue) => !looksLikeTrunk(issue))
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

export function validateConfirmation(raw: unknown, issue: number): { ok: true; result: Confirmation } | { ok: false; why: string } {
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
export async function confirmClose(
  ctx: Context,
  issue: Issue,
  appraisal: Pick<AppraisalResult, 'verdict' | 'reason' | 'closeComment'>,
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

const ANNOUNCEMENT_FRESH_MS = 30 * 60 * 1000;

/** True when this account announced the same hand-off on this open issue within the last thirty minutes. */
function recentAnnouncement(ctx: Context, issue: number, marker: string): boolean {
  if (ctx.dryRun) return false;
  const node = trackerIo(ctx).view(issue);
  if (!node || node.state !== 'OPEN') return false;
  return node.comments.some((c) => c.author === ctx.botLogin && c.body.startsWith(marker) && Date.now() - Date.parse(c.createdAt) < ANNOUNCEMENT_FRESH_MS);
}

/** The hand-off intent: the announcement with its payload, then the hold label. */
function handOff(ctx: Context, issue: number, verdict: 'needs-decision' | 'needs-human', reason: string, extra: Record<string, unknown> = {}): void {
  const marker = `<!-- appraise-handoff verdict=${verdict} -->`;
  if (!recentAnnouncement(ctx, issue, marker)) {
    const body = [marker, '```json', JSON.stringify({ verdict, reason, ...extra }), '```', reason].join('\n');
    mutate(ctx, `comment on #${issue}`, ['gh', 'issue', 'comment', String(issue), '--body', body]);
  }
  mutate(ctx, `label #${issue} ${verdict}`, ['gh', 'issue', 'edit', String(issue), '--add-label', verdict]);
}

/** One more failed appraisal; at the cap the issue goes to a person with the log tail. */
function countFailedAppraisal(ctx: Context, issue: Issue, cap: number, reason: string, logPath: string | null, say: (m: string) => void): AppraisalOutcome {
  if (ctx.dryRun) return { verdict: 'failed', reason, retry: true };
  const attempts = recordAppraisal(ctx, issue.number, appraisalCount(issue.labels));
  say(`appraisal attempt ${attempts} of ${cap} failed: ${reason}`);
  if (attempts < cap) return { verdict: 'failed', reason, retry: true };
  const tail = logPath ? logTail(logPath) : 'no log';
  handOff(ctx, issue.number, 'needs-human', `The appraiser failed ${attempts} times on this issue and stops trying. Last failure: ${reason}. Log tail: ${tail}`, { attempts, logTail: tail });
  return { verdict: 'needs-human', reason: `handed off after ${attempts} failed appraisals: ${reason}` };
}

/**
 * Appraises one issue and applies the verdict to the tracker. `onVerdict` fires once the
 * appraiser has answered and before anything is written, for a caller that keeps a board.
 */
export async function appraiseIssue(
  ctx: Context,
  issue: Issue,
  options: {
    /** The window the driver applied; null when it applied none. Rendered into the prompt. */
    ageDays: number | null;
    seats: { appraiser: Seat; confirmer: Seat };
    confirmCloses: boolean;
    skipLabels: string[];
    maxAppraiseAttempts?: number;
    sizeCallbackTimeoutMinutes?: number;
    /** Where a producer put its size callbacks, and the seat a callback prompt runs on. */
    callbacks?: { dir: string; seat: Seat };
    /** Accept the one trunk carrying `loop/released`, size its remainder, and fire no size callback. */
    release?: boolean;
    /** The runId whose claim is not foreign; the burndown's release appraisal runs under its own. */
    ownClaim?: string;
    onVerdict?: (outcome: AppraisalOutcome) => void;
  },
): Promise<AppraisalOutcome> {
  const say = (message: string) => ctx.log(`#${issue.number}  ${message}`);
  const cap = options.maxAppraiseAttempts ?? APPRAISE_DEFAULTS.maxAppraiseAttempts;
  assertDistinctEngines(options.seats.appraiser, options.seats.confirmer, 'appraiser and confirmer');

  // A trunk is worked by closing its children, never re-sized while they are open; the one
  // exception is a released trunk the burndown asks this to finish.
  const io = trackerIo(ctx);
  const before = readTree(ctx, issue.number, io);
  const released = before.issue.labels.some((l) => l.name === 'loop/released');
  if (isTrunk(before) && !(options.release && released)) {
    say('a trunk is not appraised; it is worked by closing its children');
    return { verdict: 'failed', reason: 'a trunk is not appraised', retry: false };
  }

  const cwd = join(ctx.runDir, `appraise-${issue.number}-${process.pid}`);
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });

  const prompt = renderPrompt(ctx, 'appraise.md', {
    ISSUE: String(issue.number),
    TITLE: issue.title,
    AGE_DAYS: options.ageDays === null ? 'any' : String(options.ageDays),
  });
  const run = await runAgent(ctx, 'appraiser', issue.number, cwd, options.seats.appraiser, prompt);
  if (run.exitCode !== 0) {
    say(`appraiser exited ${run.exitCode}; its verdict is not trusted`);
    rmSync(cwd, { recursive: true, force: true });
    return countFailedAppraisal(ctx, issue, cap, `appraiser exited ${run.exitCode}`, run.logPath, say);
  }
  if (ctx.dryRun) {
    rmSync(cwd, { recursive: true, force: true });
    return { verdict: 'failed', reason: 'dry run; no appraiser ran', retry: true };
  }
  const checked = validateAppraisal(readResult<unknown>(cwd, APPRAISAL_FILE), issue.number);
  if (!checked.ok) {
    say(`appraiser's answer is unusable (${checked.why}); scratch kept at ${cwd}`);
    return countFailedAppraisal(ctx, issue, cap, `no usable appraisal: ${checked.why}`, run.logPath, say);
  }
  const result = checked.result;
  if (result.verdict === 'valid' && result.points !== undefined && !ctx.knobs.pointScale.includes(result.points)) {
    say(`appraiser sized it ${result.points}, which is not on the scale ${ctx.knobs.pointScale.join(', ')}`);
    return countFailedAppraisal(ctx, issue, cap, `size ${result.points} is not on the scale`, run.logPath, say);
  }
  say(`appraisal: ${result.verdict}${result.points ? ` at ${result.points} points` : ''}; ${result.reason}`);
  const outcome: AppraisalOutcome = { verdict: result.verdict, points: result.points, reason: result.reason };
  options.onVerdict?.(outcome);

  // The selection was a snapshot; a person, another driver, or a merge may have moved the issue
  // while the appraiser read it. Apply the verdict to the issue as it is now, or not at all.
  const now = readTree(ctx, issue.number, io);
  const live = { state: now.issue.state, labels: now.issue.labels };
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
  if (isTrunk(now) && !(options.release && now.issue.labels.some((l) => l.name === 'loop/released'))) {
    say('became a trunk while being appraised; nothing applied');
    rmSync(cwd, { recursive: true, force: true });
    return { ...outcome, verdict: 'failed', reason: 'issue became a trunk while being appraised', retry: false };
  }
  const foreign = liveClaim(now, new Date().toISOString(), options.ownClaim ?? ctx.runId);
  if (foreign) {
    say(`claimed by ${foreign.runId} while being appraised; nothing applied`);
    rmSync(cwd, { recursive: true, force: true });
    return { ...outcome, verdict: 'failed', reason: `issue claimed by ${foreign.runId} while being appraised`, retry: true };
  }
  const priorSizes = sizeLabels(live.labels);
  const priorPoints = pointsFromLabels(live.labels);
  // A verdict that lands clears the failure count; the next failure starts a fresh budget.
  if (result.verdict !== 'failed' && appraisalCount(live.labels) > 0) clearAppraisals(ctx, issue.number);

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
      handOff(ctx, issue.number, result.verdict, result.reason);
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
      // A released trunk fires no callback: the burndown that asked for the release appraisal
      // carves an oversized remainder itself, under the claim it already holds.
      if (options.callbacks && !options.release) {
        outcome.callback = await runSizeCallback(
          ctx,
          options.callbacks.dir,
          options.callbacks.seat,
          issue,
          {
            issue: issue.number,
            title: issue.title,
            points: result.points,
            priorPoints,
            verdict: 'valid',
            reason: result.reason,
            repo: ctx.project.repo,
            baseBranch: ctx.project.baseBranch,
            repoRoot: ctx.repoRoot,
          },
          say,
          { timeoutMs: (options.sizeCallbackTimeoutMinutes ?? APPRAISE_DEFAULTS.sizeCallbackTimeoutMinutes) * 60_000 },
        );
      }
      break;

    case 'failed':
      if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
      return countFailedAppraisal(ctx, issue, cap, result.reason, run.logPath, say);
  }
  if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  return outcome;
}

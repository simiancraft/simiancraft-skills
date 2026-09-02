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
 */

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readResult, renderPrompt, runAgent } from '../../fix-github-issue/lib/agent.ts';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import { APPRAISAL_FILE, CONFIRMATION_FILE } from '../../fix-github-issue/lib/control-files.ts';
import type { Seat } from '../../fix-github-issue/lib/engines.ts';
import { closeIssue } from '../../fix-github-issue/lib/labels.ts';
import type { Issue } from '../../fix-github-issue/lib/pipeline.ts';
import { mutate, sh } from '../../fix-github-issue/lib/shell.ts';

export type AppraisalVerdict = 'valid' | 'already-fixed' | 'obsolete' | 'needs-decision' | 'needs-human' | 'failed';

/** What the appraiser writes to `loop-appraisal.json`. */
export type AppraisalResult = {
  issue: number;
  verdict: AppraisalVerdict;
  points?: number;
  reason: string;
  closeComment?: string;
  priorSize?: string | null;
  disagrees?: boolean;
};

/** What the confirmer writes to `loop-confirmation.json`. */
export type Confirmation = { issue: number; agree: boolean; reason: string };

/** What an appraisal did to the issue, for a caller that reports on it. */
export type AppraisalOutcome = {
  verdict: AppraisalVerdict;
  points?: number;
  reason: string;
  /** How the close was settled, when the verdict was a close. */
  close?: 'confirmed' | 'disputed' | 'unconfirmed' | 'skipped';
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
  seats: { appraiser: string; confirmer: string };
};

export const APPRAISE_DEFAULTS: AppraiseKnobs = {
  ageDays: 30,
  appraiseLimit: 12,
  appraiserConcurrency: 3,
  confirmCloses: true,
  skipLabels: ['needs-decision', 'needs-human', 'loop/skip', 'loop/parked'],
  seats: {
    appraiser: 'codex:gpt-5.6-sol',
    confirmer: 'claude:claude-opus-5',
  },
};

/** The largest size label the issue carries, or null when unsized. */
export function pointsFromLabels(labels: Array<{ name: string }>): number | null {
  let points: number | null = null;
  for (const label of labels) {
    const match = /^size: (\d+)$/.exec(label.name);
    if (match) points = Math.max(points ?? 0, Number(match[1]));
  }
  return points;
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
    .filter((issue) => !issue.labels.some((l) => knobs.skipLabels.includes(l.name) || l.name === 'loop/dlq'))
    .filter((issue) => options.includeSized || pointsFromLabels(issue.labels) === null)
    .sort((a, b) => b.number - a.number);
}

/**
 * Asks a second engine whether the appraiser's close holds. Returns the confirmation, or null when
 * the confirmer crashed or wrote nothing, which is not evidence either way.
 */
async function confirmClose(ctx: Context, issue: Issue, appraisal: AppraisalResult, confirmer: Seat): Promise<Confirmation | null> {
  const cwd = join(ctx.runDir, `confirm-${issue.number}`);
  mkdirSync(cwd, { recursive: true });
  const prompt = renderPrompt(ctx, 'confirm-close.md', {
    ISSUE: String(issue.number),
    TITLE: issue.title,
    VERDICT: appraisal.verdict,
    APPRAISER_REASON: appraisal.reason,
    CLOSE_COMMENT: appraisal.closeComment ?? appraisal.reason,
  });
  const run = await runAgent(ctx, 'confirmer', issue.number, cwd, confirmer, prompt);
  const result = run.exitCode === 0 ? readResult<Confirmation>(cwd, CONFIRMATION_FILE) : null;
  rmSync(cwd, { recursive: true, force: true });
  if (!result || typeof result.agree !== 'boolean') return null;
  return result;
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
    onVerdict?: (outcome: AppraisalOutcome) => void;
  },
): Promise<AppraisalOutcome> {
  const say = (message: string) => ctx.log(`#${issue.number}  ${message}`);
  const cwd = join(ctx.runDir, `appraise-${issue.number}`);
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
    return { verdict: 'failed', reason: `appraiser exited ${run.exitCode}` };
  }
  const result = readResult<AppraisalResult>(cwd, APPRAISAL_FILE);
  rmSync(cwd, { recursive: true, force: true });
  if (!result) {
    say('appraiser wrote no verdict; leaving the issue unsized');
    return { verdict: 'failed', reason: 'no appraisal verdict' };
  }
  say(`appraisal: ${result.verdict}${result.points ? ` at ${result.points} points` : ''}; ${result.reason}`);
  const outcome: AppraisalOutcome = { verdict: result.verdict, points: result.points, reason: result.reason };
  options.onVerdict?.(outcome);

  switch (result.verdict) {
    case 'already-fixed':
    case 'obsolete': {
      const closeComment = result.closeComment ?? result.reason;
      if (!options.confirmCloses) {
        closeIssue(ctx, issue.number, closeComment);
        outcome.close = 'skipped';
        break;
      }
      const confirmation = await confirmClose(ctx, issue, result, options.seats.confirmer);
      if (!confirmation) {
        say('confirmer gave no usable answer; the close is not made and the issue stays unsized');
        outcome.close = 'unconfirmed';
        break;
      }
      if (confirmation.agree) {
        say(`confirmer agrees: ${confirmation.reason}`);
        closeIssue(ctx, issue.number, `${closeComment}\n\nIndependently re-checked: ${confirmation.reason}`);
        outcome.close = 'confirmed';
      } else {
        say(`confirmer disagrees: ${confirmation.reason}`);
        mutate(ctx, `label #${issue.number} needs-human`, ['gh', 'issue', 'edit', String(issue.number), '--add-label', 'needs-human']);
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
        outcome.close = 'disputed';
      }
      break;
    }

    case 'needs-decision':
    case 'needs-human':
      mutate(ctx, `label #${issue.number} ${result.verdict}`, ['gh', 'issue', 'edit', String(issue.number), '--add-label', result.verdict]);
      mutate(ctx, `comment on #${issue.number}`, ['gh', 'issue', 'comment', String(issue.number), '--body', result.reason]);
      break;

    case 'valid':
      if (result.points) {
        mutate(ctx, `size #${issue.number} at ${result.points}`, ['gh', 'issue', 'edit', String(issue.number), '--add-label', `size: ${result.points}`]);
        if (result.priorSize && result.priorSize !== `size: ${result.points}`) {
          // Add-then-remove so the issue never sits without a size between the two writes.
          mutate(ctx, `clear ${result.priorSize} on #${issue.number}`, ['gh', 'issue', 'edit', String(issue.number), '--remove-label', result.priorSize]);
        }
        if (result.disagrees && result.priorSize) {
          mutate(ctx, `note the sizing disagreement on #${issue.number}`, [
            'gh',
            'issue',
            'comment',
            String(issue.number),
            '--body',
            `Re-sized at ${result.points} points, previously \`${result.priorSize}\`. ${result.reason}`,
          ]);
        }
      } else {
        say('appraiser called it valid but gave no size; leaving it for the next pass');
      }
      break;

    case 'failed':
      break;
  }
  return outcome;
}

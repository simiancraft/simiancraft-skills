/**
 * What happens when a walk finds the environment wrong: diagnose from the ledger, the forge, and
 * the logs; file (or find) the `floor/incident` issue; hand it to the fix pipeline; and say how it
 * ended. Filing is intrinsic rather than a callback because the pipeline is issue-shaped.
 */

import { join } from 'node:path';
import { readResult, runAgent } from '../../fix-github-issue/lib/agent.ts';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import type { Seat } from '../../fix-github-issue/lib/engines.ts';
import { parkIssue } from '../../fix-github-issue/lib/labels.ts';
import { fixIssue, type FixOutcome } from '../../fix-github-issue/lib/pipeline.ts';
import { sh } from '../../fix-github-issue/lib/shell.ts';
import { type LedgerEntry, lastClean, readLedger } from './floor.ts';
import { mergedSince, type MergedPullRequest } from './forge.ts';
import { renderWalkerPrompt } from './prompts.ts';

export const INCIDENT_LABEL = 'floor/incident';
const DIAGNOSIS_FILE = 'floor-diagnosis.json';

export type Diagnosis = {
  culprit: { pullRequest: number; sha: string } | null;
  confidence: 'certain' | 'likely' | 'guess' | 'none';
  error: string;
  remedy: 'fix-forward' | 'revert' | 'outside-repository';
  summary: string;
};

export type IncidentResult = { issue: number; created: boolean; fix: FixOutcome | null; diagnosis: Diagnosis | null };

function readLogs(command: string | undefined, cwd: string): string {
  if (!command) return '';
  const proc = Bun.spawnSync(['sh', '-c', command], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  const text = `${proc.stdout.toString()}\n${proc.stderr.toString()}`.trim();
  return text.split('\n').slice(-200).join('\n');
}

function suspectsBetween(ctx: Context, lastGood: LedgerEntry | undefined, failed: LedgerEntry): MergedPullRequest[] {
  const since = lastGood?.checkedAt ?? new Date(Date.parse(failed.checkedAt) - 24 * 60 * 60 * 1000).toISOString();
  try {
    return mergedSince(ctx.project.repo, ctx.project.baseBranch, since, ctx.repoRoot)
      .filter((pr) => Date.parse(pr.mergedAt) <= Date.parse(failed.checkedAt))
      .reverse();
  } catch (error) {
    ctx.log(`could not list merges from the forge: ${(error as Error).message}`);
    return [];
  }
}

function renderSuspects(suspects: MergedPullRequest[]): string {
  if (suspects.length === 0) return '(nothing merged between the two revisions)';
  return suspects
    .map((pr) => `- #${pr.number} \`${pr.mergeCommit.slice(0, 12)}\` ${pr.mergedAt} ${pr.title}\n  paths: ${pr.paths.slice(0, 12).join(', ')}${pr.paths.length > 12 ? ', …' : ''}`)
    .join('\n');
}

/** The title every incident for an item carries, so lookups match whole titles rather than substrings. */
export function incidentTitle(itemId: string, verdict: string): string {
  return `floor: ${itemId} is ${verdict}`;
}

/** An open incident already naming this item, or null. */
export function openIncidentFor(ctx: Context, itemId: string): number | null {
  const raw = sh(ctx, [
    'gh', 'issue', 'list', '--state', 'open', '--label', INCIDENT_LABEL, '--limit', '50', '--json', 'number,title',
  ]);
  const rows = JSON.parse(raw) as Array<{ number: number; title: string }>;
  const prefix = `floor: ${itemId} is `;
  return rows.find((row) => row.title.startsWith(prefix))?.number ?? null;
}

export function ensureIncidentLabel(ctx: Context): void {
  const existing = sh(ctx, ['gh', 'label', 'list', '--limit', '200', '--json', 'name', '--jq', '.[].name']).split('\n');
  if (existing.includes(INCIDENT_LABEL)) return;
  sh(ctx, ['gh', 'label', 'create', INCIDENT_LABEL, '--color', 'b60205', '--description', 'A walk of the running environment found it wrong', '--force']);
}

export async function handleIncident(
  ctx: Context,
  options: {
    dir: string;
    entry: LedgerEntry;
    checkout: string;
    walker: Seat;
    logsCommand?: string;
    maxPoints: number;
  },
): Promise<IncidentResult> {
  const { dir, entry, checkout, walker } = options;
  const ledger = readLedger(dir);
  const lastGood = lastClean(ledger);
  const suspects = suspectsBetween(ctx, lastGood, entry);
  const logs = readLogs(options.logsCommand, ctx.invokeRoot);

  // Diagnosis is one agent turn, read-only, in the checkout at the failing revision.
  let diagnosis: Diagnosis | null = null;
  if (!ctx.dryRun) {
    const prompt = renderWalkerPrompt(ctx, 'diagnose.md', {
      ENTRY: JSON.stringify(entry, null, 2),
      LAST_GOOD: lastGood ? JSON.stringify(lastGood, null, 2) : '(no clean walk on record)',
      SUSPECTS: renderSuspects(suspects),
      LOGS: logs || '(no logs command configured, or it printed nothing)',
      CHECKOUT: checkout,
      DIAGNOSIS_FILE: join(checkout, DIAGNOSIS_FILE),
    });
    const run = await runAgent(ctx, 'diagnose', 0, checkout, walker, prompt);
    if (run.exitCode === 0) diagnosis = readResult<Diagnosis>(checkout, DIAGNOSIS_FILE);
    if (!diagnosis) ctx.log('the diagnosis turn produced no usable answer; filing the incident without one');
  }

  const title = incidentTitle(entry.itemId, entry.verdict);
  const existing = ctx.dryRun ? null : openIncidentFor(ctx, entry.itemId);
  let issue = existing;
  if (issue === null) {
    const body = [
      `A walk of the running environment found \`${entry.itemId}\` **${entry.verdict}** at ${entry.checkedAt}.`,
      '',
      '## The failing walk',
      '```json',
      JSON.stringify(entry, null, 2),
      '```',
      '',
      '## The last clean walk',
      lastGood ? '```json\n' + JSON.stringify(lastGood, null, 2) + '\n```' : '(none on record)',
      '',
      '## Merged between the two',
      renderSuspects(suspects),
      '',
      '## Diagnosis',
      diagnosis
        ? [
            `Culprit: ${diagnosis.culprit ? `#${diagnosis.culprit.pullRequest} (\`${diagnosis.culprit.sha.slice(0, 12)}\`)` : 'none named'} (${diagnosis.confidence})`,
            diagnosis.error ? `Error: \`${diagnosis.error}\`` : '',
            `Remedy: ${diagnosis.remedy}`,
            '',
            diagnosis.summary,
          ].filter((line) => line !== '').join('\n')
        : '(no diagnosis)',
      '',
      '## Log excerpt',
      '```',
      logs.split('\n').slice(-40).join('\n') || '(none)',
      '```',
      '',
      entry.evidence ? `Evidence: \`${entry.evidence}\` on the walker's floor.` : '',
    ].join('\n');
    if (ctx.dryRun) {
      ctx.log(`  DRY RUN  would file incident "${title}"`);
      return { issue: 0, created: false, fix: null, diagnosis };
    }
    ensureIncidentLabel(ctx);
    const url = sh(ctx, ['gh', 'issue', 'create', '--title', title, '--body', body, '--label', INCIDENT_LABEL]);
    issue = Number(url.trim().split('/').pop());
    ctx.log(`filed incident #${issue}: ${title}`);
  } else {
    ctx.log(`incident #${issue} is already open for ${entry.itemId}; not filing again`);
  }

  // A remedy outside the repository (a reindex, a config value, a vendor outage) is not code; a
  // worker would only spend a lane proving that. Park it for a person with the diagnosis attached.
  if (diagnosis?.remedy === 'outside-repository') {
    if (existing === null) {
      parkIssue(ctx, issue, 'The diagnosis places the remedy outside this repository, so no fix was attempted; a person has to act on the environment. See the diagnosis above.');
    }
    ctx.log(`incident #${issue}: parked; the remedy is outside the repository`);
    return { issue, created: existing === null, fix: null, diagnosis };
  }

  // The fix is the pipeline's job, exactly as for any other issue.
  const fix = await fixIssue(
    ctx,
    { number: issue, title, createdAt: new Date().toISOString(), labels: [] },
    { maxPoints: options.maxPoints },
  );
  ctx.log(`incident #${issue}: ${fix.outcome}; ${fix.reason}`);
  return { issue, created: existing === null, fix, diagnosis };
}

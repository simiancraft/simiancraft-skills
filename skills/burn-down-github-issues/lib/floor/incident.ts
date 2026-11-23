/**
 * What happens when a walk finds the environment wrong: diagnose from the ledger, the forge, and
 * the logs; file (or find) the `floor/incident` issue; hand it to the fix pipeline; and say how it
 * ended. Filing is intrinsic rather than a callback because the pipeline is issue-shaped.
 */

import { join } from 'node:path';
import { readResult, renderPrompt, runAgent } from '../../../fix-github-issue/lib/agent.ts';
import type { BoundaryChange, Context, MergingIssue } from '../../../fix-github-issue/lib/context.ts';
import type { Seat } from '../../../fix-github-issue/lib/engines.ts';
import { ensureLabels, parkIssue } from '../../../fix-github-issue/lib/labels.ts';
import { enrichBlockers } from '../../../fix-github-issue/lib/blockers.ts';
import { fixIssue, type FixOutcome, type Issue } from '../../../fix-github-issue/lib/pipeline.ts';
import { sh } from '../../../fix-github-issue/lib/shell.ts';
import { type LedgerEntry, lastClean, pending, readLedger, readList } from './ledger.ts';
import type { FloorCause } from './line.ts';
import { type Lineage, renderLineage } from './lineage.ts';

type MergedPullRequest = { number: number; title: string; mergedAt: string; mergeCommit: string; paths: string[] };

/** Pull requests merged into the base since `since`, newest first, from the forge. */
export function mergedSince(ctx: Context, since: string): MergedPullRequest[] {
  const raw = sh(ctx, [
    'gh', 'pr', 'list', '-R', ctx.project.repo, '--state', 'merged', '--base', ctx.project.baseBranch, '--limit', '100',
    '--search', `merged:>=${since.slice(0, 10)}`, '--json', 'number,title,mergedAt,mergeCommit,files',
  ]);
  const rows = JSON.parse(raw) as Array<{ number: number; title: string; mergedAt: string; mergeCommit: { oid: string } | null; files: Array<{ path: string }> }>;
  return rows
    .filter((pr) => Date.parse(pr.mergedAt) >= Date.parse(since))
    .map((pr) => ({ number: pr.number, title: pr.title, mergedAt: pr.mergedAt, mergeCommit: pr.mergeCommit?.oid ?? '', paths: pr.files.map((f) => f.path) }))
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
}

export const INCIDENT_LABEL = 'floor/incident';

/**
 * The merge boundary's hold for a floor incident's fix. A fix that repairs forward lands as any
 * other change does. One that undoes a recently merged pull request parks for a person whatever
 * `autoMerge` says: its premise is a walk of a live environment, which can be wrong (a deploy still
 * running reads as absent), and undoing reviewed work on a wrong premise is the costly mistake.
 * `reverted` says what the fix undoes, or null when it undoes nothing.
 */
export function incidentHold(issue: MergingIssue, reverted: () => string | null): string | null {
  if (!issue.labels.some((label) => label.name === INCIDENT_LABEL)) return null;
  const undoes = reverted();
  return undoes ? `a ${INCIDENT_LABEL} fix that ${undoes} acts on evidence from a live environment, so a person confirms it` : null;
}

/** A recently merged pull request an incident's fix must not undo unattended. */
export type RecentMerge = { pullRequest?: number; sha: string };

/** The culprit an incident's body names (`Culprit: #12 (`abc…`)`), or null. */
export function culpritOf(body: string): RecentMerge | null {
  const match = /^Culprit: #(\d+) \(`([0-9a-f]{7,40})`\)/m.exec(body);
  return match ? { pullRequest: Number(match[1]), sha: match[2] } : null;
}

/**
 * The merges an incident's fix is checked against: the culprit its diagnosis named, and every merge
 * still on the floor (owed a verdict, the failing one among them). A tracker that cannot be read
 * leaves the floor's merges.
 */
export function recentMerges(ctx: Context, issue: number, floorDir: string): RecentMerge[] {
  const out: RecentMerge[] = [];
  try {
    const culprit = culpritOf(sh(ctx, ['gh', 'issue', 'view', String(issue), '--json', 'body', '--jq', '.body']));
    if (culprit) out.push(culprit);
  } catch (error) {
    ctx.log(`could not read incident #${issue}'s culprit: ${(error as Error).message}`);
  }
  for (const item of pending(readList(floorDir), readLedger(floorDir))) {
    if (item.ref?.sha) out.push({ pullRequest: item.ref.pullRequest, sha: item.ref.sha });
  }
  return out;
}

function git(cwd: string, args: string[]): string | null {
  const proc = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return proc.exitCode === 0 ? proc.stdout.toString() : null;
}

/** Lines a diff adds and removes, trimmed, less those with no letter or digit (braces, blank lines). */
function diffLines(diff: string): { added: Set<string>; removed: Set<string> } {
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const text = line.slice(1).trim();
    if (!/[A-Za-z0-9]/.test(text)) continue;
    if (line.startsWith('+')) added.add(text);
    else if (line.startsWith('-')) removed.add(text);
  }
  return { added, removed };
}

function nameStatus(out: string | null): Map<string, string> {
  const files = new Map<string, string>();
  for (const line of (out ?? '').split('\n')) {
    const [status, path] = line.split('\t');
    if (status && path) files.set(path, status[0]);
  }
  return files;
}

/**
 * What the change on `cwd`'s HEAD (against its merge base with `base`) undoes of these merges, or
 * null when it moves none of them back toward its parent. It undoes a merge when it is a
 * `git revert` of it, deletes a file the merge added, restores one it deleted, puts back a line it
 * removed, or only removes lines it added from a file. A forward repair that rewrites the merge's
 * lines into new ones undoes nothing. A merge that cannot be read is not counted.
 */
export function revertOf(cwd: string, base: string, merges: RecentMerge[]): string | null {
  const from = git(cwd, ['merge-base', base, 'HEAD'])?.trim();
  if (!from) return null;
  const messages = git(cwd, ['log', '--format=%B', `${from}..HEAD`]) ?? '';
  const reverts = [...messages.matchAll(/This reverts commit ([0-9a-f]{7,40})/g)].map((m) => m[1]);
  const fixFiles = nameStatus(git(cwd, ['diff', '--no-renames', '--name-status', from, 'HEAD']));
  const seen = new Set<string>();
  for (const merge of merges) {
    const sha = git(cwd, ['rev-parse', '--verify', '--quiet', `${merge.sha}^{commit}`])?.trim();
    const parent = sha && git(cwd, ['rev-parse', '--verify', '--quiet', `${sha}^1`])?.trim();
    if (!sha || !parent || seen.has(sha)) continue;
    seen.add(sha);
    const name = `${merge.pullRequest ? `#${merge.pullRequest}` : 'the merge'} (${sha.slice(0, 10)})`;
    if (reverts.some((r) => sha.startsWith(r))) return `reverts ${name}`;
    const mergeFiles = nameStatus(git(cwd, ['diff', '--no-renames', '--name-status', parent, sha]));
    for (const [path, status] of fixFiles) {
      const theirs = mergeFiles.get(path);
      if (!theirs) continue;
      if (theirs === 'A' && status === 'D') return `undoes ${name}: deletes ${path}, which it added`;
      if (theirs === 'D' && status === 'A') return `undoes ${name}: restores ${path}, which it deleted`;
      const merged = diffLines(git(cwd, ['diff', '--no-renames', '-U0', parent, sha, '--', path]) ?? '');
      const fixed = diffLines(git(cwd, ['diff', '--no-renames', '-U0', from, 'HEAD', '--', path]) ?? '');
      if ([...fixed.added].some((line) => merged.removed.has(line))) return `undoes ${name}: puts back lines it removed from ${path}`;
      if (fixed.added.size === 0 && [...fixed.removed].some((line) => merged.added.has(line))) return `undoes ${name}: only removes lines it added to ${path}`;
    }
  }
  return null;
}
const DIAGNOSIS_FILE = 'floor-diagnosis.json';

export type Diagnosis = {
  culprit: { pullRequest: number; sha: string } | null;
  confidence: 'certain' | 'likely' | 'guess' | 'none';
  error: string;
  /** `owed-by-sibling`: an open sibling under the failed item's trunk owns the missing effect. */
  remedy: 'fix-forward' | 'revert' | 'outside-repository' | 'owed-by-sibling';
  /** For `owed-by-sibling`: that sibling's issue number. */
  sibling?: number;
  summary: string;
};

export type IncidentResult = {
  issue: number;
  created: boolean;
  fix: FixOutcome | null;
  diagnosis: Diagnosis | null;
  /** True when a person now owns the incident, so walking it again should not start another fix. */
  withAPerson: boolean;
  /** Where the diagnosis places the remedy; null when no diagnosis was asked (a person already owns the incident). */
  cause: FloorCause | null;
};

/**
 * Where a diagnosis places the remedy. No usable answer is a cause nobody knows, which the line
 * treats as the repository's to repair: not knowing is not knowing it is someone else's.
 */
export function causeOf(diagnosis: Diagnosis | null): FloorCause {
  if (diagnosis?.remedy === 'outside-repository') return 'outside-repository';
  if (diagnosis?.remedy === 'fix-forward' || diagnosis?.remedy === 'revert') return 'in-repository';
  return 'cause-unknown';
}

/** Labels the fix pipeline leaves when it stops and hands an issue to a person. */
const HUMAN_LABELS = new Set(['loop/parked', 'needs-human', 'needs-decision', 'loop/skip']);
/** A dead letter is with the loop's triage or a person, never back in a worker's hands on its own. */
const withAPersonOrTriage = (name: string) => HUMAN_LABELS.has(name) || name === 'loop/dlq' || name.startsWith('loop/dlq:');

function readLogs(command: string | undefined, cwd: string): string {
  if (!command) return '';
  const proc = Bun.spawnSync(['sh', '-c', command], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  const text = `${proc.stdout.toString()}\n${proc.stderr.toString()}`.trim();
  return text.split('\n').slice(-200).join('\n');
}

/**
 * Merges between the last clean walk and the failure. An absent item reaches back to its own merge
 * as well: the clean probe at the start of the same walk would otherwise leave no suspects at all.
 */
function suspectsBetween(ctx: Context, lastGood: LedgerEntry | undefined, failed: LedgerEntry, mergedAt?: string): MergedPullRequest[] {
  const floor = Date.parse(failed.checkedAt) - 24 * 60 * 60 * 1000;
  const candidates = [lastGood?.checkedAt, mergedAt && new Date(Date.parse(mergedAt) - 60_000).toISOString()].filter((at): at is string => !!at);
  const since = candidates.length > 0 ? candidates.sort()[0] : new Date(floor).toISOString();
  try {
    return mergedSince(ctx, since).filter((pr) => pr.mergeCommit && Date.parse(pr.mergedAt) <= Date.parse(failed.checkedAt));
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

/** An open incident already naming this item, with whether a person owns it, or null. */
export function openIncidentFor(ctx: Context, itemId: string): { number: number; withAPerson: boolean } | null {
  const raw = sh(ctx, [
    'gh', 'issue', 'list', '--state', 'open', '--label', INCIDENT_LABEL, '--limit', '50', '--json', 'number,title,labels',
  ]);
  const rows = JSON.parse(raw) as Array<{ number: number; title: string; labels: Array<{ name: string }> }>;
  const prefix = `floor: ${itemId} is `;
  const row = rows.find((candidate) => candidate.title.startsWith(prefix));
  if (!row) return null;
  return { number: row.number, withAPerson: row.labels.some((label) => withAPersonOrTriage(label.name)) };
}

export function ensureIncidentLabel(ctx: Context): void {
  const existing = sh(ctx, ['gh', 'label', 'list', '--limit', '200', '--json', 'name', '--jq', '.[].name']).split('\n');
  if (existing.includes(INCIDENT_LABEL)) return;
  sh(ctx, ['gh', 'label', 'create', INCIDENT_LABEL, '--color', 'b60205', '--description', 'A walk of the running environment found it wrong', '--force']);
}

type DiagnoseOptions = {
  dir: string;
  entry: LedgerEntry;
  checkout: string;
  walker: Seat;
  logsCommand?: string;
  /** When the failed item merged, for an `absent` item. */
  mergedAt?: string;
  /** Where the failed item's issue sits in a carved trunk, when it has one. */
  lineage?: Lineage | null;
};

type Evidence = { lastGood: LedgerEntry | undefined; suspects: MergedPullRequest[]; logs: string };

function gather(ctx: Context, options: DiagnoseOptions): Evidence {
  const lastGood = lastClean(readLedger(options.dir));
  return { lastGood, suspects: suspectsBetween(ctx, lastGood, options.entry, options.mergedAt), logs: readLogs(options.logsCommand, ctx.invokeRoot) };
}

/**
 * One agent turn, read-only, in the checkout at the failing revision. Null in a dry run, or when the
 * turn produced no usable answer.
 */
export async function diagnose(ctx: Context, options: DiagnoseOptions, evidence: Evidence = gather(ctx, options)): Promise<Diagnosis | null> {
  if (ctx.dryRun) return null;
  const { entry, checkout } = options;
  const { lastGood, suspects, logs } = evidence;
  const prompt = renderPrompt(ctx, 'diagnose.md', {
    ENTRY: JSON.stringify(entry, null, 2),
    LAST_GOOD: lastGood ? JSON.stringify(lastGood, null, 2) : '(no clean walk on record)',
    SUSPECTS: renderSuspects(suspects),
    LOGS: logs || '(no logs command configured, or it printed nothing)',
    LINEAGE: options.lineage ? renderLineage(options.lineage) : '(the failed item names no issue, or its issue could not be read)',
    CHECKOUT: checkout,
    DIAGNOSIS_FILE: join(checkout, DIAGNOSIS_FILE),
  });
  const run = await runAgent(ctx, 'diagnose', 0, checkout, options.walker, prompt);
  return run.exitCode === 0 ? readResult<Diagnosis>(checkout, DIAGNOSIS_FILE) : null;
}

export async function handleIncident(
  ctx: Context,
  options: DiagnoseOptions & {
    maxPoints: number;
    /** A diagnosis this walk already made for the entry; undefined to make one here. */
    diagnosis?: Diagnosis | null;
    /** Told where the diagnosis places the remedy as soon as it answers, before anything is filed or fixed. */
    onDiagnosed?: (cause: FloorCause) => void;
  },
): Promise<IncidentResult> {
  const { entry } = options;
  const evidence = gather(ctx, options);
  const { lastGood, suspects, logs } = evidence;

  // An incident already open for this item, checked first: one a person owns needs no diagnosis
  // turn and no fix, only the fresh ledger entry the walk just wrote.
  const existing = ctx.dryRun ? null : openIncidentFor(ctx, entry.itemId);
  if (existing?.withAPerson) {
    ctx.log(`incident #${existing.number} is already open for ${entry.itemId} and with a person; not working it again`);
    return { issue: existing.number, created: false, fix: null, diagnosis: null, withAPerson: true, cause: null };
  }

  const diagnosis = options.diagnosis !== undefined ? options.diagnosis : await diagnose(ctx, options, evidence);
  if (!ctx.dryRun) {
    if (!diagnosis) ctx.log('the diagnosis turn produced no usable answer; filing the incident without one');
    options.onDiagnosed?.(causeOf(diagnosis));
  }

  const title = incidentTitle(entry.itemId, entry.verdict);
  let issue = existing?.number ?? null;
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
      entry.evidence ? `Evidence: \`${entry.evidence}\` on the floor.` : '',
    ].join('\n');
    if (ctx.dryRun) {
      ctx.log(`  DRY RUN  would file incident "${title}"`);
      return { issue: 0, created: false, fix: null, diagnosis, withAPerson: false, cause: null };
    }
    ensureIncidentLabel(ctx);
    const url = sh(ctx, ['gh', 'issue', 'create', '--title', title, '--body', body, '--label', INCIDENT_LABEL]);
    issue = Number(url.trim().split('/').pop());
    ctx.log(`filed incident #${issue}: ${title}`);
  } else {
    ctx.log(`incident #${issue} is already open for ${entry.itemId}; not filing again`);
  }

  // An incident is parked, or handed to the fix pipeline, and both write the loop's own labels. On a
  // repository no other driver has run against those do not exist yet, whether this incident was
  // just filed or was already open.
  if (!ctx.dryRun) ensureLabels(ctx);

  // A remedy outside the repository (a reindex, a config value, a vendor outage) is not code; a
  // worker would only spend a lane proving that. Park it for a person with the diagnosis attached.
  if (diagnosis?.remedy === 'outside-repository') {
    // A new incident carries the diagnosis in its body; an open one learns it here, with the park,
    // or every wake would diagnose it again and every other driver would still read it as work.
    const where = existing === null ? 'See the diagnosis above.' : `Diagnosis (${diagnosis.confidence}): ${diagnosis.summary}`;
    parkIssue(ctx, issue, `The diagnosis places the remedy outside this repository, so no fix was attempted; a person has to act on the environment. ${where}`);
    ctx.log(`incident #${issue}: parked; the remedy is outside the repository`);
    return { issue, created: existing === null, fix: null, diagnosis, withAPerson: true, cause: 'outside-repository' };
  }

  // The fix is the pipeline's job, exactly as for any other issue. The issue is read live, labels and
  // all: the pipeline's attempt and review budgets are counted on them, and an incident walked every
  // wake would otherwise start from zero each time and never run out.
  const live = JSON.parse(sh(ctx, ['gh', 'issue', 'view', String(issue), '--json', 'number,title,createdAt,labels,parent,subIssuesSummary,blockedBy'])) as Issue;
  enrichBlockers(ctx, [live]);
  const fix = await fixIssue(ctx, live, { maxPoints: options.maxPoints });
  ctx.log(`incident #${issue}: ${fix.outcome}; ${fix.reason}`);
  return { issue, created: existing === null, fix, diagnosis, withAPerson: ownedNow(ctx, entry.itemId), cause: causeOf(diagnosis) };
}

/**
 * Whether a person owns the incident after its fix ran, read from the tracker as it stands now: a
 * fix that did not merge (unjudged, busy, stopped) is the pipeline's to retry, not a person's. A
 * tracker that cannot be read keeps the incident with a person, as the floor's readout does.
 */
function ownedNow(ctx: Context, itemId: string): boolean {
  try {
    return openIncidentFor(ctx, itemId)?.withAPerson ?? false;
  } catch {
    return true;
  }
}

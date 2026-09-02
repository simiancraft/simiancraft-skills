/**
 * The forge producer: list items for pull requests merged into the base since the walker last
 * looked, asked of GitHub rather than of anyone's memory, so a merge the burndown did not make is
 * walked all the same.
 */

import { appendItem, readList, type ListItem } from './floor.ts';

export type MergedPullRequest = {
  number: number;
  title: string;
  mergeCommit: string;
  mergedAt: string;
  paths: string[];
};

export function itemId(pullRequest: number): string {
  return `pull-request:${pullRequest}`;
}

export function mergedSince(repo: string, baseBranch: string, sinceIso: string, cwd: string): MergedPullRequest[] {
  const since = sinceIso.slice(0, 19).replace('T', 'T');
  const proc = Bun.spawnSync(
    [
      'gh', 'pr', 'list', '-R', repo, '--state', 'merged', '--base', baseBranch, '--limit', '100',
      '--search', `merged:>=${since}`,
      '--json', 'number,title,mergeCommit,mergedAt,files',
    ],
    { cwd, stderr: 'pipe' },
  );
  if (proc.exitCode !== 0) throw new Error(`gh pr list failed: ${proc.stderr.toString().trim()}`);
  const rows = JSON.parse(proc.stdout.toString()) as Array<{
    number: number;
    title: string;
    mergeCommit: { oid: string } | null;
    mergedAt: string;
    files: Array<{ path: string }>;
  }>;
  return rows
    .filter((row) => row.mergeCommit?.oid)
    .map((row) => ({
      number: row.number,
      title: row.title,
      mergeCommit: row.mergeCommit!.oid,
      mergedAt: row.mergedAt,
      paths: (row.files ?? []).map((f) => f.path),
    }))
    .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
}

/** The newest `mergedAt` among forge-sourced items on the list, or null when there are none. */
export function newestForgeItem(list: ListItem[]): string | null {
  let newest: string | null = null;
  for (const item of list) {
    const at = item.ref?.mergedAt;
    if (item.source === 'forge' && at && (!newest || Date.parse(at) > Date.parse(newest))) newest = at;
  }
  return newest;
}

/** Appends one item per merged pull request not already on the list. Returns how many it added. */
export function appendFromForge(dir: string, repo: string, baseBranch: string, sinceIso: string, cwd: string): number {
  const existing = new Set(readList(dir).map((item) => item.id));
  let added = 0;
  for (const pr of mergedSince(repo, baseBranch, sinceIso, cwd)) {
    const id = itemId(pr.number);
    if (existing.has(id)) continue;
    appendItem(dir, {
      id,
      addedAt: new Date().toISOString(),
      source: 'forge',
      text: pr.title,
      ref: { pullRequest: pr.number, sha: pr.mergeCommit, mergedAt: pr.mergedAt, paths: pr.paths },
    });
    existing.add(id);
    added += 1;
  }
  return added;
}

/**
 * What a walk learns before any agent runs. The liveness probe requests each health path under the
 * base URL with a short timeout; "up" means every path answered 2xx or 3xx. A path may be a string
 * (GET) or an object naming a method and body, so an API that rejects GET (a GraphQL endpoint with
 * CSRF protection) can still be probed with the request it accepts. Classification asks of each
 * merge whether there is evidence it is deployed: the deployed revision contains it, or, with no
 * revision to read, the deploy workflow's run for the merge commit completed successfully. Time
 * alone is never evidence: a merge without any is `not-yet-deployed`, and past the cap
 * `deploy-unconfirmed`. Either way it is not walked.
 */

import type { Context } from '../../../fix-github-issue/lib/context.ts';
import { sh } from '../../../fix-github-issue/lib/shell.ts';

export type HealthPath = string | { path: string; method?: string; body?: string; headers?: Record<string, string> };

export type ProbeResult = {
  up: boolean;
  results: Array<{ path: string; status: number | null; ms: number; error?: string }>;
};

export async function probe(baseUrl: string, healthPaths: HealthPath[], timeoutMs = 10_000): Promise<ProbeResult> {
  const results: ProbeResult['results'] = [];
  const paths: HealthPath[] = healthPaths.length > 0 ? healthPaths : ['/'];
  for (const entry of paths) {
    const spec = typeof entry === 'string' ? { path: entry } : entry;
    const url = new URL(spec.path, baseUrl).toString();
    const started = Date.now();
    try {
      const response = await fetch(url, {
        method: spec.method ?? 'GET',
        body: spec.body,
        headers: spec.headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      results.push({ path: spec.path, status: response.status, ms: Date.now() - started });
    } catch (error) {
      results.push({ path: spec.path, status: null, ms: Date.now() - started, error: (error as Error).message });
    }
  }
  const up = results.every((r) => r.status !== null && r.status >= 200 && r.status < 400);
  return { up, results };
}

export function describe(result: ProbeResult): string {
  return result.results
    .map((r) => `${r.path} ${r.status ?? 'no response'}${r.error ? ` (${r.error})` : ''} ${r.ms}ms`)
    .join('; ');
}

/**
 * Runs the configured revision command and returns the first 7-to-40 hex run in its stdout, or
 * null when the command is unset, fails, or prints no SHA.
 */
export function deployedRevision(command: string | undefined, cwd: string): string | null {
  if (!command) return null;
  const proc = Bun.spawnSync(['sh', '-c', command], { cwd, stderr: 'pipe', timeout: 60_000 });
  if (proc.exitCode !== 0) return null;
  const match = proc.stdout.toString().match(/\b[0-9a-f]{7,40}\b/);
  return match ? match[0] : null;
}

/** True when `sha` is an ancestor of (or equal to) `deployed` in the repository at `repoRoot`. */
export function includesCommit(repoRoot: string, deployed: string, sha: string): boolean {
  const proc = Bun.spawnSync(['git', 'merge-base', '--is-ancestor', sha, deployed], { cwd: repoRoot, stderr: 'pipe' });
  return proc.exitCode === 0;
}

/** One run of the deploy workflow for a commit, as the forge lists it. */
export type DeployRun = { status: string; conclusion: string | null };

/** The deploy workflow's runs for a commit; throws when the forge cannot be read. */
export function deployRunsFor(ctx: Context, workflow: string, sha: string): DeployRun[] {
  const raw = sh(ctx, ['gh', 'run', 'list', '--workflow', workflow, '--commit', sha, '--limit', '20', '--json', 'status,conclusion']);
  return JSON.parse(raw) as DeployRun[];
}

/**
 * Whether the runs show the commit deployed: one run that completed successfully does. A run
 * queued, pending, waiting, requested, or in progress has not deployed it yet, and one that
 * completed any other way did not deploy it.
 */
export function judgeDeployRuns(workflow: string, runs: DeployRun[]): { deployed: boolean; reason: string } {
  if (runs.some((run) => run.status === 'completed' && run.conclusion === 'success')) return { deployed: true, reason: `${workflow} completed successfully` };
  const unfinished = runs.find((run) => run.status !== 'completed');
  if (unfinished) return { deployed: false, reason: `the ${workflow} run is ${unfinished.status}` };
  const finished = runs[0];
  if (finished) return { deployed: false, reason: `the ${workflow} run concluded ${finished.conclusion ?? 'without a conclusion'}` };
  return { deployed: false, reason: `no ${workflow} run for the merge` };
}

/** A merge with no evidence it is deployed: not walked, and why. */
export type Undeployed = { state: 'not-yet-deployed' | 'deploy-unconfirmed'; reason: string };

/**
 * Classifies an item before any agent runs; null means walk it. An item without a merge SHA is
 * always walked. A deployed revision, when one was read, decides alone; without one, the deploy
 * workflow's runs for the merge do. A merge with no evidence stays `not-yet-deployed` until
 * `capMinutes` after it merged, then is `deploy-unconfirmed`: the floor looked and cannot tell.
 */
export function classify(options: {
  /** The revision `revisionCommand` printed; null when unset or unreadable. */
  deployed: string | null;
  sha?: string;
  /** When the merge landed; the cap counts from here. */
  mergedAt?: string;
  /** The deploy workflow's name, when configured. */
  workflow?: string;
  /** Reads that workflow's runs for the merge commit. */
  runsFor?: (sha: string) => DeployRun[];
  capMinutes: number;
  repoRoot: string;
  now?: number;
}): Undeployed | null {
  const { deployed, sha, mergedAt, workflow, runsFor, capMinutes, repoRoot } = options;
  if (!sha) return null;
  let reason: string;
  if (deployed) {
    if (includesCommit(repoRoot, deployed, sha)) return null;
    reason = `merge ${sha.slice(0, 12)} is not an ancestor of the deployed revision ${deployed.slice(0, 12)}`;
  } else if (workflow && runsFor) {
    let judged: { deployed: boolean; reason: string };
    try {
      judged = judgeDeployRuns(workflow, runsFor(sha));
    } catch (error) {
      judged = { deployed: false, reason: `the ${workflow} runs could not be read (${(error as Error).message})` };
    }
    if (judged.deployed) return null;
    reason = judged.reason;
  } else {
    reason = 'no deploy evidence: neither a revisionCommand nor a deployWorkflow is configured';
  }
  const now = options.now ?? Date.now();
  if (mergedAt && now - Date.parse(mergedAt) >= capMinutes * 60_000) {
    return { state: 'deploy-unconfirmed', reason: `${reason}; still no deploy evidence ${capMinutes} minutes after the merge` };
  }
  return { state: 'not-yet-deployed', reason };
}

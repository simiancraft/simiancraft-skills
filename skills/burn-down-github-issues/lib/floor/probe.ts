/**
 * What a walk learns before any agent runs. The liveness probe requests each health path under the
 * base URL with a short timeout; "up" means every path answered 2xx or 3xx. A path may be a string
 * (GET) or an object naming a method and body, so an API that rejects GET (a GraphQL endpoint with
 * CSRF protection) can still be probed with the request it accepts. The revision helpers turn the
 * propagation race into a state rather than a guess: `not-yet-deployed` when a merge is not an
 * ancestor of the deployed revision, `unverified` when there is no revision signal and the merge is
 * inside the grace window, and "walk it" otherwise.
 */

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

export type Pending = 'not-yet-deployed' | 'unverified' | null;

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

/** Classifies an item before any agent runs. An item without a merge SHA is always walked. */
export function classify(options: {
  deployed: string | null;
  sha?: string;
  mergedAt?: string;
  graceMinutes: number;
  repoRoot: string;
  now?: number;
}): Pending {
  const { deployed, sha, mergedAt, graceMinutes, repoRoot } = options;
  const now = options.now ?? Date.now();
  if (!sha) return null;
  if (deployed) return includesCommit(repoRoot, deployed, sha) ? null : 'not-yet-deployed';
  if (mergedAt && now - Date.parse(mergedAt) < graceMinutes * 60_000) return 'unverified';
  return null;
}

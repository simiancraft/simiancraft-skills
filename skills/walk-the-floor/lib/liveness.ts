/**
 * The in-process liveness probe. No agent, no browser: request each health path under the base
 * URL with a short timeout and report status and latency. "Up" means every path answered 2xx or
 * 3xx. A path may be a string (GET) or an object naming a method and body, so an API that rejects
 * GET (a GraphQL endpoint with CSRF protection) can still be probed with the request it accepts.
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

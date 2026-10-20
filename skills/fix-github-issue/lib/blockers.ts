import type { Context } from './context.ts';
import { sh } from './shell.ts';

export type Blocker = { number: number; state: string; stateReason?: string | null; url?: string };

/**
 * gh omits blocker stateReason; resolve distinct blockers in batches before using them.
 * Only blockers in this repository are looked up by number. One that cannot be resolved keeps an
 * unknown reason, which reads as still blocking and never as closed not planned.
 */
export function enrichBlockers<T extends { blockedBy?: { nodes: Blocker[] } | Blocker[] }>(ctx: Context, issues: T[]): T[] {
  const [owner, name] = ctx.project.repo.split('/');
  const local = (b: Blocker) => b.url === undefined || b.url.toLowerCase().includes(`/${owner}/${name}/issues/`.toLowerCase());
  const blockers = issues.flatMap((issue) => {
    if (Array.isArray(issue.blockedBy)) issue.blockedBy = { nodes: issue.blockedBy };
    return issue.blockedBy?.nodes ?? [];
  });
  const numbers = [...new Set(blockers.filter((b) => b.stateReason === undefined && local(b)).map((b) => b.number))];
  for (let start = 0; start < numbers.length; start += 100) {
    const batch = numbers.slice(start, start + 100);
    const fields = batch.map((n) => `i${n}: issue(number: ${n}) { number state stateReason }`).join('\n');
    const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
    let repository: Record<string, Blocker | null> | null | undefined;
    try {
      const result = JSON.parse(sh(ctx, ['gh', 'api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`])) as {
        data?: { repository: Record<string, Blocker | null> | null };
      };
      repository = result.data?.repository;
    } catch (error) {
      ctx.log(`  could not read blocker state reasons for ${batch.map((n) => `#${n}`).join(', ')}: ${(error as Error).message}`);
      continue;
    }
    if (!repository) continue;
    for (const blocker of blockers) {
      if (!local(blocker)) continue;
      const resolved = repository[`i${blocker.number}`];
      if (resolved) Object.assign(blocker, resolved);
    }
  }
  return issues;
}

import type { Context } from './context.ts';
import { sh } from './shell.ts';

export type Blocker = { number: number; state: string; stateReason?: string | null };

/** gh omits blocker stateReason; resolve distinct blockers in batches before using them. */
export function enrichBlockers<T extends { blockedBy?: { nodes: Blocker[] } | Blocker[] }>(ctx: Context, issues: T[]): T[] {
  const blockers = issues.flatMap((issue) => {
    if (Array.isArray(issue.blockedBy)) issue.blockedBy = { nodes: issue.blockedBy };
    return issue.blockedBy?.nodes ?? [];
  });
  const numbers = [...new Set(blockers.filter((b) => b.stateReason === undefined).map((b) => b.number))];
  const [owner, name] = ctx.project.repo.split('/');
  for (let start = 0; start < numbers.length; start += 100) {
    const batch = numbers.slice(start, start + 100);
    const fields = batch.map((n) => `i${n}: issue(number: ${n}) { number state stateReason }`).join('\n');
    const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
    const result = JSON.parse(sh(ctx, ['gh', 'api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`])) as {
      data?: { repository: Record<string, Blocker | null> | null };
      errors?: Array<{ message: string }>;
    };
    if (result.errors?.length || !result.data?.repository) throw new Error(`could not read blocker state reasons: ${JSON.stringify(result.errors ?? result)}`);
    const repository = result.data.repository;
    for (const blocker of blockers) {
      const resolved = repository[`i${blocker.number}`];
      if (resolved) Object.assign(blocker, resolved);
    }
  }
  return issues;
}

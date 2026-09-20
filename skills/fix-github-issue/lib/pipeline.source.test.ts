import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'pipeline.ts'), 'utf8');

/** The body of a top-level function, from its declaration to the next top-level closing brace. */
function bodyOf(name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end);
}

describe('cleanup never runs under live work', () => {
  // `return promise` inside try/finally runs the finally before the promise settles. In these two
  // functions the finally releases the claim, stops the lease, and removes the worktree.
  for (const name of ['fixIssue', 'redriveIssue']) {
    it(`${name} awaits every pipeline call it returns from inside its try`, () => {
      const body = bodyOf(name);
      expect(body).toContain('} finally {');
      const unawaited = body.split('\n').filter((line) => /^\s+return (workIssue|reviewAndLand|redriveIssue|fixIssue)\(/.test(line));
      expect(unawaited).toEqual([]);
    });

    it(`${name} takes its claim before the try and creates its worktree inside it`, () => {
      const body = bodyOf(name);
      const tryAt = body.indexOf('\n  try {');
      expect(body.indexOf('keepClaimed(handle)')).toBeLessThan(tryAt);
      expect(body.search(/worktreeFor\(|worktreeAtPullRequest\(/)).toBeGreaterThan(tryAt);
    });
  }
});

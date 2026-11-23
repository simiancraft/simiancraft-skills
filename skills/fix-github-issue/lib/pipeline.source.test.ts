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
  // `return promise` inside try/finally runs the finally before the promise settles. In withLane the
  // finally releases the claim, stops the lease, and removes the worktree.
  it('withLane awaits the work it returns from inside its try', () => {
    const body = bodyOf('withLane');
    expect(body).toContain('} finally {');
    expect(body).toContain('return await work(cwd);');
  });

  it('withLane takes its claim before the try and opens the lane inside it', () => {
    const body = bodyOf('withLane');
    const tryAt = body.indexOf('\n  try {');
    const claimAt = body.indexOf('keepClaimed(handle');
    // A missing needle is -1, which would satisfy either comparison below on its own.
    expect(tryAt).toBeGreaterThan(-1);
    expect(claimAt).toBeGreaterThan(-1);
    expect(claimAt).toBeLessThan(tryAt);
    expect(body.indexOf('lane.open()')).toBeGreaterThan(tryAt);
  });

  for (const [name, opens] of [['fixIssue', 'worktreeFor('], ['redriveIssue', 'worktreeAtPullRequest(']] as const) {
    it(`${name} lives under withLane, opens its worktree there, and awaits every pipeline call it returns`, () => {
      const body = bodyOf(name);
      expect(body).toContain('return withLane(ctx, issue, say, {');
      expect(body).not.toContain('keepClaimed(');
      expect(body.slice(body.indexOf('open: () =>'))).toContain(opens);
      const unawaited = body.split('\n').filter((line) => /^\s+return (workIssue|reviewAndLand|redriveIssue|fixIssue)\(/.test(line));
      expect(unawaited).toEqual([]);
    });
  }

  it('resumeOneStranded lives under withLane too', () => {
    const resume = readFileSync(join(import.meta.dir, 'resume.ts'), 'utf8');
    expect(resume).toContain('const outcome = await withLane(ctx, issue, say, {');
    expect(resume).not.toContain('keepClaimed(');
  });
});

describe('a person landing past the merge boundary', () => {
  const pipeline = readFileSync(join(import.meta.dir, 'pipeline.ts'), 'utf8');
  const fix = readFileSync(join(import.meta.dir, '..', 'fix.ts'), 'utf8');
  it('routes the boundary through boundaryWaived (tested in land.test.ts) and records the waiver', () => {
    expect(pipeline).toContain('const allowed = held === null && mergeAllowed(ctx, effective);');
    expect(pipeline).toContain('!allowed && boundaryWaived(ctx.landPastBoundary, issue.number, effective)');
    expect(pipeline).toContain('note the boundary waiver on PR');
  });
  it('re-proves and re-reviews rather than sending the work back to a coder', () => {
    expect(fix).toContain("landPastBoundary: LAND ? ISSUE_NUMBER : undefined");
    expect(fix).toContain('LAND ? null : OBJECTION');
  });
  it('continues a held proof on its open pull request at Proving, with or without --redrive', () => {
    expect(fix).toContain('REDRIVE || LAND || LOOP_HOLD ? PULLS.find');
    expect(fix).toContain("const OBJECTION: string | null = STANDING?.kind === 'proof-held' ? null :");
  });
});

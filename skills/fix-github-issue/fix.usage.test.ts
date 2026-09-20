import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'fix.ts'), 'utf8');
const usage = /export const USAGE = `([\s\S]*?)`;/.exec(source)?.[1] ?? '';

describe('fix.ts --help', () => {
  it('names every flag the command reads, so the usage cannot go stale', () => {
    const read = [...source.matchAll(/\b(?:flag|opt)\('([a-z-]+)'\)/g)].map((m) => m[1]);
    expect(read.length).toBeGreaterThan(5);
    expect(usage.length).toBeGreaterThan(0);
    expect(read.filter((name) => !usage.includes(`--${name}`))).toEqual([]);
  });

  it('answers before it validates anything, config and --issue included', () => {
    const run = Bun.spawnSync(['bun', join(import.meta.dir, 'fix.ts'), '--help'], { cwd: '/', stdout: 'pipe', stderr: 'pipe' });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain('--redrive');
  });
});

describe('fix.ts on an issue nobody has sized', () => {
  it('appraises before it dispatches any work, and only when the issue carries no size', () => {
    const gate = source.indexOf('if (!RESUME_PR && pointsFromLabels(issue.labels) === null) {');
    const appraise = source.indexOf('await appraiseIssue(ctx, issue, {');
    const dispatch = source.indexOf('await fixIssue(ctx, issue,');
    // A missing needle is -1, which would satisfy a bare comparison on its own.
    for (const at of [gate, appraise, dispatch]) expect(at).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(appraise);
    expect(appraise).toBeLessThan(dispatch);
  });

  it('works nothing the appraisal did not call valid and within the ceiling', () => {
    expect(source).toContain("if (appraisal.verdict !== 'valid' || appraisal.points === undefined || appraisal.points > MAX_POINTS) {");
  });
});


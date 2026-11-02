import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'loop.ts'), 'utf8');

describe('--only bounds every pass that can land work', () => {
  it('restricts startup resumption to the --only issues', () => {
    const call = source.split('\n').find((line) => line.includes('findStranded(ctx,'));
    expect(call).toBeDefined();
    expect(call).toContain('ONLY.has(issue.number)');
  });
});

describe('an unreadable thread at startup', () => {
  it('costs one issue its pass in the loop, never the run', () => {
    expect(source).not.toContain('readTree(ctx, issue.number, io)');
    expect(source).toContain('function threadOf(');
  });
});

describe('resume dispatch owns automatic redrive', () => {
  it('calls redriveIssue only inside resumePull, which the pool uses', () => {
    const start = source.indexOf('async function resumePull(');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n}', start) + 2;
    expect(source.slice(start, end)).toContain('redriveIssue(');
    expect(source.slice(0, start) + source.slice(end)).not.toContain('redriveIssue(');
    expect(source).toMatch(/await pool\(\s*resumable,\s*CONFIG.concurrency,\s*resumePull,/);
  });
});

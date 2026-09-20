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

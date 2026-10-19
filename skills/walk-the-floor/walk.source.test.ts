import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dir;
const source = readFileSync(join(HERE, 'walk.ts'), 'utf8');

describe('the walker hands incidents to the fix pipeline with every prompt it renders', () => {
  it('includes the directory that holds confirm-close.md', () => {
    expect(existsSync(join(HERE, '..', 'appraise-github-issues', 'prompts', 'confirm-close.md'))).toBe(true);
    expect(source).toMatch(/promptsDirs: \[FIX_PROMPTS, APPRAISE_PROMPTS\]/);
    expect(source).toContain("join(HERE, '..', 'appraise-github-issues', 'prompts')");
  });
});

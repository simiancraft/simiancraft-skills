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

describe('two floors on one repository', () => {
  it('give each walker a checkout of its own, named for its floor', () => {
    const line = source.split('\n').find((l) => l.startsWith('const CHECKOUT ='));
    expect(line).toContain('update(DIR)');
  });
});

describe('a dry run writes nothing it promises not to', () => {
  it('puts no forge items on the list', () => {
    expect(source).toContain('if (!NO_FORGE && !DRY_RUN) {');
  });
  it('returns before the walk makes a checkout', () => {
    const dryReturn = source.indexOf('dry run: would walk');
    const walk = source.indexOf('// 4. Walk, one agent turn');
    expect(dryReturn).toBeGreaterThan(-1);
    expect(dryReturn).toBeLessThan(walk);
  });
  it('makes no checkout for a repair', () => {
    expect(source).toMatch(/checkout \?\? \(DRY_RUN \? REPO_ROOT : makeCheckout/);
  });
});

describe('the docs name only flags the walker accepts', () => {
  it('never mentions --from-forge', () => {
    for (const doc of ['SKILL.md', 'references/operating.md', 'references/adopting.md']) {
      expect(readFileSync(join(HERE, doc), 'utf8')).not.toContain('--from-forge');
    }
  });
});

describe('an incident handed to the fix pipeline', () => {
  const incident = readFileSync(join(HERE, 'lib', 'incident.ts'), 'utf8');
  it('carries its live labels, so attempt and review budgets accumulate across wakes', () => {
    expect(incident).not.toContain('labels: []');
    expect(incident).toMatch(/fixIssue\(ctx, live,/);
  });
});

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPrompt, renderTemplate } from './agent.ts';
import type { Context } from './context.ts';

const ctx = {
  repoRoot: '/checkout',
  promptsDirs: [
    join(import.meta.dir, '../../appraise-github-issues/prompts'),
    join(import.meta.dir, '../../carve-github-issue/prompts'),
  ],
  project: {
    name: 'Test', repo: 'o/r', remote: 'origin', baseBranch: 'main',
    evidenceBranch: 'evidence', checkCommand: 'true', installCommand: 'true',
    conventionDocs: [], sharedServices: [], sizingScale: 'docs/custom-sizing.md',
    portBase: 47088, portSpan: 1,
  },
} as unknown as Context;

const vars = { ISSUE: '88', TITLE: '{{SIZING_RUBRIC}}', CEILING: '2', SCALE: '1, 2, 3, 5' };

describe('the shared sizing rubric', () => {
  const rubric = readFileSync(new URL('../references/sizing.md', import.meta.url), 'utf8').trimEnd();
  for (const file of ['appraise.md', 'carve.md', 'revisit.md', 'confirm-carve.md']) {
    it(`${file} renders the same rubric with the repository scale`, () => {
      const prompt = renderPrompt(ctx, file, vars);
      const rendered = renderTemplate(ctx, rubric, {});
      expect(prompt.split(rendered)).toHaveLength(2);
      expect(prompt).toContain('docs/custom-sizing.md');
      expect(prompt).toContain("repository's scale wins");
      expect(prompt).toContain('proof the change will owe as part of its size.');
      expect(prompt).not.toContain('{{SIZING_SCALE}}');
      expect(prompt).not.toContain('{{SIZING_RUBRIC}}');
      expect(prompt).toContain('{ {SIZING_RUBRIC} }');
    });
  }
  it('asks the confirmer to reject underestimated and oversized pieces with both sizes', () => {
    const prompt = renderPrompt(ctx, 'confirm-carve.md', vars);
    expect(prompt).toContain('Reject\n   an understated estimate');
    expect(prompt).toContain('**2**-point ceiling on `1, 2, 3, 5`');
    expect(prompt).toContain('the proposed points, and your points');
    expect(prompt).toContain('`agree: false`');
  });
});

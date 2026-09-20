import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const prompt = (name: string) => readFileSync(join(import.meta.dir, '..', 'prompts', name), 'utf8');

describe('the step prompts', () => {
  for (const name of ['code.md', 'prove.md']) {
    it(`${name} never tells a seat to chase the base: staying current happens between steps`, () => {
      const text = prompt(name);
      // Merging or rebasing the base, in any spelling the old worker prompt used or might.
      // `git merge-base` reads history and merges nothing, so the verb must end where it stands.
      expect(text).not.toMatch(/git (merge|rebase|pull)(?![-\w])[^\n]*\{\{(REMOTE|BASE_BRANCH)\}\}/);
      expect(text).not.toMatch(/git fetch \{\{REMOTE\}\} \{\{BASE_BRANCH\}\}/);
      expect(text).toContain('Do not fetch the base and do not merge it');
    });
  }

  it('code.md ends at a pushed branch and a hand-off, and opens no pull request', () => {
    const text = prompt('code.md');
    expect(text).toContain('"verdict": "coded |');
    for (const field of ['"sha"', '"gated"', '"handoff"', '"branch"']) expect(text).toContain(field);
    expect(text).not.toContain('gh pr create');
    expect(text).not.toContain('gh pr ready');
  });

  it('prove.md proves what it was handed, may refuse, and does not run the gate on the gated head', () => {
    const text = prompt('prove.md');
    expect(text).toContain('{{HANDOFF}}');
    expect(text).toContain('{{GATED_SHA}}');
    expect(text).toContain('"verdict": "fixed | unprovable |');
    expect(text).toContain('you do not run it again');
    expect(text).toContain('gh pr create');
  });
});

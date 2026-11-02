import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { renderPrompt, renderTemplate } from '../skills/fix-github-issue/lib/agent.ts';
import type { Context } from '../skills/fix-github-issue/lib/context.ts';
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(head, '25e6aecd325765365d0ff3ff962e88c17a63e2a2');
console.log(`Captured at ${head}`);
const old = (path: string) => execFileSync('git', ['show', `${head}^:${path}`], { encoding: 'utf8' });
const rubric = readFileSync('skills/fix-github-issue/references/sizing.md', 'utf8').trim();
const oldAppraisal = old('skills/appraise-github-issues/prompts/appraise.md');
assert.ok(oldAppraisal.includes(rubric));
assert.ok(!old('skills/carve-github-issue/prompts/carve.md').includes(rubric));
console.log('BEFORE: appraisal contained the exact rubric; carving did not.');
const ctx = {
  repoRoot: '/checkout',
  promptsDirs: ['skills/appraise-github-issues/prompts', 'skills/carve-github-issue/prompts'].map(p => resolve(p)),
  project: { name: 'Fixture {{SIZING_RUBRIC}}', repo: 'fixture/repo', remote: 'origin', baseBranch: 'main', evidenceBranch: 'evidence', checkCommand: 'true', installCommand: 'true', conventionDocs: [], sharedServices: [], sizingScale: 'docs/custom-sizing.md', portBase: 47088, portSpan: 1 },
} as unknown as Context;
for (const [ceiling, scale] of [['2', '1, 2, 3, 5'], ['3', '1, 3, 8']]) {
  for (const file of ['appraise.md', 'carve.md', 'revisit.md', 'confirm-carve.md']) {
    const rendered = renderPrompt(ctx, file, { ISSUE: '88', TITLE: '{{SIZING_RUBRIC}}', CEILING: ceiling, SCALE: scale });
    const expected = renderTemplate(ctx, rubric, {});
    assert.equal(rendered.split(expected).length, 2);
    assert.ok(!rendered.includes('{{SIZING_RUBRIC}}'));
    assert.ok(!rendered.includes('{{SIZING_SCALE}}'));
    assert.ok(rendered.includes('{ {SIZING_RUBRIC} }'));
    if (file !== 'appraise.md') {
      assert.ok(rendered.includes(`**${ceiling}**-point ceiling on`));
      assert.ok(rendered.includes('`' + scale + '`'));
    }
    console.log(`AFTER ${file}: one identical rubric, repository scale resolved, inserted markers inert; ceiling=${ceiling}, scale=${scale}.`);
  }
}
const knife = readFileSync('skills/carve-github-issue/lib/knife.ts', 'utf8');
const confirmer = knife.slice(knife.indexOf('async function runConfirmer('), knife.indexOf('function heldBy('));
assert.ok(confirmer.includes('CEILING: String(k.knobs.ceiling)'));
assert.ok(confirmer.includes("SCALE: k.ctx.knobs.pointScale.join(', ')"));
console.log('SOURCE CHECK: confirmer passes the configured ceiling and point scale to rendering.');
assert.equal(execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '.github/workflows'], { encoding: 'utf8' }), '');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(pkg.scripts.gate, 'tsc --noEmit -p . && bun test');
console.log('GATE CONFIG: no .github/workflows files at this head; package gate = tsc --noEmit -p . && bun test.');
console.log('GATE EXECUTION: inherited accepted result at this exact head: 548 pass, 0 fail. Not rerun under task instruction; this capture does not claim to be its execution log.');
console.log('LIMIT: no live sizing agreement measured; oversized children still follow recursive carving.');

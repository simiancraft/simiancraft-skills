import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { culpritOf, revertOf } from './incident.ts';

let repo: string;
const git = (...args: string[]) => {
  const proc = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
};
const write = (path: string, lines: string[]) => writeFileSync(join(repo, path), `${lines.join('\n')}\n`);
const commit = (message: string) => {
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
};

const BEFORE = ['export function retry() {', '  const timeout = 30;', '  return fetchWith(timeout);', '}'];
const AFTER = ['export function retry() {', '  const timeout = 3;', '  const jitter = spread(timeout);', '  return fetchWith(timeout + jitter);', '}'];
let culprit: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'revert-'));
  git('init', '-q', '-b', 'main');
  write('retry.ts', BEFORE);
  write('other.ts', ['export const other = 1;']);
  commit('base');
  // The recent merge: it rewrites the timeout, adds jitter, and adds a file.
  write('retry.ts', AFTER);
  write('banner.ts', ['export const banner = "new";']);
  culprit = commit('feat: shorter retries (#12)');
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

/** A fix on a branch of its own from main; returns what revertOf says about it. */
function fixing(name: string, change: () => void): string | null {
  git('checkout', '-q', '-b', name, 'main');
  change();
  commit(`fix: ${name}`);
  const said = revertOf(repo, 'main', [{ pullRequest: 12, sha: culprit }]);
  git('checkout', '-q', 'main');
  return said;
}

describe('whether an incident fix undoes a recent merge', () => {
  it('a forward repair that rewrites the merge\'s lines undoes nothing', () => {
    expect(fixing('forward', () => write('retry.ts', AFTER.map((l) => l.replace('timeout = 3;', 'timeout = 3_000;'))))).toBeNull();
  });
  it('a change to files the merge never touched undoes nothing', () => {
    expect(fixing('elsewhere', () => write('other.ts', ['export const other = 2;']))).toBeNull();
  });
  it('putting back a line the merge removed undoes it', () => {
    expect(fixing('restore', () => write('retry.ts', AFTER.map((l) => l.replace('timeout = 3;', 'timeout = 30;'))))).toContain('puts back lines it removed from retry.ts');
  });
  it('only removing lines the merge added undoes it', () => {
    expect(fixing('strip', () => write('retry.ts', AFTER.filter((l) => !l.includes('jitter'))))).toContain('only removes lines it added to retry.ts');
  });
  it('deleting a file the merge added undoes it', () => {
    expect(fixing('delete', () => rmSync(join(repo, 'banner.ts')))).toContain('deletes banner.ts, which it added');
  });
  it('a git revert of the merge undoes it', () => {
    git('checkout', '-q', '-b', 'reverted', 'main');
    git('revert', '--no-edit', culprit);
    expect(revertOf(repo, 'main', [{ pullRequest: 12, sha: culprit }])).toStartWith('reverts #12');
    git('checkout', '-q', 'main');
  });
  it('a merge that cannot be read is not counted', () => {
    git('checkout', '-q', '-b', 'unknown', 'main');
    write('retry.ts', BEFORE);
    commit('fix: unknown');
    expect(revertOf(repo, 'main', [{ pullRequest: 99, sha: 'deadbeefdeadbeef' }])).toBeNull();
    git('checkout', '-q', 'main');
  });
});

describe('the culprit an incident names', () => {
  it('reads the diagnosis line the incident body carries', () => {
    expect(culpritOf('## Diagnosis\nCulprit: #12 (`0123456789ab`) (likely)\nRemedy: revert')).toEqual({ pullRequest: 12, sha: '0123456789ab' });
    expect(culpritOf('## Diagnosis\nCulprit: none named (none)')).toBeNull();
  });
});

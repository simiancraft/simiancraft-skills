import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from './context.ts';
import { workReads } from './pipeline.ts';

let scratch: string;
let clone: string;
let first = '';
let second = '';
const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
};

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'steps-git-'));
  const origin = join(scratch, 'origin.git');
  clone = join(scratch, 'clone');
  git(scratch, 'init', '-q', '--bare', origin);
  git(scratch, 'clone', '-q', origin, clone);
  writeFileSync(join(clone, 'a.txt'), 'one');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'one');
  git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  git(clone, 'switch', '-q', '-c', 'fix/parser-7');
  writeFileSync(join(clone, 'a.txt'), 'two');
  git(clone, 'commit', '-q', '-am', 'two');
  first = git(clone, 'rev-parse', 'HEAD');
  writeFileSync(join(clone, 'a.txt'), 'three');
  git(clone, 'commit', '-q', '-am', 'three');
  second = git(clone, 'rev-parse', 'HEAD');
  git(clone, 'push', '-q', 'origin', 'fix/parser-7');
  // A branch for another issue whose number only ends the same way, and one for issue 17.
  git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/fix/other-17');
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('the work reads, against a real remote', () => {
  const ctx = () => ({ project: { repo: 'o/r', remote: 'origin', baseBranch: 'main' }, repoRoot: clone, botLogin: 'loop-bot', log: () => {}, dryRun: false } as unknown as Context);

  it('finds the branch named for the issue, and not one for an issue whose number merely ends the same', () => {
    expect(workReads(ctx(), 7, clone).remoteBranches()).toEqual([{ branch: 'fix/parser-7', sha: second }]);
    expect(workReads(ctx(), 17, clone).remoteBranches()).toEqual([{ branch: 'fix/other-17', sha: second }]);
  });

});

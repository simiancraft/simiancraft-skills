import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from './context.ts';
import { behindBase, behindBeyondNoise, fetchBase, staleAgainstBase } from './staleness.ts';

function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

/** A bare remote, a lane with a branch that edits `src/feature.ts` (which imports `src/shared.ts`), and a clone that lands upstream. */
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'staleness-'));
  const remote = join(root, 'remote.git');
  const lane = join(root, 'lane');
  const other = join(root, 'other');
  git(root, 'init', '--bare', '-b', 'development', remote);
  git(root, 'clone', '-q', remote, lane);
  for (const dir of [lane]) {
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'test');
  }
  mkdirSync(join(lane, 'src'));
  writeFileSync(join(lane, 'src/shared.ts'), 'export const shared = 1;\n');
  writeFileSync(join(lane, 'src/feature.ts'), "import { shared } from './shared';\nexport const feature = shared;\n");
  writeFileSync(join(lane, 'src/unrelated.ts'), 'export const unrelated = 1;\n');
  writeFileSync(join(lane, 'bun.lock'), 'lock 1\n');
  git(lane, 'add', '.');
  git(lane, 'commit', '-q', '-m', 'first');
  git(lane, 'push', '-q', '-u', 'origin', 'development');
  git(root, 'clone', '-q', remote, other);
  git(other, 'config', 'user.email', 'test@example.com');
  git(other, 'config', 'user.name', 'test');
  git(lane, 'switch', '-q', '-c', 'fix/feature-12');
  writeFileSync(join(lane, 'src/feature.ts'), "import { shared } from './shared';\nexport const feature = shared + 1;\n");
  git(lane, 'commit', '-q', '-am', 'fix the feature');
  const ctx = {
    repoRoot: lane,
    project: {
      repo: 'example/repo',
      remote: 'origin',
      baseBranch: 'development',
      alwaysInvalidates: ['bun.lock'],
      releaseArtifacts: [],
      pathAliases: [],
      sourceExtensions: ['.ts'],
    },
    log: () => {},
  } as unknown as Context;
  return { ctx, lane, other };
}

function landUpstream(other: string, file: string, body: string): void {
  writeFileSync(join(other, file), body);
  git(other, 'add', file);
  git(other, 'commit', '-q', '-m', `land ${file}`);
  git(other, 'push', '-q', 'origin', 'development');
}

describe('behindBase: is the lane behind at all', () => {
  it('is empty when the lane holds the current base', () => {
    const { ctx, lane } = repository();
    expect(behindBase(ctx, lane)).toEqual([]);
  });

  it('names what the base changed, even when it is nowhere near the work', () => {
    const { ctx, lane, other } = repository();
    landUpstream(other, 'src/unrelated.ts', 'export const unrelated = 2;\n');
    expect(behindBase(ctx, lane)).toEqual(['src/unrelated.ts']);
  });

  it('is empty again once the base is merged in', () => {
    const { ctx, lane, other } = repository();
    landUpstream(other, 'src/unrelated.ts', 'export const unrelated = 2;\n');
    behindBase(ctx, lane);
    git(lane, 'merge', '-q', '--no-edit', 'origin/development');
    expect(behindBase(ctx, lane)).toEqual([]);
  });
});

describe('staleAgainstBase: did the world move beneath the proof', () => {
  it('says no when the movement is outside the import closure, though the lane is behind', () => {
    const { ctx, lane, other } = repository();
    const proofHead = git(lane, 'rev-parse', 'HEAD');
    landUpstream(other, 'src/unrelated.ts', 'export const unrelated = 2;\n');
    expect(behindBase(ctx, lane).length).toBeGreaterThan(0);
    expect(staleAgainstBase(ctx, lane, proofHead)).toEqual([]);
  });

  it('says yes when a module the change imports moved, though the diff never touched it', () => {
    const { ctx, lane, other } = repository();
    const proofHead = git(lane, 'rev-parse', 'HEAD');
    landUpstream(other, 'src/shared.ts', 'export const shared = 2;\n');
    expect(staleAgainstBase(ctx, lane, proofHead)).toEqual(['src/shared.ts']);
  });

  it('says yes for a global invalidator whatever the closure holds', () => {
    const { ctx, lane, other } = repository();
    const proofHead = git(lane, 'rev-parse', 'HEAD');
    landUpstream(other, 'bun.lock', 'lock 2\n');
    expect(staleAgainstBase(ctx, lane, proofHead)).toEqual(['bun.lock']);
  });
});

describe('behindBeyondNoise: what a landing must catch up on', () => {
  const withArtifacts = (ctx: Context) => {
    (ctx.project as { releaseArtifacts: string[] }).releaseArtifacts = ['changelog/'];
    return ctx;
  };

  it('is empty when the base moved only by release artifacts, though the lane is behind', () => {
    const { ctx, lane, other } = repository();
    mkdirSync(join(other, 'changelog'), { recursive: true });
    landUpstream(other, 'changelog/1.0.1.md', '# 1.0.1\n');
    const base = fetchBase(ctx, lane);
    expect(behindBase(ctx, lane, base)).toEqual(['changelog/1.0.1.md']);
    expect(behindBeyondNoise(withArtifacts(ctx), lane, base)).toEqual([]);
  });

  it('keeps everything else the base changed', () => {
    const { ctx, lane, other } = repository();
    mkdirSync(join(other, 'changelog'), { recursive: true });
    landUpstream(other, 'changelog/1.0.1.md', '# 1.0.1\n');
    landUpstream(other, 'src/unrelated.ts', 'export const unrelated = 2;\n');
    expect(behindBeyondNoise(withArtifacts(ctx), lane, fetchBase(ctx, lane))).toEqual(['src/unrelated.ts']);
  });

  it('treats no changelog as noise when no release artifacts are configured', () => {
    const { ctx, lane, other } = repository();
    mkdirSync(join(other, 'changelog'), { recursive: true });
    landUpstream(other, 'changelog/1.0.1.md', '# 1.0.1\n');
    expect(behindBeyondNoise(ctx, lane, fetchBase(ctx, lane))).toEqual(['changelog/1.0.1.md']);
  });

  it('keeps a version-only package.json bump, which code can read and no adopter declared', () => {
    const { ctx, lane, other } = repository();
    writeFileSync(join(other, 'package.json'), '{ "name": "x", "version": "1.0.0" }\n');
    git(other, 'add', 'package.json');
    git(other, 'commit', '-q', '-m', 'manifest');
    git(other, 'push', '-q', 'origin', 'development');
    git(lane, 'fetch', '-q', 'origin');
    git(lane, 'merge', '-q', '--no-edit', 'origin/development');
    landUpstream(other, 'package.json', '{ "name": "x", "version": "1.0.1" }\n');
    expect(behindBeyondNoise(withArtifacts(ctx), lane, fetchBase(ctx, lane))).toEqual(['package.json']);
  });

  it('keeps a release artifact the work imports: the change has to be checked with its new contents', () => {
    const { ctx, lane, other } = repository();
    writeFileSync(join(other, 'src/version.ts'), "export const version = '1.0.0';\n");
    git(other, 'add', 'src/version.ts');
    git(other, 'commit', '-q', '-m', 'version');
    git(other, 'push', '-q', 'origin', 'development');
    git(lane, 'fetch', '-q', 'origin');
    git(lane, 'merge', '-q', '--no-edit', 'origin/development');
    writeFileSync(join(lane, 'src/feature.ts'), "import { version } from './version';\nexport const feature = version;\n");
    git(lane, 'commit', '-q', '-am', 'read the version');
    landUpstream(other, 'src/version.ts', "export const version = '1.0.1';\n");
    (ctx.project as { releaseArtifacts: string[] }).releaseArtifacts = ['src/version.ts'];
    expect(behindBeyondNoise(ctx, lane, fetchBase(ctx, lane))).toEqual(['src/version.ts']);
  });
});

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from './context.ts';
import { behindBase, behindBeyondNoise, commitsBehind, describeCommits, fetchBase, importClosure, isReleaseNoise, resolveSpecifier, staleAgainstBase } from './staleness.ts';

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

/** Puts a package.json on the base and brings the lane up to it, so the next landing on the base is the only package.json movement. */
function sharedManifest(lane: string, other: string): void {
  writeFileSync(join(other, 'package.json'), '{\n  "name": "x",\n  "version": "1.0.0",\n  "dependencies": { "a": "1.0.0" }\n}\n');
  git(other, 'add', 'package.json');
  git(other, 'commit', '-q', '-m', 'manifest');
  git(other, 'push', '-q', 'origin', 'development');
  git(lane, 'fetch', '-q', 'origin');
  git(lane, 'merge', '-q', '--no-edit', 'origin/development');
}

describe('isReleaseNoise: which base files count as movement', () => {
  it('calls a configured release artifact noise, and an unconfigured file movement', () => {
    const { ctx, lane, other } = repository();
    (ctx.project as { releaseArtifacts: string[] }).releaseArtifacts = ['CHANGELOG.md', 'deploy/'];
    const since = git(lane, 'rev-parse', 'HEAD');
    landUpstream(other, 'CHANGELOG.md', '# 1.0.1\n');
    const base = fetchBase(ctx, lane);
    expect(isReleaseNoise(ctx, lane, 'CHANGELOG.md', since, base)).toBe(true);
    expect(isReleaseNoise(ctx, lane, 'deploy/constants.json', since, base)).toBe(true);
    expect(isReleaseNoise(ctx, lane, 'src/unrelated.ts', since, base)).toBe(false);
  });

  it('calls a version-only package.json bump noise without any configuration', () => {
    const { ctx, lane, other } = repository();
    sharedManifest(lane, other);
    const since = git(lane, 'rev-parse', 'HEAD');
    landUpstream(other, 'package.json', '{\n  "name": "x",\n  "version": "1.0.1",\n  "dependencies": { "a": "1.0.0" }\n}\n');
    expect(isReleaseNoise(ctx, lane, 'package.json', since, fetchBase(ctx, lane))).toBe(true);
  });

  it('calls a version bump that also changes a dependency movement', () => {
    const { ctx, lane, other } = repository();
    sharedManifest(lane, other);
    const since = git(lane, 'rev-parse', 'HEAD');
    landUpstream(other, 'package.json', '{\n  "name": "x",\n  "version": "1.0.1",\n  "dependencies": { "a": "2.0.0" }\n}\n');
    expect(isReleaseNoise(ctx, lane, 'package.json', since, fetchBase(ctx, lane))).toBe(false);
  });

  it('is what freshness leaves out: a version-only bump keeps a proof fresh, a dependency change does not', () => {
    const { ctx, lane, other } = repository();
    (ctx.project as { alwaysInvalidates: string[] }).alwaysInvalidates = ['bun.lock', 'package.json'];
    sharedManifest(lane, other);
    const proofHead = git(lane, 'rev-parse', 'HEAD');
    landUpstream(other, 'package.json', '{\n  "name": "x",\n  "version": "1.0.1",\n  "dependencies": { "a": "1.0.0" }\n}\n');
    expect(staleAgainstBase(ctx, lane, proofHead)).toEqual([]);
    landUpstream(other, 'package.json', '{\n  "name": "x",\n  "version": "1.0.2",\n  "dependencies": { "a": "2.0.0" }\n}\n');
    expect(staleAgainstBase(ctx, lane, proofHead)).toEqual(['package.json']);
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

  it('is empty when the base moved only by a release commit: a configured changelog and a version-only package.json bump', () => {
    const { ctx, lane, other } = repository();
    (ctx.project as { releaseArtifacts: string[] }).releaseArtifacts = ['CHANGELOG.md'];
    sharedManifest(lane, other);
    writeFileSync(join(other, 'CHANGELOG.md'), '# 1.0.1\n');
    writeFileSync(join(other, 'package.json'), '{\n  "name": "x",\n  "version": "1.0.1",\n  "dependencies": { "a": "1.0.0" }\n}\n');
    git(other, 'add', 'CHANGELOG.md', 'package.json');
    git(other, 'commit', '-q', '-m', 'chore(release): 1.0.1 [skip ci]');
    git(other, 'push', '-q', 'origin', 'development');
    const base = fetchBase(ctx, lane);
    expect(behindBase(ctx, lane, base)).toEqual(['CHANGELOG.md', 'package.json']);
    expect(behindBeyondNoise(ctx, lane, base)).toEqual([]);
  });

  it('treats a version-only package.json bump as noise with no release artifacts configured', () => {
    const { ctx, lane, other } = repository();
    sharedManifest(lane, other);
    landUpstream(other, 'package.json', '{\n  "name": "x",\n  "version": "1.0.1",\n  "dependencies": { "a": "1.0.0" }\n}\n');
    expect(behindBeyondNoise(ctx, lane, fetchBase(ctx, lane))).toEqual([]);
  });

  it('keeps a version bump that also changes a dependency', () => {
    const { ctx, lane, other } = repository();
    sharedManifest(lane, other);
    landUpstream(other, 'package.json', '{\n  "name": "x",\n  "version": "1.0.1",\n  "dependencies": { "a": "2.0.0" }\n}\n');
    expect(behindBeyondNoise(ctx, lane, fetchBase(ctx, lane))).toEqual(['package.json']);
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

describe('commitsBehind: who moved the base', () => {
  function landAs(other: string, author: string, file: string, subject: string): void {
    writeFileSync(join(other, file), `${subject}\n`);
    git(other, 'add', file);
    git(other, '-c', `user.name=${author}`, '-c', `user.email=${author}@example.com`, 'commit', '-q', '-m', subject);
    git(other, 'push', '-q', 'origin', 'development');
  }

  it('names each commit by author and subject, newest first, whoever made it', () => {
    const { ctx, lane, other } = repository();
    landAs(other, 'someone', 'src/unrelated.ts', 'change the unrelated module');
    landAs(other, 'release-bot', 'CHANGELOG.md', 'chore(release): 1.0.1 [skip ci]');
    const commits = commitsBehind(ctx, lane, fetchBase(ctx, lane));
    expect(commits.map((commit) => [commit.subject, commit.author])).toEqual([
      ['chore(release): 1.0.1 [skip ci]', 'release-bot'],
      ['change the unrelated module', 'someone'],
    ]);
  });

  it('leaves out commits a base already looked at contained', () => {
    const { ctx, lane, other } = repository();
    landAs(other, 'someone', 'src/unrelated.ts', 'first move');
    const seen = fetchBase(ctx, lane);
    landAs(other, 'someone', 'deploy.json', 'second move');
    expect(commitsBehind(ctx, lane, fetchBase(ctx, lane), seen).map((commit) => commit.subject)).toEqual(['second move']);
  });

  it('is empty when the lane holds the base', () => {
    const { ctx, lane } = repository();
    expect(commitsBehind(ctx, lane, fetchBase(ctx, lane))).toEqual([]);
  });

  it('names commits by short sha, subject, and author, and counts the rest', () => {
    const commits = Array.from({ length: 8 }, (_, i) => ({ sha: `${i}`.repeat(40), author: 'bot', subject: `move ${i}` }));
    expect(describeCommits(commits.slice(0, 1))).toBe('0000000000 "move 0" (bot)');
    expect(describeCommits(commits)).toEndWith('"move 5" (bot), and 2 more');
  });
});

describe('importClosure: TypeScript import specifiers', () => {
  /** A tree whose source imports its siblings the NodeNext way, by the extension tsc emits. */
  function nodeNextTree() {
    const root = mkdtempSync(join(tmpdir(), 'closure-'));
    mkdirSync(join(root, 'src/palettes'), { recursive: true });
    writeFileSync(join(root, 'src/index.ts'), "export { web } from './palettes/web.js';\nexport { Swatch } from './swatch.jsx';\n");
    writeFileSync(join(root, 'src/palettes/web.ts'), "import { normalize } from './normalize.js';\nexport const web = normalize;\n");
    writeFileSync(join(root, 'src/palettes/normalize.ts'), 'export const normalize = 1;\n');
    writeFileSync(join(root, 'src/swatch.tsx'), 'export const Swatch = 1;\n');
    writeFileSync(join(root, 'src/vendored.js'), 'export const vendored = 1;\n');
    writeFileSync(join(root, 'src/vendored.ts'), "import { vendored } from './vendored.js';\nexport const wrapped = vendored;\n");
    const ctx = { project: { pathAliases: [], sourceExtensions: ['.ts', '.tsx', '.js', '.jsx'] } } as unknown as Context;
    return { ctx, root };
  }

  it('follows a .js specifier to the .ts file tsc compiles it from', () => {
    const { ctx, root } = nodeNextTree();
    expect([...importClosure(ctx, root, ['src/index.ts'])].sort()).toEqual([
      'src/index.ts',
      'src/palettes/normalize.ts',
      'src/palettes/web.ts',
      'src/swatch.tsx',
    ]);
  });

  it('prefers a .js file that exists over its .ts twin', () => {
    const { ctx, root } = nodeNextTree();
    expect(resolveSpecifier(ctx, root, 'src/vendored.ts', './vendored.js')).toBe('src/vendored.js');
  });
});

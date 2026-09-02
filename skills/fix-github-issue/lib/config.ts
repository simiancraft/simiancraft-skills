/**
 * What a repository declares about itself, and how that declaration is found and validated.
 *
 * The pipeline ships with the skill, outside any target repository, so the invoking directory is
 * the only signal for which repository it serves, and that repository must declare itself before
 * anything runs.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Everything true of a repository rather than of the pipeline. Lives in the repository, never here. */
export type ProjectConfig = {
  /** Shown in the banner and nowhere else. */
  name: string;
  /** `owner/repo`, used to build the SHA-pinned evidence links the prompts hand to reviewers. */
  repo: string;
  /** The git remote. Not every checkout calls it `origin`, and `repo` must name what it points at. */
  remote: string;
  /** Branch every fix is cut from and merged back into. */
  baseBranch: string;
  /** Long-lived branch that holds proof artifacts. Shared by every agent, append only. */
  evidenceBranch: string;
  /** Run before every commit, and again before pushing. The gate the worker must pass locally. */
  checkCommand: string;
  /** Frozen-lockfile install. A fresh worktree has no `node_modules`. */
  installCommand: string;
  /** Files that state the conventions a prescribed remedy has to be read against. */
  conventionDocs: string[];
  /** Where the point scale is written down, quoted to the appraiser. */
  sizingScale: string;
  /** Shared stateful services an agent must not seed, reset, or migrate. */
  sharedServices: string[];
  /** Servers bind `portBase + (issue % portSpan)` so two lanes never contend for a port. */
  portBase: number;
  portSpan: number;
  /** Import-path aliases, specifier prefix to a directory relative to the repository root. */
  pathAliases: Array<{ prefix: string; dir: string }>;
  /** Extensions and index files the closure walk will try, in order. */
  sourceExtensions: string[];
  /**
   * Paths whose change invalidates any proof in flight, whatever the pull request touched.
   * Prefix patterns, except that a pattern starting with '.' and carrying no '/' matches as a
   * filename suffix ('.schema.ts' catches files so named wherever they live).
   */
  alwaysInvalidates: string[];
  /**
   * Files the repository's own release machinery rewrites on every merge to the base (deploy
   * constants, generated changelogs). Their movement alone never invalidates an approval: the
   * queued branch still catches up, but does not pay a re-review for noise every landing produces.
   * Optional; same pattern rules as alwaysInvalidates. package.json needs no entry here: a base
   * change that only bumps its "version" field is recognized as release noise automatically,
   * while any other package.json change still invalidates.
   */
  releaseArtifacts?: string[];
  /**
   * Run in the lane after the pull request's checks are green and before the merge. A non-zero
   * exit parks the pull request with the command's tail as the reason. Boot the thing here; a
   * build is not a boot, and a change that compiles, type-checks, and passes its tests can still
   * fail the moment the result starts. Optional.
   */
  smokeCommand?: string;
  /** Paths that mechanically classify a diff for the merge boundary. Same pattern rules. */
  touchPaths: Record<'migration' | 'ci', string[]>;
  /** Sibling directory outside the repository root where worktrees and run logs live. */
  worktreeRoot: string;
};

/** The knobs the fix pipeline itself enforces. A driver may carry more; the pipeline reads these. */
export type PipelineKnobs = {
  autoMerge: 'always' | 'code-only' | 'never';
  maxReviewRounds: number;
  seats: { worker: string; reviewer: string };
};

export const PIPELINE_DEFAULTS: PipelineKnobs = {
  /**
   * What the pipeline may merge once the reviewer approves.
   * 'always':    merge anything approved
   * 'code-only': merge code; park anything touching production data, a migration, a stored string, or CI
   * 'never':     never merge; leave approved PRs for a human
   */
  autoMerge: 'code-only',

  /**
   * Review rounds an issue gets before it is ejected to the dead-letter queue.
   *
   * A per-issue high-water mark, not a per-run allowance: the count is kept on the issue as
   * `loop/reviews: N` and survives restarts, so rounds spent in an earlier run are already spent.
   * This is what prevents an issue-level death spiral, where a change nobody can get right cycles
   * between worker and reviewer indefinitely because each new run starts its counting over.
   */
  maxReviewRounds: 3,

  /**
   * Who sits in each seat, as an `engine` or `engine:model` spec resolved against the ENGINES
   * registry. Worker and reviewer are set separately on purpose: running them on different engines
   * means the merge gate does not share the worker's blind spots by construction.
   */
  seats: {
    worker: 'codex:gpt-5.6-sol',
    reviewer: 'claude:claude-opus-5',
  },
};

/**
 * The main checkout of the target repository, resolved from the invoking directory. A driver may
 * be run from a worktree; `--git-common-dir` is the same `.git` for every worktree of a
 * repository, so this answers with the main checkout wherever it is invoked from.
 */
export function repoRootFrom(cwd: string): string {
  const commonDir = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  if (commonDir.exitCode !== 0) {
    console.error('run this from inside the repository the loop should work on; the current directory is not a git repository');
    process.exit(1);
  }
  return dirname(commonDir.stdout.toString().trim());
}

/**
 * The config is read from the invoking checkout's own top level, not from the main checkout: when
 * the driver is started from a worktree, the branch checked out there carries the config the
 * operator edited, and the main checkout may hold another branch without one.
 */
export function invokeRootFrom(cwd: string, repoRoot: string): string {
  const top = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { cwd });
  return top.exitCode === 0 ? top.stdout.toString().trim() : repoRoot;
}

const REQUIRED_PROJECT_FIELDS: Array<keyof ProjectConfig> = [
  'name',
  'repo',
  'remote',
  'baseBranch',
  'evidenceBranch',
  'checkCommand',
  'installCommand',
  'conventionDocs',
  'sizingScale',
  'sharedServices',
  'portBase',
  'portSpan',
  'pathAliases',
  'sourceExtensions',
  'alwaysInvalidates',
  'touchPaths',
  'worktreeRoot',
];

type Knobs = Record<string, unknown> & { seats?: Record<string, string> };

/**
 * Refuses to run an unconfigured repository. A shared driver guessing at a repository's remotes,
 * branches, and conventions is how a loop executes the wrong tracker competently, so a missing or
 * incomplete config is a hard stop with the fix named, not a warning.
 *
 * `positiveIntegers` names the caller's own numeric knobs, so a driver that carries more of them
 * than the pipeline does still validates all of its own.
 */
export async function loadProjectConfig<K extends Knobs>(options: {
  invokeRoot: string;
  repoRoot: string;
  fileName: string;
  defaults: K;
  positiveIntegers: ReadonlyArray<keyof K & string>;
  help: string[];
}): Promise<K & { project: ProjectConfig }> {
  const configFile = join(options.invokeRoot, options.fileName);
  if (!existsSync(configFile)) {
    console.error([`no config at ${configFile}`, ...options.help].join('\n'));
    process.exit(1);
  }
  const loaded = (await import(configFile)).default as (Partial<K> & { project?: ProjectConfig }) | undefined;
  const missing = REQUIRED_PROJECT_FIELDS.filter((field) => loaded?.project?.[field] === undefined);
  if (!loaded?.project || missing.length > 0) {
    console.error(`config ${configFile} is missing project field(s): ${missing.join(', ') || 'project'}`);
    process.exit(1);
  }
  const { project, ...overrides } = loaded as Partial<K> & { project: ProjectConfig };
  const merged = {
    ...options.defaults,
    ...overrides,
    // Seats deep-merge: a config overriding one seat must not silently drop the others.
    seats: { ...(options.defaults.seats ?? {}), ...((overrides as Knobs).seats ?? {}) },
    project,
  } as K & { project: ProjectConfig };

  // Presence is not validity. A shallow undefined check let null enums, empty strings, partial
  // touchPaths, and an in-repository worktreeRoot through to fail later and stranger.
  const faults: string[] = [];
  for (const key of [
    'name',
    'repo',
    'remote',
    'baseBranch',
    'evidenceBranch',
    'checkCommand',
    'installCommand',
    'sizingScale',
  ] as const) {
    if (typeof project[key] !== 'string' || project[key].trim() === '') {
      faults.push(`project.${key} must be a non-empty string`);
    }
  }
  for (const key of ['portBase', 'portSpan'] as const) {
    if (!Number.isInteger(project[key]) || project[key] <= 0) faults.push(`project.${key} must be a positive integer`);
  }
  for (const key of options.positiveIntegers) {
    const value = merged[key];
    if (!Number.isInteger(value) || (value as number) <= 0) faults.push(`${key} must be a positive integer`);
  }
  if (!['always', 'code-only', 'never'].includes((merged as Knobs).autoMerge as string)) {
    faults.push(`autoMerge must be 'always', 'code-only', or 'never'`);
  }
  for (const key of ['conventionDocs', 'sharedServices', 'sourceExtensions', 'alwaysInvalidates'] as const) {
    if (!Array.isArray(project[key])) faults.push(`project.${key} must be an array`);
  }
  if (project.releaseArtifacts !== undefined && !Array.isArray(project.releaseArtifacts)) {
    faults.push('project.releaseArtifacts must be an array when present');
  }
  if (
    !Array.isArray(project.pathAliases) ||
    project.pathAliases.some((alias) => typeof alias?.prefix !== 'string' || typeof alias?.dir !== 'string')
  ) {
    faults.push('project.pathAliases must be an array of { prefix, dir }');
  }
  if (!Array.isArray(project.touchPaths?.migration) || !Array.isArray(project.touchPaths?.ci)) {
    faults.push('project.touchPaths must carry migration and ci arrays; an absent one silently removes a merge boundary');
  }
  const worktreeRootAbs =
    typeof project.worktreeRoot === 'string' ? resolve(options.repoRoot, project.worktreeRoot) : options.repoRoot;
  if (worktreeRootAbs === options.repoRoot || worktreeRootAbs.startsWith(`${options.repoRoot}/`)) {
    faults.push('project.worktreeRoot must resolve outside the repository root');
  }
  if (faults.length > 0) {
    console.error([`config ${configFile} is invalid:`, ...faults.map((fault) => `  - ${fault}`)].join('\n'));
    process.exit(1);
  }
  return merged;
}

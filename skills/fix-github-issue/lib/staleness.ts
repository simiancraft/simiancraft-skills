/**
 * Freshness: whether a base branch that has moved has moved into the work a proof covers.
 *
 * Covered paths are the import closure of the branch's own diff, not the edited files, plus the
 * global invalidators no import graph can reach. This implements the freshness rule written up in
 * the sibling prove-work-on-github skill's references/freshness-and-reproof.md.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Context } from './context.ts';
import { sh } from './shell.ts';

/**
 * Path patterns for `alwaysInvalidates` and `touchPaths`: a pattern that starts with '.' and
 * carries no '/' matches as a filename suffix ('.schema.ts' catches every file so named
 * wherever it lives); anything else matches as a prefix from the repository root, so
 * '.github/workflows/' stays a prefix.
 */
export function matchesPath(file: string, pattern: string): boolean {
  return pattern.startsWith('.') && !pattern.includes('/') ? file.endsWith(pattern) : file.startsWith(pattern);
}

/** Beyond this the closure is not worth computing; treat the proof as stale and re-review. */
export const MAX_BASE_REFRESHES = 2;

export const CLOSURE_CAP = 3000;

/** Resolves an import specifier to a repository-relative file, or null when it leaves the tree. */
export function resolveSpecifier(ctx: Context, cwd: string, fromFile: string, specifier: string): string | null {
  let base: string | undefined;
  // Longest prefix wins, so a project declaring both `~/` and `~/components/` resolves the more
  // specific one rather than whichever happens to be listed first.
  for (const alias of [...ctx.project.pathAliases].sort((a, b) => b.prefix.length - a.prefix.length)) {
    if (specifier.startsWith(alias.prefix)) {
      base = join(alias.dir, specifier.slice(alias.prefix.length));
      break;
    }
  }
  if (base === undefined && specifier.startsWith('.')) base = join(dirname(fromFile), specifier);
  if (base === undefined) return null; // a bare package; dependency changes are caught by the lockfile above

  const stem = base;
  for (const candidate of [
    stem,
    ...ctx.project.sourceExtensions.map((ext) => `${stem}${ext}`),
    ...ctx.project.sourceExtensions.map((ext) => join(stem, `index${ext}`)),
  ]) {
    const abs = join(cwd, candidate);
    if (existsSync(abs) && statSync(abs).isFile()) return candidate;
  }
  return null;
}

/**
 * Every module the given files reach by following imports, transitively, plus the files themselves.
 *
 * This is what an artifact actually covers. A check-command receipt or a rendered frame depends on the
 * whole graph beneath the component, not on the handful of files the diff happens to edit.
 */
export function importClosure(ctx: Context, cwd: string, entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];

  while (queue.length > 0 && seen.size <= CLOSURE_CAP) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    if (!ctx.project.sourceExtensions.some((ext) => file.endsWith(ext))) continue;

    const abs = join(cwd, file);
    if (!existsSync(abs)) continue;

    // `import\s*\(` before `import` in the alternation, so dynamic imports with a literal
    // specifier are followed too; string-built paths remain invisible, as documented.
    for (const match of readFileSync(abs, 'utf8').matchAll(/(?:from|import\s*\(|import|require\()\s*['"]([^'"]+)['"]/g)) {
      const resolved = resolveSpecifier(ctx, cwd, file, match[1]);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

/**
 * Whether the base's package.json movement since `sinceSha` is nothing but a version bump.
 * Release automation that bumps the version on every landing produces noise that must not read as
 * a dependency change, which genuinely invalidates any proof in flight.
 */
export function isVersionOnlyPackageJsonBump(ctx: Context, cwd: string, sinceSha: string, baseSha?: string): boolean {
  const diff = sh(
    ctx,
    ['git', 'diff', '--unified=0', `${sinceSha}...${baseSha ?? `${ctx.project.remote}/${ctx.project.baseBranch}`}`, '--', 'package.json'],
    cwd,
  );
  const changed = diff.split('\n').filter((line) => /^[+-](?![+-])/.test(line));
  return changed.length > 0 && changed.every((line) => /^[+-]\s*"version":/.test(line));
}

/**
 * Every file the base has changed that this lane does not yet contain, release noise included.
 * Empty means the lane holds the current base. This is the "is it behind at all" question, which
 * decides whether a lane catches up; `staleAgainstBase` is the narrower question of whether that
 * movement reached what a proof or an approval covers, which decides what the catch-up costs.
 */
/**
 * Fetches the base once and answers with the commit it is at. A catch-up judges, compares, and
 * merges against this one commit: a base that moves again between those steps must not let the
 * overlap be computed against one tip and the merge bring in another.
 */
export function fetchBase(ctx: Context, cwd: string): string {
  sh(ctx, ['git', 'fetch', ctx.project.remote, ctx.project.baseBranch], cwd);
  return sh(ctx, ['git', 'rev-parse', `${ctx.project.remote}/${ctx.project.baseBranch}`], cwd);
}

export function behindBase(ctx: Context, cwd: string, baseSha?: string): string[] {
  const target = baseSha ?? fetchBase(ctx, cwd);
  if (sh(ctx, ['git', 'rev-list', '--count', `HEAD..${target}`], cwd) === '0') return [];
  const files = sh(ctx, ['git', 'diff', '--name-only', `HEAD...${target}`], cwd).split('\n').filter(Boolean);
  // A base that moved by commits which change no file against this lane (a revert pair, say) is
  // still movement the lane lacks; name the commit so the caller's list is never empty when behind.
  return files.length > 0 ? files : [target.slice(0, 10)];
}

/**
 * What the base has changed since `sinceSha` that this branch's proof actually depends on.
 *
 * Being behind the base is not by itself stale proof. Decay is a function of distance from the base
 * AND of how much of the incoming change intersects the paths the proof covers. Covered paths are
 * the import closure, not the edited files: a base change to a shared chassis module, a generated
 * type, or a lockfile invalidates a receipt while touching nothing the diff touched, and comparing
 * filenames alone would call that fresh and merge it.
 */
export function staleAgainstBase(ctx: Context, cwd: string, sinceSha: string, baseSha?: string): string[] {
  // The pinned commit when the caller fetched already; otherwise fetch here and pin for this call.
  const target = baseSha ?? fetchBase(ctx, cwd);
  const alwaysInvalidates: readonly string[] = ctx.project.alwaysInvalidates;
  const releaseArtifacts: readonly string[] = ctx.project.releaseArtifacts ?? [];

  const lines = (out: string) => out.split('\n').filter(Boolean);

  // Release machinery rewrites its artifacts on every landing; a queue where each merge
  // invalidates every approval behind it re-reviews the same code for noise. Filter that
  // movement out before anything judges freshness. The branch merges without catching up on
  // these files: it does not touch them, so git merges them cleanly, and if a branch ever does
  // touch one, the merge conflicts and fails closed rather than landing anything unreviewed.
  const machineNoise = (file: string) =>
    releaseArtifacts.some((pattern) => matchesPath(file, pattern)) ||
    (file === 'package.json' && isVersionOnlyPackageJsonBump(ctx, cwd, sinceSha, target));

  const incoming = lines(sh(ctx, ['git', 'diff', '--name-only', `${sinceSha}...${target}`], cwd)).filter(
    (file) => !machineNoise(file),
  );
  if (incoming.length === 0) return [];

  const global = incoming.filter((file) => alwaysInvalidates.some((pattern) => matchesPath(file, pattern)));
  if (global.length > 0) return global;

  const mine = lines(sh(ctx, ['git', 'diff', '--name-only', `${target}...HEAD`], cwd));
  const closure = importClosure(ctx, cwd, mine);
  if (closure.size > CLOSURE_CAP) return incoming;

  return incoming.filter((file) => closure.has(file));
}

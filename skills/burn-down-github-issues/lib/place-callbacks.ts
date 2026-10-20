/**
 * Renders the size callback the loop ships into the adopter's callbacks directory, so the
 * appraiser hands an issue sized over the ceiling to the knife without knowing the knife exists.
 *
 * The rendered file is `on-size-over-<maxPoints>`; its second line is an ownership marker, and
 * only files carrying the marker are ever removed or overwritten. A file at the rendered name
 * without the marker is the adopter's and is refused, logged, and left alone. Importable without
 * running the loop, so it is tested against a temporary directory.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OWNERSHIP_MARKER = '# rendered by burn-down-github-issues; edits are overwritten';

export type PlacedCallbacks = { rendered: string | null; removed: string[]; refused: string | null };

/** Single-quoted for a bash script: a quote inside the value becomes '\'' . */
function shellQuote(value: string): string {
  return value.replaceAll("'", "'\\''");
}

function marked(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) return false;
    return readFileSync(path, 'utf8').split('\n')[1]?.trim() === OWNERSHIP_MARKER;
  } catch {
    return false;
  }
}

export function renderSizeCallback(template: string, vars: { repoRoot: string; carveDir: string; maxPoints: number }): string {
  return template
    .replaceAll('{{REPO_ROOT}}', shellQuote(vars.repoRoot))
    .replaceAll('{{CARVE_DIR}}', shellQuote(vars.carveDir))
    .replaceAll('{{MAX_POINTS}}', String(vars.maxPoints));
}

export function placeSizeCallbacks(
  dir: string,
  template: string,
  vars: { repoRoot: string; carveDir: string; maxPoints: number },
  log: (message: string) => void,
  dryRun: boolean,
): PlacedCallbacks {
  const result: PlacedCallbacks = { rendered: null, removed: [], refused: null };
  const name = `on-size-over-${vars.maxPoints}`;
  const target = join(dir, name);
  if (dryRun) {
    log(`DRY RUN  would render ${name} into ${dir}`);
    result.rendered = target;
    return result;
  }
  mkdirSync(dir, { recursive: true });
  // Any other rendering of ours (a previous ceiling) comes off first; the adopter's files stay.
  for (const file of readdirSync(dir)) {
    if (file === name || !/^on-size-over-\d+$/.test(file)) continue;
    const path = join(dir, file);
    if (!marked(path)) continue;
    rmSync(path);
    result.removed.push(path);
    log(`removed ${path}, rendered for an earlier ceiling`);
  }
  if (existsSync(target) && !marked(target)) {
    result.refused = target;
    log(`not overwriting ${target}: it is not the loop's rendering (no ownership marker on line 2)`);
    return result;
  }
  const body = renderSizeCallback(template, vars);
  const temp = join(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync(temp, body);
  chmodSync(temp, 0o755);
  renameSync(temp, target);
  result.rendered = target;
  log(`rendered ${name} into ${dir}`);
  return result;
}

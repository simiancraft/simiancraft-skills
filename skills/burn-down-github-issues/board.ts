#!/usr/bin/env bun
/**
 * The board: one GitHub Projects (v2) board per operator per repository, the durable state a
 * burndown is resumed from. From inside an adopting repository:
 *
 *   bun run <skill-dir>/board.ts               # find the board, create it if absent, verify, print it
 *   bun run <skill-dir>/board.ts --dry-run     # find and report; create nothing
 *   bun run <skill-dir>/board.ts --operator x  # name the board after operator x instead of the gh login
 *
 * The board is titled `<project>_burndown_<operator>`: the config's project name, lower-cased,
 * then the GitHub login the token belongs to. It is owned by the repository's owner (the org or
 * user in `project.repo`) and linked to the repository, so it appears on the repository's
 * Projects tab. Scoping it to the operator is the point: two people burning down the same
 * repository each keep their own board, and one person coming back picks up their own.
 *
 * Idempotent. An open board with that title is reused, never duplicated; a closed one with that
 * title is named and left alone. The board found or created is verified by a second read before
 * anything is printed, and `<worktreeRoot>/runs/board.json` records where it is. The board is
 * the state; the file is only a pointer.
 *
 * Needs the `project` token scope (`gh auth refresh -h github.com -s project`); `read:project`
 * lists but cannot create, and the script says which one it is missing rather than failing in
 * GraphQL.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { invokeRootFrom, loadProjectConfig, PIPELINE_DEFAULTS, repoRootFrom } from '../fix-github-issue/lib/config.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const DRY_RUN = flag('dry-run');

const REPO_ROOT = repoRootFrom(process.cwd());
const INVOKE_ROOT = invokeRootFrom(process.cwd(), REPO_ROOT);
const CONFIG = await loadProjectConfig({
  invokeRoot: INVOKE_ROOT,
  repoRoot: REPO_ROOT,
  fileName: 'burn-down-github-issues.config.ts',
  defaults: PIPELINE_DEFAULTS,
  positiveIntegers: [],
  help: ['board.ts reads the same config the loop does; see references/adopting.md'],
});
const PROJECT = CONFIG.project;
const RUN_DIR = resolve(REPO_ROOT, PROJECT.worktreeRoot, 'runs');
const POINTER = join(RUN_DIR, 'board.json');

export type Board = {
  owner: string;
  number: number;
  id: string;
  title: string;
  url: string;
};

function gh(cmd: string[]): { ok: boolean; out: string; err: string } {
  const proc = Bun.spawnSync(['gh', ...cmd], { cwd: REPO_ROOT, stderr: 'pipe', stdout: 'pipe' });
  return { ok: proc.exitCode === 0, out: proc.stdout.toString().trim(), err: proc.stderr.toString().trim() };
}

function must(cmd: string[]): string {
  const result = gh(cmd);
  if (!result.ok) {
    console.error(`gh ${cmd.join(' ')}\n${result.err}`);
    process.exit(1);
  }
  return result.out;
}

/** The scopes the token carries, from the header GitHub returns on every REST call. */
function tokenScopes(): string[] {
  const head = must(['api', '-i', 'user']);
  const line = head.split('\n').find((l) => l.toLowerCase().startsWith('x-oauth-scopes:'));
  return (line ?? '').slice('x-oauth-scopes:'.length).split(',').map((s) => s.trim()).filter(Boolean);
}

/** `<project>_burndown_<operator>`; the project name lower-cased and reduced to [a-z0-9-]. */
export function boardTitle(projectName: string, operator: string): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug}_burndown_${operator}`;
}

type Listed = { number: number; id: string; title: string; url: string; closed: boolean };

function listBoards(owner: string): Listed[] {
  const json = must(['project', 'list', '--owner', owner, '--closed', '--format', 'json', '--limit', '200']);
  const parsed = JSON.parse(json) as { projects: Listed[] };
  return parsed.projects;
}

function viewBoard(owner: string, number: number): Listed {
  const json = must(['project', 'view', String(number), '--owner', owner, '--format', 'json']);
  return JSON.parse(json) as Listed;
}

const owner = PROJECT.repo.split('/')[0];
const operator = opt('operator') ?? must(['api', 'user', '-q', '.login']);
const title = boardTitle(PROJECT.name, operator);
const scopes = tokenScopes();
const canWrite = scopes.includes('project');

console.log(`board ${title}  owner ${owner}  repo ${PROJECT.repo}  scopes ${scopes.join(', ') || '(none reported)'}`);

const boards = listBoards(owner);
const open = boards.find((b) => b.title === title && !b.closed);
const closed = boards.filter((b) => b.title === title && b.closed);
for (const b of closed) console.log(`  a closed board carries this title: #${b.number} ${b.url}; it is left alone`);

let found: Listed;
if (open) {
  console.log(`  exists: #${open.number} ${open.url}`);
  found = open;
} else if (DRY_RUN) {
  console.log(`  DRY RUN  would create project '${title}' under ${owner} and link it to ${PROJECT.repo}`);
  if (!canWrite) console.log(`  the token lacks the 'project' scope; run: gh auth refresh -h github.com -s project`);
  process.exit(0);
} else {
  if (!canWrite) {
    console.error(`no board '${title}' under ${owner}, and the token cannot create one: it has [${scopes.join(', ')}] and needs 'project'.\nrun: gh auth refresh -h github.com -s project`);
    process.exit(1);
  }
  const json = must(['project', 'create', '--owner', owner, '--title', title, '--format', 'json']);
  const created = JSON.parse(json) as Listed;
  console.log(`  created: #${created.number} ${created.url}`);
  const link = gh(['project', 'link', String(created.number), '--owner', owner, '--repo', PROJECT.repo]);
  if (link.ok) console.log(`  linked to ${PROJECT.repo}`);
  else console.log(`  not linked to ${PROJECT.repo}: ${link.err}`);
  found = created;
}

// Verify by a second, independent read: what the list or the create said is not what is trusted.
const seen = viewBoard(owner, found.number);
if (seen.title !== title || seen.closed) {
  console.error(`verification failed: #${found.number} reads back as '${seen.title}' closed=${seen.closed}`);
  process.exit(1);
}
const board: Board = { owner, number: seen.number, id: seen.id, title: seen.title, url: seen.url };
console.log(`  verified: #${board.number} '${board.title}' ${board.id} ${board.url}`);

if (!DRY_RUN) {
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(POINTER, `${JSON.stringify(board, null, 2)}\n`);
  console.log(`  pointer: ${POINTER}`);
}

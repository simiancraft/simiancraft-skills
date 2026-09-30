#!/usr/bin/env bun
/**
 * Write the lanes onto the operator's board. From inside an adopting repository, after board.ts:
 *
 *   bun run <skill-dir>/lanes.ts             # set Status to the full lane set, ensure the Phase field, verify
 *   bun run <skill-dir>/lanes.ts --dry-run   # print what would change
 *
 * Status is the board's built-in single-select field; its options become the lanes, sent as the
 * complete set in board order (the mutation replaces the whole set and reassigns every option id,
 * so nothing here stores an id). Phase is a second single-select field, created when absent, that
 * the loop writes alongside Status so a view grouped by Phase is the collapsed board.
 *
 * Idempotent: a board already carrying the set is verified and left alone. Needs the `project`
 * scope; see references/adopting.md, "The board".
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { invokeRootFrom, loadProjectConfig, PIPELINE_DEFAULTS, repoRootFrom } from '../fix-github-issue/lib/config.ts';
import type { Board } from './board.ts';
import { type LaneColor, phaseOptions, statusOptions } from './lib/lanes.ts';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

const REPO_ROOT = repoRootFrom(process.cwd());
const INVOKE_ROOT = invokeRootFrom(process.cwd(), REPO_ROOT);
const CONFIG = await loadProjectConfig({
  invokeRoot: INVOKE_ROOT,
  repoRoot: REPO_ROOT,
  fileName: 'burn-down-github-issues.config.ts',
  defaults: PIPELINE_DEFAULTS,
  positiveIntegers: [],
  help: ['lanes.ts reads the same config the loop does; see references/adopting.md'],
});
const POINTER = join(resolve(REPO_ROOT, CONFIG.project.worktreeRoot, 'runs'), 'board.json');
if (!existsSync(POINTER)) {
  console.error(`no board pointer at ${POINTER}; run board.ts first`);
  process.exit(1);
}
const board = JSON.parse(readFileSync(POINTER, 'utf8')) as Board;

type Option = { id: string; name: string; color: LaneColor; description: string };
type Field = { id: string; name: string; options: Option[] };

function graphql(query: string): unknown {
  const proc = Bun.spawnSync(['gh', 'api', 'graphql', '-f', `query=${query}`], { stderr: 'pipe', stdout: 'pipe' });
  if (proc.exitCode !== 0) {
    console.error(proc.stderr.toString().trim() || proc.stdout.toString().trim());
    process.exit(1);
  }
  const parsed = JSON.parse(proc.stdout.toString()) as { data: unknown; errors?: Array<{ message: string }> };
  if (parsed.errors?.length) {
    console.error(parsed.errors.map((e) => e.message).join('\n'));
    process.exit(1);
  }
  return parsed.data;
}

function readFields(): Field[] {
  const data = graphql(
    `{ node(id:"${board.id}") { ... on ProjectV2 { fields(first:50) { nodes { ... on ProjectV2SingleSelectField { id name options { id name color description } } } } } } }`,
  ) as { node: { fields: { nodes: Array<Partial<Field>> } } };
  return data.node.fields.nodes.filter((f): f is Field => typeof f.id === 'string' && Array.isArray(f.options));
}

/** GraphQL input literal for an option list; names and descriptions are JSON-quoted, colors are enums. */
function optionsLiteral(options: Array<{ name: string; color: LaneColor; description: string }>): string {
  return `[${options.map((o) => `{name:${JSON.stringify(o.name)}, color:${o.color}, description:${JSON.stringify(o.description)}}`).join(', ')}]`;
}

function same(current: Option[], wanted: Array<{ name: string; color: LaneColor; description: string }>): boolean {
  if (current.length !== wanted.length) return false;
  return current.every((c, i) => c.name === wanted[i].name && c.color === wanted[i].color && c.description === wanted[i].description);
}

function ensureField(name: string, wanted: Array<{ name: string; color: LaneColor; description: string }>): void {
  const before = readFields().find((f) => f.name === name);
  if (before && same(before.options, wanted)) {
    console.log(`  ${name}: ${wanted.length} options already in place`);
    return;
  }
  if (DRY_RUN) {
    console.log(`  DRY RUN  ${before ? 'would rewrite' : 'would create'} ${name} with ${wanted.length} options:`);
    for (const o of wanted) console.log(`             ${o.name}`);
    return;
  }
  if (before) {
    graphql(
      `mutation { updateProjectV2Field(input:{ fieldId:"${before.id}", singleSelectOptions:${optionsLiteral(wanted)} }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`,
    );
  } else {
    graphql(
      `mutation { createProjectV2Field(input:{ projectId:"${board.id}", dataType:SINGLE_SELECT, name:${JSON.stringify(name)}, singleSelectOptions:${optionsLiteral(wanted)} }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`,
    );
  }
  // Verify by an independent read: the mutation's echo is not what is trusted.
  const after = readFields().find((f) => f.name === name);
  if (!after || !same(after.options, wanted)) {
    console.error(`verification failed: ${name} does not read back as the ${wanted.length} wanted options`);
    process.exit(1);
  }
  console.log(`  ${name}: ${before ? 'rewritten' : 'created'} and verified, ${wanted.length} options`);
}

console.log(`lanes on ${board.title} #${board.number} ${board.url}`);
ensureField('Status', statusOptions());
ensureField('Phase', phaseOptions());

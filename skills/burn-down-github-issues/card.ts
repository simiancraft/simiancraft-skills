#!/usr/bin/env bun
/**
 * Move one card on the operator's board, or read where it is. The seat that runs a lane is the
 * seat that moves the card, and an agent in a worktree is a seat too: the worker prompt runs this
 * when it starts proving (D2) and when it opens the draft (D3), so the board says what the agent
 * is doing rather than what the driver last knew.
 *
 *   bun run <skill-dir>/card.ts --issue <n> --lane D2 [--note "..."]   # move
 *   bun run <skill-dir>/card.ts --issue <n> --show                     # print the lane
 *   bun run <skill-dir>/card.ts --lanes                                # print the lane table
 *
 * From inside the repository the board pointer is read from the config's worktreeRoot. From a
 * worktree, where the config may not exist, the driver renders `--board <path> --repo <owner/name>`
 * into the command so nothing is looked up. No board pointer is not an error: the card has
 * nowhere to go and the command says so, so a repository without a board runs the same prompts.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { invokeRootFrom, loadProjectConfig, PIPELINE_DEFAULTS, repoRootFrom } from '../fix-github-issue/lib/config.ts';
import type { Board } from './board.ts';
import { createBoardWriter } from './lib/board-writer.ts';
import { LANES, laneByKey, PHASES } from './lib/lanes.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag('lanes')) {
  for (const lane of LANES) console.log(`${lane.key.padEnd(3)} ${PHASES[lane.phase].emoji} ${lane.name.padEnd(26)} ${lane.description}`);
  process.exit(0);
}

const ISSUE = (() => {
  const raw = opt('issue');
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n <= 0) {
    console.error(`--issue expects an issue number, got '${raw ?? 'nothing'}'`);
    process.exit(1);
  }
  return n;
})();

/** The board and repository: given outright by a driver, or read from the config by a person. */
async function locate(): Promise<{ pointer: string; repo: string }> {
  const given = opt('board');
  const repo = opt('repo');
  if (given && repo) return { pointer: resolve(given), repo };
  if (given || repo) {
    console.error('--board and --repo go together');
    process.exit(1);
  }
  const repoRoot = repoRootFrom(process.cwd());
  const invokeRoot = invokeRootFrom(process.cwd(), repoRoot);
  const config = await loadProjectConfig({
    invokeRoot,
    repoRoot,
    fileName: 'burn-down-github-issues.config.ts',
    defaults: PIPELINE_DEFAULTS,
    positiveIntegers: [],
    help: ['card.ts reads the same config the loop does, or takes --board <runs/board.json> --repo <owner/name>'],
  });
  return { pointer: join(resolve(repoRoot, config.project.worktreeRoot, 'runs'), 'board.json'), repo: config.project.repo };
}

const { pointer, repo } = await locate();
if (!existsSync(pointer)) {
  console.log(`no board pointer at ${pointer}; #${ISSUE} has no card to move (run board.ts once per operator to make one)`);
  process.exit(0);
}
const board = JSON.parse(readFileSync(pointer, 'utf8')) as Board;
const writer = createBoardWriter(board, repo, (m) => console.log(m));

if (flag('show')) {
  const lane = writer.laneOf(ISSUE);
  console.log(lane ? `#${ISSUE} is in ${lane.key} ${PHASES[lane.phase].emoji} ${lane.name}` : `#${ISSUE} is not on board #${board.number}`);
  process.exit(0);
}

const LANE = opt('lane');
if (!LANE) {
  console.error('--lane <key> is required (see --lanes), or --show');
  process.exit(1);
}
try {
  laneByKey(LANE);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const title = (() => {
  try {
    return Bun.spawnSync(['gh', 'issue', 'view', String(ISSUE), '-R', repo, '--json', 'title', '--jq', '.title']).stdout.toString().trim();
  } catch {
    return '';
  }
})();
// onLane logs the move or the failure itself and never throws. The exit code is whether both
// field writes landed, not a read-back: an item-list immediately after an item-edit can still
// show the old lane for a moment, and a seat must not retry a move that already happened.
process.exit(writer.onLane({ issue: ISSUE, title, lane: LANE, note: opt('note') }) ? 0 : 1);

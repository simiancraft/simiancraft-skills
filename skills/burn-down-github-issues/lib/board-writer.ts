/**
 * Writes cards onto the operator's board: the `onLane` hook a driver hands the fix pipeline, and
 * the placement-by-facts a driver runs before it starts on an issue.
 *
 * The board is a projection of the tracker, so a write here must never fail a lane: every error
 * is logged and swallowed. Field and option ids are read once per process from the board the
 * pointer names and matched by name, never stored, because rewriting the lane set reassigns
 * every option id (see references/adopting.md, "The board").
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LaneEvent } from '../../fix-github-issue/lib/context.ts';
import { dlqPhase } from '../../fix-github-issue/lib/labels.ts';
import type { Board } from '../board.ts';
import { type Lane, laneByKey, laneByLabel, laneLabel, phaseLabel } from './lanes.ts';

type Field = { id: string; name: string; options: Array<{ id: string; name: string }> };

export type BoardWriter = {
  board: Board;
  /** The `onLane` hook: ensure the issue is on the board and set its Status and Phase. True when both writes landed. */
  onLane: (event: LaneEvent) => boolean;
  /** Read the lane the card is in now, or undefined when the issue is not on the board. */
  laneOf: (issue: number) => Lane | undefined;
  /** Every card on the board with its lane and its issue's state and labels, in one read. Throws on a failed read. */
  snapshot: () => Map<number, Card>;
};

export type Card = {
  item: string;
  /** Undefined when the Status option is empty or not one the lane table knows. */
  lane: Lane | undefined;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
};

function gh(args: string[]): string {
  const proc = Bun.spawnSync(['gh', ...args], { stderr: 'pipe', stdout: 'pipe' });
  if (proc.exitCode !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')}: ${proc.stderr.toString().trim()}`);
  return proc.stdout.toString().trim();
}

function graphql(query: string): unknown {
  const out = gh(['api', 'graphql', '-f', `query=${query}`]);
  const parsed = JSON.parse(out) as { data: unknown; errors?: Array<{ message: string }> };
  if (parsed.errors?.length) throw new Error(parsed.errors.map((e) => e.message).join('; '));
  return parsed.data;
}

/** The board pointer `board.ts` wrote, or undefined when this repository has no board yet. */
export function readBoardPointer(repoRoot: string, worktreeRoot: string): Board | undefined {
  const pointer = join(resolve(repoRoot, worktreeRoot, 'runs'), 'board.json');
  if (!existsSync(pointer)) return undefined;
  return JSON.parse(readFileSync(pointer, 'utf8')) as Board;
}

/**
 * A writer bound to one board. Reads the Status and Phase fields once; a lane whose option is
 * missing from the board (the lane set changed and lanes.ts has not been rerun) is reported and
 * skipped rather than guessed.
 */
export function createBoardWriter(board: Board, repo: string, log: (message: string) => void): BoardWriter {
  let fields: { status: Field; phase: Field } | null = null;
  const items = new Map<number, string>();

  const readFields = () => {
    if (fields) return fields;
    const data = graphql(
      `{ node(id:"${board.id}") { ... on ProjectV2 { fields(first:50) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } } } } }`,
    ) as { node: { fields: { nodes: Array<Partial<Field>> } } };
    const all = data.node.fields.nodes.filter((f): f is Field => typeof f.id === 'string' && Array.isArray(f.options));
    const status = all.find((f) => f.name === 'Status');
    const phase = all.find((f) => f.name === 'Phase');
    if (!status || !phase) throw new Error(`board #${board.number} lacks a Status or Phase field; run lanes.ts`);
    fields = { status, phase };
    return fields;
  };

  const itemFor = (issue: number): string => {
    const known = items.get(issue);
    if (known) return known;
    const url = `https://github.com/${repo}/issues/${issue}`;
    // item-add is idempotent on GitHub's side: an issue already on the board returns its item.
    const id = gh(['project', 'item-add', String(board.number), '--owner', board.owner, '--url', url, '--format', 'json', '--jq', '.id']);
    items.set(issue, id);
    return id;
  };

  const setOption = (item: string, field: Field, optionName: string) => {
    const option = field.options.find((o) => o.name === optionName);
    if (!option) throw new Error(`board #${board.number} has no ${field.name} option '${optionName}'; run lanes.ts`);
    gh(['project', 'item-edit', '--id', item, '--project-id', board.id, '--field-id', field.id, '--single-select-option-id', option.id]);
  };

  const onLane = (event: LaneEvent): boolean => {
    try {
      const lane = laneByKey(event.lane);
      const { status, phase } = readFields();
      const item = itemFor(event.issue);
      setOption(item, status, laneLabel(lane));
      setOption(item, phase, phaseLabel(lane.phase));
      log(`#${event.issue}  board: ${lane.key} ${lane.name}${event.note ? ` (${event.note})` : ''}`);
      return true;
    } catch (error) {
      log(`#${event.issue}  board write failed: ${(error as Error).message}`);
      return false;
    }
  };

  const laneOf = (issue: number): Lane | undefined => {
    try {
      const raw = gh(['project', 'item-list', String(board.number), '--owner', board.owner, '--format', 'json', '--limit', '500']);
      const parsed = JSON.parse(raw) as { items: Array<{ content?: { number?: number }; status?: string; id: string }> };
      const item = parsed.items.find((i) => i.content?.number === issue);
      if (!item) return undefined;
      items.set(issue, item.id);
      const { status } = readFields();
      const option = status.options.find((o) => o.name === item.status);
      return option ? laneByLabel(option.name) : undefined;
    } catch (error) {
      log(`#${issue}  board read failed: ${(error as Error).message}`);
      return undefined;
    }
  };

  /**
   * One GraphQL read per hundred cards, paginated: the item id, the Status option name, and the
   * issue's number, state, and labels. Item ids are remembered so a later move needs no item-add.
   */
  const snapshot = (): Map<number, Card> => {
    const cards = new Map<number, Card>();
    let cursor: string | null = null;
    for (;;) {
      const after = cursor ? `, after:"${cursor}"` : '';
      const data = graphql(
        `{ node(id:"${board.id}") { ... on ProjectV2 { items(first:100${after}) { pageInfo { hasNextPage endCursor } nodes { id status: fieldValueByName(name:"Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } content { ... on Issue { number state labels(first:50) { nodes { name } } } } } } } } }`,
      ) as {
        node: {
          items: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{ id: string; status: { name?: string } | null; content: { number?: number; state?: 'OPEN' | 'CLOSED'; labels?: { nodes: Array<{ name: string }> } } | null }>;
          };
        };
      };
      for (const node of data.node.items.nodes) {
        const number = node.content?.number;
        if (number === undefined || !node.content?.state) continue; // a draft item or a pull request card
        items.set(number, node.id);
        cards.set(number, {
          item: node.id,
          lane: node.status?.name ? laneByLabel(node.status.name) : undefined,
          state: node.content.state,
          labels: (node.content.labels?.nodes ?? []).map((l) => l.name),
        });
      }
      if (!data.node.items.pageInfo.hasNextPage) break;
      cursor = data.node.items.pageInfo.endCursor;
    }
    return cards;
  };

  return { board, onLane, laneOf, snapshot };
}

/**
 * Where an issue's facts put it before a driver touches it: the reconcile precedence of
 * references/state-machine.md, reduced to what a single-issue driver can read cheaply. Returns the
 * lane key and the fact that decided it.
 */
export function placeByFacts(facts: {
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  /** The pull requests that own the issue, newest first: open ones, and merged ones for a closed issue. */
  pulls: Array<{ number: number; isDraft: boolean; merged: boolean }>;
  points?: number;
  ceiling: number;
  /** True when a blocked-by edge points at an issue not closed as completed. */
  blocked?: boolean;
}): { lane: string; why: string } {
  const has = (label: string) => facts.labels.includes(label);
  const merged = facts.pulls.find((p) => p.merged);
  if (facts.state === 'CLOSED') return merged ? { lane: 'T1', why: `closed; PR #${merged.number} merged` } : { lane: 'T2', why: 'closed' };
  if (merged) return { lane: 'T1', why: `PR #${merged.number} merged, issue still open` };
  if (has('needs-decision')) return { lane: 'H1', why: 'needs-decision' };
  if (has('needs-human')) return { lane: 'H2', why: 'needs-human' };
  if (has('loop/parked')) return { lane: 'H3', why: 'loop/parked' };
  const dead = dlqPhase(facts.labels.map((name) => ({ name })));
  if (dead) return { lane: { appraisal: 'Q1', carve: 'Q2', work: 'Q3', review: 'Q4', landing: 'Q5' }[dead], why: `loop/dlq: ${dead}` };
  if (has('loop/paused')) return { lane: 'W2', why: 'loop/paused' };
  if (has('loop/released')) return { lane: 'C7', why: 'loop/released' };
  if (has('loop/carved') || facts.labels.some((l) => l.startsWith('loop/carve-gen:'))) return { lane: 'C5', why: 'a carved trunk' };
  const open = facts.pulls.find((p) => !p.merged);
  if (open) return open.isDraft ? { lane: 'D3', why: `draft PR #${open.number}` } : { lane: 'E1', why: `ready PR #${open.number}` };
  if (facts.blocked) return { lane: 'W1', why: 'a blocker is not closed as completed' };
  if (facts.points !== undefined && facts.points > facts.ceiling) return { lane: 'C1', why: `size ${facts.points} over the ceiling of ${facts.ceiling}` };
  if (facts.points !== undefined) return { lane: 'B1', why: `size ${facts.points}` };
  return { lane: 'A1', why: 'unsized' };
}

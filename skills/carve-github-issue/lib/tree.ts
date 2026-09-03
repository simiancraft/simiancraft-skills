/**
 * The tracker as the knife sees it: one issue with its children, blockers, ancestors, claims,
 * announcements, and the newest carving record, read through an injectable `TrackerIo` so the
 * same code runs against GitHub, a dry run, and a fake.
 */

import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import { HOLD_LABELS } from '../../fix-github-issue/lib/labels.ts';
import type { Issue } from '../../fix-github-issue/lib/pipeline.ts';
import { api, sh } from '../../fix-github-issue/lib/shell.ts';
import { parseRecord, type Record } from './record.ts';

export type Comment = {
  /** The GraphQL node id, which is also the REST `node_id`: the join key between the two reads. */
  id: string;
  databaseId: number;
  author: string;
  body: string;
  createdAt: string;
};
export type Seam = 'domain' | 'tier' | 'route' | 'area' | 'file' | 'unit' | 'material';
export type Relation = 'shards' | 'layers' | 'mixed' | 'waiting';
export type OrderRung = 'dependency' | 'source-of-truth' | 'risk' | 'size';

export type Node = Issue & {
  author: string;
  body: string;
  state: 'OPEN' | 'CLOSED' | 'DELETED';
  stateReason: string | null;
  closedAt: string | null;
  subIssues: number[];
  comments: Comment[];
  bodyHash: string;
  /** The newest valid record on this issue's thread, by the bot. */
  record: Record | null;
};

export type Claim = { kind: 'carving' | 'working'; runId: string; at: string; expires: string; commentId: number; released: boolean };

export type IntentKind = 'applying' | 'released' | 'carve-handoff' | 'appraise-handoff' | 'close';
export type Intent = { kind: IntentKind; generation: number | null; commentId: number; createdAt: string; payload: unknown; finished: boolean };

export type Fingerprint = {
  title: string;
  bodyHash: string;
  size: number | null;
  /** Non-loop labels, sorted. */
  labels: string[];
  /** The hold labels present, sorted; a hold's removal is a difference. */
  holds: string[];
  parent: number | null;
  /** Comments by people, sorted by id; the bot's marker comments are excluded. */
  comments: Array<{ id: string; bodyHash: string }>;
  children: Array<{
    number: number;
    state: string;
    stateReason: string | null;
    title: string;
    bodyHash: string;
    labels: string[];
    blockedBy: number[];
    comments: Array<{ id: string; bodyHash: string }>;
    recordAt: string | null;
  }>;
  blockers: Array<{ number: number; state: string; stateReason: string | null }>;
};

export type Tree = {
  issue: Node;
  children: Node[];
  blockers: Node[];
  ancestors: Array<{ number: number; labels: string[]; record: Record | null }>;
  /** Blockers an ancestor's record commands for this issue, read live, whether or not the tracker still carries the edge. */
  recordBlockers: Array<{ via: number; node: Node }>;
  /** The root is 0. */
  depth: number;
  record: Record | null;
  /** The larger of the newest record's generation and the `loop/carve-gen: N` label. */
  generation: number;
  epoch: number;
  claims: Claim[];
  intents: Intent[];
};

export type TrackerWrite = { description: string; argv: string[] };

/** Everything the knife reads from or writes to a tracker. `ghIo` in production; a fake in tests. */
export type TrackerIo = {
  view: (n: number) => Node | null;
  search: (q: string) => Issue[];
  write: (op: TrackerWrite) => void;
};

export const SIZE_LABEL = /^size:\s*(\d+)$/;

export function pointsOf(labels: Array<{ name: string }>): number | null {
  let points: number | null = null;
  for (const label of labels) {
    const match = SIZE_LABEL.exec(label.name);
    if (match) points = Math.max(points ?? 0, Number(match[1]));
  }
  return points;
}

export function hashText(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

/** Every marker the collection writes; a comment carrying one, by the bot, is not a person's word. */
export const MARKER = /<!--\s*(carve-record|carve-rollup|carve-claim|carve-unclaim|carve-handoff|appraise-handoff|carve-answer|carve-pause|carve-unpause|loop-close|carve)\b([^>]*)-->/;

export function parseMarker(text: string): { name: string; fields: { [key: string]: string } } | null {
  const match = MARKER.exec(text);
  if (!match) return null;
  const fields: { [key: string]: string } = {};
  for (const pair of match[2].trim().split(/\s+/)) {
    const eq = pair.indexOf('=');
    if (eq > 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return { name: match[1], fields };
}

export function isBotMarker(comment: Comment, botLogin: string): boolean {
  return comment.author === botLogin && MARKER.test(comment.body);
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

const VIEW_FIELDS = 'number,title,author,body,state,stateReason,labels,createdAt,closedAt,parent,subIssues,subIssuesSummary,blockedBy,comments';
const LIST_FIELDS = 'number,title,createdAt,labels,parent,subIssuesSummary,blockedBy';

type RawView = {
  number: number;
  title: string;
  author: { login: string } | null;
  body: string;
  state: string;
  stateReason: string | null;
  labels: Array<{ name: string }>;
  createdAt: string;
  closedAt: string | null;
  parent: { number: number } | null;
  subIssues: { nodes: Array<{ number: number }>; totalCount: number } | Array<{ number: number }>;
  subIssuesSummary: { total: number; completed: number };
  blockedBy: { nodes: Array<{ number: number; state: string; stateReason: string | null }> } | Array<{ number: number; state: string; stateReason: string | null }>;
  comments: Array<{ id: string; author: { login: string } | null; body: string; createdAt: string }>;
};

type RawRestComment = { id: number; node_id: string; user: { login: string } | null };

/** The production tracker. Every read is one `gh` call; a 404 is a deleted issue, not an error. */
export function ghIo(ctx: Context): TrackerIo {
  return {
    view(n) {
      let raw: RawView;
      try {
        raw = JSON.parse(sh(ctx, ['gh', 'issue', 'view', String(n), '--json', VIEW_FIELDS])) as RawView;
      } catch (error) {
        if (/could not resolve|not found|404/i.test((error as Error).message)) return null;
        throw error;
      }
      let rest: RawRestComment[] = [];
      try {
        const pages = api(ctx, `repos/{repo}/issues/${n}/comments`, ['--paginate', '--slurp', '-X', 'GET', '-f', 'per_page=100']);
        rest = (JSON.parse(pages) as RawRestComment[][]).flat();
      } catch (error) {
        ctx.log(`  #${n}  could not list comments through the REST api: ${(error as Error).message}`);
      }
      return toNode(raw, rest, ctx.botLogin, ctx.log);
    },
    search(q) {
      return JSON.parse(sh(ctx, ['gh', 'issue', 'list', '--search', q, '--state', 'all', '--limit', '5000', '--json', LIST_FIELDS])) as Issue[];
    },
    write(op) {
      sh(ctx, op.argv);
    },
  };
}

/** Maps one `gh issue view` answer plus its REST comment listing onto a Node. Exported for the recorded-output tests. */
export function toNode(raw: RawView, rest: RawRestComment[], botLogin: string, log: (m: string) => void = () => {}): Node {
  const byNodeId = new Map(rest.map((c) => [c.node_id, c]));
  const comments: Comment[] = [];
  for (const c of raw.comments) {
    const match = byNodeId.get(c.id);
    if (!match) {
      log(`  #${raw.number}  comment ${c.id} seen by GraphQL only; dropped until the next read`);
      continue;
    }
    comments.push({ id: c.id, databaseId: match.id, author: c.author?.login ?? match.user?.login ?? 'ghost', body: c.body, createdAt: c.createdAt });
  }
  comments.sort((a, b) => a.databaseId - b.databaseId);
  const subIssues = Array.isArray(raw.subIssues) ? raw.subIssues : raw.subIssues.nodes;
  const blockedBy = Array.isArray(raw.blockedBy) ? { nodes: raw.blockedBy } : raw.blockedBy;
  const node: Node = {
    number: raw.number,
    title: raw.title,
    createdAt: raw.createdAt,
    labels: raw.labels,
    parent: raw.parent,
    subIssuesSummary: raw.subIssuesSummary,
    blockedBy,
    author: raw.author?.login ?? 'ghost',
    body: raw.body ?? '',
    state: raw.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    stateReason: raw.stateReason ?? null,
    closedAt: raw.closedAt ?? null,
    subIssues: subIssues.map((s) => s.number),
    comments,
    bodyHash: hashText(raw.body ?? ''),
    record: null,
  };
  node.record = latestRecord(node, botLogin, log);
  return node;
}

export function deletedNode(number: number): Node {
  return {
    number,
    title: '',
    createdAt: '',
    labels: [],
    author: 'ghost',
    body: '',
    state: 'DELETED',
    stateReason: null,
    closedAt: null,
    subIssues: [],
    comments: [],
    bodyHash: hashText(''),
    record: null,
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The newest comment by the bot carrying a valid record marker and JSON; anything else is not a record. */
export function latestRecord(node: Node, botLogin: string, log: (m: string) => void = () => {}): Record | null {
  for (let i = node.comments.length - 1; i >= 0; i--) {
    const c = node.comments[i];
    if (c.author !== botLogin || !c.body.includes('<!-- carve-record')) continue;
    const record = parseRecord(c, botLogin, log);
    if (record) return record;
  }
  return null;
}

export function generationLabel(labels: Array<{ name: string }>): number {
  let gen = 0;
  for (const { name } of labels) {
    const match = /^loop\/carve-gen:\s*(\d+)$/.exec(name);
    if (match) gen = Math.max(gen, Number(match[1]));
  }
  return gen;
}

export function readTree(ctx: Context, number: number, io: TrackerIo = ghIo(ctx)): Tree {
  const issue = io.view(number);
  if (!issue) throw new Error(`#${number} does not exist`);
  const children = issue.subIssues.map((n) => io.view(n) ?? deletedNode(n));
  const blockers = (issue.blockedBy?.nodes ?? []).map((b) => io.view(b.number) ?? deletedNode(b.number));
  const ancestors: Tree['ancestors'] = [];
  const seen = new Set<number>([number]);
  let parent = issue.parent?.number ?? null;
  while (parent !== null && !seen.has(parent)) {
    seen.add(parent);
    const node = io.view(parent);
    if (!node) break;
    ancestors.push({ number: node.number, labels: node.labels.map((l) => l.name), record: node.record });
    parent = node.parent?.number ?? null;
  }
  const recordBlockers: Tree['recordBlockers'] = [];
  for (const ancestor of ancestors) {
    const rec = ancestor.record;
    if (!rec || rec.state === 'released') continue;
    const me = rec.children.find((c) => c.number === number);
    if (!me) continue;
    for (const dep of me.dependsOn) {
      const target = rec.children.find((c) => c.piece === dep);
      if (!target || target.number === null || target.number === number) continue;
      if (recordBlockers.some((b) => b.node.number === target.number)) continue;
      recordBlockers.push({ via: ancestor.number, node: io.view(target.number) ?? deletedNode(target.number) });
    }
  }
  const record = issue.record;
  return {
    issue,
    children,
    blockers,
    recordBlockers,
    ancestors,
    depth: ancestors.length,
    record,
    generation: Math.max(record?.generation ?? 0, generationLabel(issue.labels)),
    epoch: record?.epoch ?? 1,
    claims: claimsOf(issue, ctx.botLogin),
    intents: intentsOf(issue, ctx.botLogin),
  };
}

/** Every sub-issue under `number`, transitively, through `io.view`. */
export function descendants(number: number, io: TrackerIo): number[] {
  const out: number[] = [];
  const seen = new Set<number>([number]);
  const queue = [number];
  while (queue.length > 0) {
    const n = queue.shift() as number;
    const node = io.view(n);
    if (!node) continue;
    for (const child of node.subIssues) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Claims and intents
// ---------------------------------------------------------------------------

export function claimsOf(node: Node, botLogin: string): Claim[] {
  const claims: Claim[] = [];
  const released = new Set<string>();
  for (const c of node.comments) {
    if (c.author !== botLogin) continue;
    const marker = parseMarker(c.body);
    if (!marker) continue;
    if (marker.name === 'carve-claim' && (marker.fields.kind === 'carving' || marker.fields.kind === 'working')) {
      claims.push({
        kind: marker.fields.kind,
        runId: marker.fields.run ?? '',
        at: marker.fields.at ?? c.createdAt,
        expires: marker.fields.expires ?? c.createdAt,
        commentId: c.databaseId,
        released: false,
      });
    } else if (marker.name === 'carve-unclaim') {
      released.add(`${marker.fields.kind}:${marker.fields.run}`);
    }
  }
  for (const claim of claims) {
    if (released.has(`${claim.kind}:${claim.runId}`)) claim.released = true;
  }
  return claims;
}

/**
 * The earliest (by databaseId) unreleased, unexpired claim of either kind that is not ours. Two
 * runs that both claimed see the same winner, because both read the same order.
 */
export function liveClaim(tree: Tree, now: string, ours?: string, isDead: (runId: string) => boolean = deadOnThisHost): Claim | null {
  const nowMs = Date.parse(now);
  const live = tree.claims
    .filter((c) => !c.released && Date.parse(c.expires) > nowMs && c.runId !== ours && !isDead(c.runId))
    .sort((a, b) => a.commentId - b.commentId);
  return live[0] ?? null;
}

/**
 * A claim by a process on this host that no longer exists is stale at once, expiry or not: the
 * runId carries the hostname and pid, and a killed run cannot renew. Another host's claim is
 * trusted until it expires, since its liveness cannot be read from here.
 */
export function deadOnThisHost(runId: string): boolean {
  const match = /^(.*)-(\d+)-\d+$/.exec(runId);
  if (!match) return false;
  const [, host, pid] = match;
  if (host !== hostname()) return false;
  try {
    process.kill(Number(pid), 0);
    return false;
  } catch {
    return true;
  }
}

function fencedJson(body: string): unknown {
  const match = /```json\s*\n([\s\S]*?)\n```/.exec(body);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/** Every announcement on the thread by the bot, with whether its completion predicate holds now. */
export function intentsOf(node: Node, botLogin: string): Intent[] {
  const labels = new Set(node.labels.map((l) => l.name));
  const intents: Intent[] = [];
  const records: Array<{ record: Record; comment: Comment }> = [];
  for (const c of node.comments) {
    if (c.author !== botLogin) continue;
    const marker = parseMarker(c.body);
    if (!marker) continue;
    if (marker.name === 'carve-record') {
      const record = parseRecord(c, botLogin);
      if (record) records.push({ record, comment: c });
    }
  }
  const liveAfter = (comment: Comment, test: (r: Record) => boolean) =>
    records.some((r) => r.comment.databaseId > comment.databaseId && r.record.state === 'live' && test(r.record));

  for (const c of node.comments) {
    if (c.author !== botLogin) continue;
    const marker = parseMarker(c.body);
    if (!marker) continue;
    const base = { commentId: c.databaseId, createdAt: c.createdAt };
    switch (marker.name) {
      case 'carve-record': {
        const entry = records.find((r) => r.comment.databaseId === c.databaseId);
        if (!entry) break;
        const { record } = entry;
        if (record.state === 'applying') {
          intents.push({ ...base, kind: 'applying', generation: record.generation, payload: record, finished: liveAfter(c, (r) => r.generation === record.generation) });
        } else if (record.state === 'released') {
          // Consumed by the label, by the release appraisal that took the label off again (a size
          // label, a newer record, or a close), never resurrected by a later reopen.
          const newer = records.some((r) => r.comment.databaseId > c.databaseId);
          const finished = labels.has('loop/released') || newer || node.state !== 'OPEN' || pointsOf(node.labels) !== null;
          intents.push({ ...base, kind: 'released', generation: record.generation, payload: record, finished });
        }
        break;
      }
      case 'carve-handoff': {
        const verdict = marker.fields.verdict ?? '';
        const gen = marker.fields.gen ? Number(marker.fields.gen) : null;
        intents.push({ ...base, kind: 'carve-handoff', generation: gen, payload: { verdict, ...(fencedJson(c.body) as object | null) }, finished: liveAfter(c, (r) => r.verdict === verdict) });
        break;
      }
      case 'appraise-handoff': {
        const verdict = marker.fields.verdict ?? '';
        const hold = verdict === 'needs-decision' ? 'needs-decision' : 'needs-human';
        intents.push({ ...base, kind: 'appraise-handoff', generation: null, payload: { verdict, ...(fencedJson(c.body) as object | null) }, finished: labels.has(hold) });
        break;
      }
      case 'loop-close': {
        // Finished by a close with the reason the verdict names, not by any close.
        const verdict = marker.fields.verdict ?? '';
        const wanted = /^(obsolete|superseded|not-planned)/.test(verdict) ? 'NOT_PLANNED' : 'COMPLETED';
        const finished = node.state === 'DELETED' || (node.state === 'CLOSED' && (node.stateReason ?? 'COMPLETED') === wanted);
        intents.push({ ...base, kind: 'close', generation: null, payload: { verdict, by: marker.fields.by }, finished });
        break;
      }
      default:
        break;
    }
  }
  return intents;
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

const byNumber = <T extends { number: number }>(a: T, b: T) => a.number - b.number;
const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function peopleComments(node: Node, botLogin: string): Array<{ id: string; bodyHash: string }> {
  return node.comments
    .filter((c) => !isBotMarker(c, botLogin))
    .map((c) => ({ id: c.id, bodyHash: hashText(c.body) }))
    .sort(byId);
}

/** What the tracker looked like, canonically ordered, so two reads of one state hash the same. */
export function fingerprint(tree: Tree, botLogin: string): Fingerprint {
  const names = tree.issue.labels.map((l) => l.name);
  return {
    title: tree.issue.title,
    bodyHash: tree.issue.bodyHash,
    size: pointsOf(tree.issue.labels),
    labels: names.filter((n) => !n.startsWith('loop/')).sort(),
    holds: names.filter((n) => HOLD_LABELS.includes(n)).sort(),
    parent: tree.issue.parent?.number ?? null,
    comments: peopleComments(tree.issue, botLogin),
    children: tree.children
      .map((c) => ({
        number: c.number,
        state: c.state,
        stateReason: c.stateReason,
        title: c.title,
        bodyHash: c.bodyHash,
        labels: c.labels.map((l) => l.name).sort(),
        blockedBy: (c.blockedBy?.nodes ?? []).map((b) => b.number).sort((a, b) => a - b),
        comments: peopleComments(c, botLogin),
        recordAt: c.record?.at ?? null,
      }))
      .sort(byNumber),
    blockers: tree.blockers.map((b) => ({ number: b.number, state: b.state, stateReason: b.stateReason })).sort(byNumber),
  };
}

/**
 * The first field of the fingerprint that differs from what the record saw; `no-record` when there
 * is none; never anything for a released record, whose trunk is not revisited.
 */
export function needsRevisit(record: Record | null, tree: Tree, botLogin: string): string | null {
  if (!record) return 'no-record';
  if (record.state === 'released') return null;
  const now = fingerprint(tree, botLogin);
  const seen = record.seen;
  for (const key of Object.keys(now) as Array<keyof Fingerprint>) {
    if (JSON.stringify(now[key]) !== JSON.stringify(seen?.[key])) return key;
  }
  return null;
}

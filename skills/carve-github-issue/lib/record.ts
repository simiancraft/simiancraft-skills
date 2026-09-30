/**
 * The carving record: the comment the knife posts on a trunk at every step that changes the
 * carving, and the ledger inside it that classifies every acceptance criterion of the parent. The
 * newest record is authoritative; workers, revisits, and people read it. Grammar in
 * `references/the-record.md`.
 */

import type { Comment, Fingerprint, OrderRung, Relation, Seam, Tree } from './tree.ts';

export type CriterionStatus = 'open' | 'completed' | 'deferred' | 'withdrawn' | 'orphaned';
export type ChildStatus = 'open' | 'closed-completed' | 'closed-not-planned' | 'superseded' | 'deleted';

export type Ledger = Array<{
  id: string;
  text: string;
  /** Piece index into the record's children; null when unowned. */
  owner: number | null;
  status: CriterionStatus;
  /** The comment id a withdrawal cites. */
  cite?: string;
  /** For a deferred criterion, the spike piece it waits on. */
  waitsOn?: number;
}>;

export type Piece = {
  kind: 'author' | 'child' | 'reference';
  title?: string;
  body?: string;
  /** The issue number for a child or reference; set on an authored piece once it exists. */
  number?: number;
  points: number | null;
  role: 'work' | 'spike';
  criteria: string[];
  dependsOn: number[];
  order: number;
  orderRung: OrderRung;
};

export type Cut = {
  seam: Seam;
  higherRungs: Array<{ seam: Seam; why: string }>;
  relation: Relation;
  state: 'complete' | 'partial' | 'inadmissible';
  deferred: Array<{ criterion: string; waitsOn: number }>;
  pieces: Piece[];
  groundwork: Array<{ what: string; owner: number }>;
  width: { instances: string[]; perInstance: string } | null;
  balance: string;
  independence: string;
};

export type RecordChild = {
  /** Null in an applying record for a piece not yet created. */
  number: number | null;
  piece: number;
  kind: Piece['kind'];
  link: 'sub-issue' | 'blocker';
  points: number | null;
  order: number;
  orderRung: OrderRung;
  dependsOn: number[];
  status: ChildStatus;
  paused: boolean;
  role: Piece['role'];
  title: string;
};

export type Record = {
  generation: number;
  epoch: number;
  state: 'applying' | 'live' | 'released';
  verdict: string;
  reason: string;
  cut: Cut | null;
  children: RecordChild[];
  supersedes: Array<{ old: number; replacements: number[]; reason: string }>;
  affected: string[];
  ledger: Ledger;
  revisits: number;
  seen: Fingerprint;
  at: string;
  note?: 'hold-observed';
};

export const RECORD_MARKER = /<!--\s*carve-record\s+gen=(\d+)\s+epoch=(\d+)\s+state=(applying|live|released)\s*-->/;

export function recordMarker(r: Pick<Record, 'generation' | 'epoch' | 'state'>): string {
  return `<!-- carve-record gen=${r.generation} epoch=${r.epoch} state=${r.state} -->`;
}

/** The marker line, one fenced json block holding the record verbatim, then a table for people. */
export function renderRecord(r: Record): string {
  const rows = r.children.map(
    (c) =>
      `| ${c.order} | ${c.number === null ? '(pending)' : `#${c.number}`} | ${c.title} | ${c.kind} | ${c.role} | ${c.points ?? '?'} | ${c.dependsOn.length ? c.dependsOn.map((d) => `piece ${d}`).join(', ') : ''} | ${c.status}${c.paused ? ', paused' : ''} |`,
  );
  const ledger = r.ledger.map((l) => `| ${l.id} | ${l.text} | ${l.owner === null ? '' : `piece ${l.owner}`} | ${l.status}${l.cite ? ` (${l.cite})` : ''} |`);
  return [
    recordMarker(r),
    '```json',
    JSON.stringify(r),
    '```',
    `**Carving record**, generation ${r.generation}, epoch ${r.epoch}, ${r.state}: ${r.verdict}. ${r.reason}`,
    '',
    r.cut ? `Seam: ${r.cut.seam}; relation: ${r.cut.relation}; cut ${r.cut.state}.` : 'No cut in this record.',
    '',
    '| Order | Issue | Title | Kind | Role | Points | Depends on | Status |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '| Criterion | Text | Owner | Status |',
    '|---|---|---|---|',
    ...ledger,
    '',
    `Revisits this generation and epoch: ${r.revisits}.${r.note ? ` Note: ${r.note}.` : ''}`,
  ].join('\n');
}

/** Marker, author, and JSON must all check; anything else on the thread is not a record. */
export function parseRecord(comment: Comment, botLogin: string, log: (m: string) => void = () => {}): Record | null {
  if (comment.author !== botLogin) return null;
  const marker = RECORD_MARKER.exec(comment.body);
  if (!marker) return null;
  const fenced = /```json\s*\n([\s\S]*?)\n```/.exec(comment.body);
  if (!fenced) {
    log(`record comment ${comment.databaseId} has no json block; ignored`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced[1]);
  } catch {
    log(`record comment ${comment.databaseId} has malformed json; ignored`);
    return null;
  }
  const r = parsed as Partial<Record>;
  const valid =
    r &&
    typeof r === 'object' &&
    Number.isInteger(r.generation) &&
    Number.isInteger(r.epoch) &&
    (r.state === 'applying' || r.state === 'live' || r.state === 'released') &&
    typeof r.verdict === 'string' &&
    Array.isArray(r.children) &&
    Array.isArray(r.ledger) &&
    typeof r.at === 'string' &&
    r.seen !== undefined;
  if (!valid) {
    log(`record comment ${comment.databaseId} is not a record shape; ignored`);
    return null;
  }
  if (Number(marker[1]) !== r.generation || Number(marker[2]) !== r.epoch || marker[3] !== r.state) {
    log(`record comment ${comment.databaseId} marker disagrees with its json; ignored`);
    return null;
  }
  const full = r as Record;
  return {
    ...full,
    supersedes: full.supersedes ?? [],
    affected: full.affected ?? [],
    revisits: full.revisits ?? 0,
    cut: full.cut ?? null,
    reason: full.reason ?? '',
  };
}

export const CHILD_MARKER = /<!--\s*carve\s+parent=(\d+)\s+gen=(\d+)\s+piece=(\d+)\s*-->/;

export function childMarker(trunk: number, generation: number, index: number): string {
  return `<!-- carve parent=${trunk} gen=${generation} piece=${index} -->`;
}

/** An authored child's body: the marker, a pointer at the trunk's record, then the piece's own body. */
export function renderChildBody(trunk: number, generation: number, index: number, piece: Piece): string {
  return [
    childMarker(trunk, generation, index),
    `Part of #${trunk}. Read the newest carving record on #${trunk} (and on every ancestor) before starting: it says where this piece sits, what it may assume has landed, and what it must not touch.`,
    '',
    piece.body ?? '',
  ].join('\n');
}

/** Whitespace-insensitive equality for body adoption checks. */
export function sameBody(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return norm(a) === norm(b);
}

// ---------------------------------------------------------------------------
// Criterion ids and the ledger
// ---------------------------------------------------------------------------

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = new Array<number>(rows * cols);
  for (let i = 0; i < rows; i++) d[i * cols] = i;
  for (let j = 0; j < cols; j++) d[j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i * cols + j] = Math.min(d[(i - 1) * cols + j] + 1, d[i * cols + j - 1] + 1, d[(i - 1) * cols + j - 1] + cost);
    }
  }
  return d[rows * cols - 1];
}

/** 0 for equal normalized texts; otherwise the edit distance over the longer length. */
function textDistance(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 0;
  const longer = Math.max(na.length, nb.length);
  return longer === 0 ? 0 : levenshtein(na, nb) / longer;
}

const CARRY_THRESHOLD = 0.2;

function nextId(taken: Set<string>): string {
  for (let i = 1; ; i++) {
    const id = `A${i}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

/**
 * Keeps criterion ids stable across generations: one-to-one, greedy by best score, an old id
 * reused when the normalized texts are equal or within the edit-distance threshold, ties broken by
 * the earliest old id; every other criterion gets a fresh id.
 */
export function carryIds(previous: Ledger, criteria: Array<{ text: string }>): Array<{ id: string; text: string }> {
  const candidates: Array<{ oldIndex: number; newIndex: number; score: number }> = [];
  previous.forEach((old, oldIndex) => {
    criteria.forEach((fresh, newIndex) => {
      const score = textDistance(old.text, fresh.text);
      if (score <= CARRY_THRESHOLD) candidates.push({ oldIndex, newIndex, score });
    });
  });
  candidates.sort((a, b) => a.score - b.score || a.oldIndex - b.oldIndex || a.newIndex - b.newIndex);
  const usedOld = new Set<number>();
  const assigned = new Map<number, string>();
  for (const c of candidates) {
    if (usedOld.has(c.oldIndex) || assigned.has(c.newIndex)) continue;
    usedOld.add(c.oldIndex);
    assigned.set(c.newIndex, previous[c.oldIndex].id);
  }
  const taken = new Set(previous.map((p) => p.id));
  return criteria.map((fresh, i) => ({ id: assigned.get(i) ?? nextId(taken), text: fresh.text }));
}

/**
 * The ledger for the criteria as they stand now, carrying owners and statuses from the previous
 * ledger and re-judging each owner's state from the tree: closed COMPLETED completes, closed
 * NOT_PLANNED or deleted orphans, reopened returns to open, a spike closed makes its deferred
 * criteria open and unowned, and a withdrawal stands only while its cited comment is unchanged.
 */
export function buildLedger(previous: Ledger | null, criteria: Array<{ id: string; text: string }>, record: Record | null, tree: Tree): Ledger {
  const byId = new Map((previous ?? []).map((row) => [row.id, row]));
  const childOf = (piece: number | null | undefined) => {
    if (piece === null || piece === undefined || !record) return null;
    const rc = record.children.find((c) => c.piece === piece);
    if (!rc || rc.number === null) return null;
    return { rc, node: [...tree.children, ...tree.blockers].find((n) => n.number === rc.number) ?? null };
  };
  const commentHashes = new Map(tree.issue.comments.map((c) => [c.id, c.body]));
  return criteria.map(({ id, text }) => {
    const prior = byId.get(id);
    if (!prior) return { id, text, owner: null, status: 'open' as const };
    const row: Ledger[number] = { ...prior, id, text };
    if (prior.status === 'withdrawn') {
      const cite = prior.cite ?? '';
      const citedId = cite.split('#')[0];
      const live = commentHashes.has(citedId);
      return live ? row : { ...row, status: 'open', cite: undefined };
    }
    const owner = childOf(prior.owner);
    if (owner) {
      const { rc, node } = owner;
      const state = node?.state ?? (rc.status === 'deleted' ? 'DELETED' : 'OPEN');
      if (state === 'DELETED') return { ...row, status: 'orphaned' };
      if (state === 'CLOSED') {
        if (node?.stateReason === 'NOT_PLANNED') return { ...row, status: 'orphaned' };
        if (rc.role === 'spike' && prior.status !== 'completed') return { ...row, status: 'completed' };
        return { ...row, status: 'completed' };
      }
      // open again, or still open
      if (prior.status === 'completed' || prior.status === 'orphaned') return { ...row, status: 'open' };
    }
    if (prior.status === 'deferred' && prior.waitsOn !== undefined) {
      const spike = childOf(prior.waitsOn);
      const spikeState = spike?.node?.state ?? 'OPEN';
      if (spikeState !== 'OPEN') return { ...row, status: 'open', owner: null, waitsOn: undefined };
    }
    return row;
  });
}

/**
 * The leaves a question touches: the sub-issue owners of the affected criteria, their dependents
 * along recorded edges transitively, and every descendant of each. A blocker-linked reference is
 * never paused; it is not the trunk's to pause.
 */
export function pauseSet(record: Record, affected: string[], descendantsOf: (n: number) => number[]): number[] {
  const affectedIds = new Set(affected);
  const pieces = new Set<number>();
  for (const row of record.ledger) {
    if (affectedIds.has(row.id) && row.owner !== null) pieces.add(row.owner);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const child of record.children) {
      if (pieces.has(child.piece)) continue;
      if (child.dependsOn.some((d) => pieces.has(d))) {
        pieces.add(child.piece);
        grew = true;
      }
    }
  }
  const out = new Set<number>();
  for (const child of record.children) {
    if (!pieces.has(child.piece) || child.number === null || child.link !== 'sub-issue') continue;
    out.add(child.number);
    for (const d of descendantsOf(child.number)) out.add(d);
  }
  return [...out].sort((a, b) => a - b);
}

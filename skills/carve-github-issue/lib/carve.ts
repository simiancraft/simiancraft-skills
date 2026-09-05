/**
 * The knife's library: what the carver and the confirmer may answer, checked field by field before
 * anything is believed; how a piece is matched against what the tracker already holds; and (in
 * the second half of this file) the state machine that turns a confirmed cut into sub-issues.
 *
 * Programmatic validation owns everything mechanical and rejects an answer whole on any miss; the
 * confirmer owns meaning. Nothing an agent writes reaches the tracker without passing here.
 */

import type { Seat } from '../../fix-github-issue/lib/engines.ts';
import type { Cut, Ledger, Piece, Record } from './record.ts';
import type { OrderRung, Relation, Seam, Tree, TrackerIo } from './tree.ts';

export const SEAMS: Seam[] = ['domain', 'tier', 'route', 'area', 'file', 'unit', 'material'];
export const RELATIONS: Relation[] = ['shards', 'layers', 'mixed', 'waiting'];
export const ORDER_RUNGS: OrderRung[] = ['dependency', 'source-of-truth', 'risk', 'size'];

export type CarveVerdict = 'carve' | 'small-enough' | 'indivisible' | 'too-uncertain' | 'nothing-left';
export type RevisitVerdict = 'still-good' | 'amend' | 'exhausted' | 'indivisible' | 'too-uncertain';
export const CARVE_VERDICTS: CarveVerdict[] = ['carve', 'small-enough', 'indivisible', 'too-uncertain', 'nothing-left'];
export const REVISIT_VERDICTS: RevisitVerdict[] = ['still-good', 'amend', 'exhausted', 'indivisible', 'too-uncertain'];
/** The verdicts that hand the trunk to a person, and the hold label each takes. */
export const HAND_OFFS: { [verdict: string]: 'needs-human' | 'needs-decision' } = {
  'small-enough': 'needs-human',
  indivisible: 'needs-human',
  'nothing-left': 'needs-human',
  'too-uncertain': 'needs-decision',
};

export type Carving = {
  issue: number;
  mode: 'carve' | 'revisit';
  verdict: CarveVerdict | RevisitVerdict;
  reason: string;
  criteria: Array<{ id: string; text: string }>;
  ledger: Ledger;
  chosen?: number;
  cuts?: Cut[];
  supersedes?: Array<{ old: number; replacements: number[]; reason: string }>;
  affected?: string[];
};

export type Finding =
  | 'cover'
  | 'gap'
  | 'overreach'
  | 'partition-intact'
  | 'partition-broken'
  | 'still-good'
  | 'not-still-good'
  | 'exhausted'
  | 'not-exhausted'
  | 'hand-off-agree'
  | 'hand-off-disagree';
export const AGREEING: Finding[] = ['cover', 'partition-intact', 'still-good', 'exhausted', 'hand-off-agree'];

export type Confirmation = {
  issue: number;
  mode: 'carve' | 'revisit';
  agree: boolean;
  finding: Finding;
  seam: 'agree' | 'higher-available';
  seamCase: string;
  reason: string;
};

export type JournalStep =
  | 'claim'
  | 'applying-record'
  | 'create'
  | 'adopt'
  | 'reference'
  | 'edge'
  | 'unedge'
  | 'supersede'
  | 'pause'
  | 'unpause'
  | 'callback'
  | 'live-record'
  | 'handed-off-label'
  | 'gen-label'
  | 'carved-label'
  | 'counters'
  | 'handoff-comment'
  | 'hold-label'
  | 'released-record'
  | 'release-size'
  | 'release-labels'
  | 'release-counters'
  | 'unclaim';
export const JOURNAL_STEPS: JournalStep[] = [
  'claim',
  'applying-record',
  'create',
  'adopt',
  'reference',
  'edge',
  'unedge',
  'supersede',
  'pause',
  'unpause',
  'callback',
  'live-record',
  'handed-off-label',
  'gen-label',
  'carved-label',
  'counters',
  'handoff-comment',
  'hold-label',
  'released-record',
  'release-size',
  'release-labels',
  'release-counters',
  'unclaim',
];

export type Journal = {
  issue: number;
  generation: number;
  status: 'open' | 'done';
  steps: Array<{ name: JournalStep; target?: number; status: 'pending' | 'done' | 'abandoned'; why?: string }>;
};

export type CarveKnobs = {
  ceiling: number;
  maxDepth: number;
  maxChildren: number;
  maxCarveRounds: number;
  maxCarveAttempts: number;
  maxGenerations: number;
  maxRevisitsPerGeneration: number;
  /** Resolved. */
  callbacksDir: string;
  seats: { carver: Seat; confirmer: Seat };
  /** Dev only: exit hard after the first journal step of this name, so the next run must repair. */
  failAfter?: JournalStep;
};

export const CARVE_DEFAULTS = {
  maxDepth: 3,
  maxChildren: 8,
  maxCarveRounds: 5,
  maxCarveAttempts: 3,
  maxGenerations: 5,
  maxRevisitsPerGeneration: 10,
};

export type CarveOutcome = {
  outcome: CarveVerdict | RevisitVerdict | 'busy' | 'resumed' | 'left-alone' | 'failed';
  reason: string;
  generation?: number;
  children?: number[];
  /** In memory; a dry run returns it instead of writing runs/. */
  journal?: Journal;
};

/** The root is 0; an issue at depth d is carvable iff d < maxDepth. */
export function depthOf(tree: Tree): number {
  return tree.depth;
}

// ---------------------------------------------------------------------------
// The carver's answer
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is { [key: string]: unknown } => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isIndexArray = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.every((i) => Number.isInteger(i) && i >= 0 && i < n);
const HEADINGS = ['scope', 'acceptance', 'proof'];

function headingsPresent(body: string): string[] {
  const found = new Set<string>();
  for (const line of body.split('\n')) {
    const match = /^#{1,6}\s*([a-z]+)/i.exec(line.trim());
    if (match) found.add(match[1].toLowerCase());
  }
  return HEADINGS.filter((h) => !found.has(h));
}

/** True when the dependency graph has a cycle. */
function cyclic(pieces: Array<{ dependsOn: number[] }>): boolean {
  const state = new Array<number>(pieces.length).fill(0);
  const visit = (i: number): boolean => {
    if (state[i] === 1) return true;
    if (state[i] === 2) return false;
    state[i] = 1;
    for (const d of pieces[i].dependsOn) if (visit(d)) return true;
    state[i] = 2;
    return false;
  };
  return pieces.some((_, i) => visit(i));
}

function validateCut(cut: unknown, faults: string[], where: string, options: { ceiling: number; scale: number[]; maxChildren: number; tree: Tree; criteriaIds: Set<string>; chosen: boolean }): Cut | null {
  if (!isObject(cut)) {
    faults.push(`${where} is not an object`);
    return null;
  }
  const seam = cut.seam as Seam;
  if (!SEAMS.includes(seam)) faults.push(`${where}.seam '${String(cut.seam)}' is not one of ${SEAMS.join(', ')}`);
  if (!RELATIONS.includes(cut.relation as Relation)) faults.push(`${where}.relation '${String(cut.relation)}' is not one of ${RELATIONS.join(', ')}`);
  if (!['complete', 'partial', 'inadmissible'].includes(cut.state as string)) faults.push(`${where}.state must be complete, partial, or inadmissible`);
  if (!Array.isArray(cut.higherRungs)) faults.push(`${where}.higherRungs must be an array`);
  if (!Array.isArray(cut.pieces)) faults.push(`${where}.pieces must be an array`);
  if (!Array.isArray(cut.deferred)) faults.push(`${where}.deferred must be an array`);
  if (!Array.isArray(cut.groundwork)) faults.push(`${where}.groundwork must be an array`);
  if (typeof cut.balance !== 'string' || typeof cut.independence !== 'string') faults.push(`${where}.balance and .independence must be strings`);
  if (cut.width !== null && cut.width !== undefined) {
    const w = cut.width as { instances?: unknown; perInstance?: unknown };
    if (!isObject(w) || !Array.isArray(w.instances) || !nonEmpty(w.perInstance)) faults.push(`${where}.width must be null or { instances: [], perInstance }`);
    else if (cut.relation !== 'shards') faults.push(`${where} is a width cut, so its relation must be shards`);
  }
  if (!options.chosen || faults.length > 0) return faults.length > 0 ? null : (cut as unknown as Cut);

  // The chosen cut is the one that lands; the rest of the checks are about it.
  if (cut.state === 'inadmissible') faults.push(`${where} is the chosen cut but is inadmissible`);
  const higher = SEAMS.slice(0, SEAMS.indexOf(seam));
  const rungs = (cut.higherRungs as Array<{ seam?: unknown; why?: unknown }>) ?? [];
  for (const rung of higher) {
    const entry = rungs.find((r) => r.seam === rung);
    if (!entry || !nonEmpty(entry.why)) faults.push(`${where} is cut on ${seam} but does not say why ${rung} did not apply`);
  }
  const pieces = (cut.pieces as unknown[]) ?? [];
  const n = pieces.length;
  const parsed: Piece[] = [];
  pieces.forEach((raw, i) => {
    const p = `${where}.pieces[${i}]`;
    if (!isObject(raw)) {
      faults.push(`${p} is not an object`);
      return;
    }
    if (!['author', 'child', 'reference'].includes(raw.kind as string)) faults.push(`${p}.kind must be author, child, or reference`);
    if (!['work', 'spike'].includes(raw.role as string)) faults.push(`${p}.role must be work or spike`);
    if (raw.kind === 'author') {
      if (!nonEmpty(raw.title)) faults.push(`${p}.title is required for an authored piece`);
      if (!nonEmpty(raw.body)) faults.push(`${p}.body is required for an authored piece`);
      else {
        const missing = headingsPresent(raw.body as string);
        if (missing.length > 0) faults.push(`${p}.body lacks the heading(s) ${missing.join(', ')}`);
      }
      const points = raw.points;
      if (!Number.isInteger(points) || !options.scale.includes(points as number)) faults.push(`${p}.points must be on the scale ${options.scale.join(', ')}`);
      else if ((points as number) > options.ceiling) faults.push(`${p}.points ${points} is over the ceiling ${options.ceiling}`);
    } else {
      if (!Number.isInteger(raw.number) || (raw.number as number) <= 0) faults.push(`${p}.number is required for a ${String(raw.kind)}`);
      const inTree = options.tree.children.some((c) => c.number === raw.number);
      if (raw.kind === 'child' && !inTree) faults.push(`${p} adopts #${String(raw.number)}, which is not a child of #${options.tree.issue.number}`);
      if (raw.kind === 'reference' && inTree) faults.push(`${p} references #${String(raw.number)}, which is already a child; use kind child`);
      if (raw.kind === 'reference' && raw.number === options.tree.issue.number) faults.push(`${p} references the trunk itself`);
      if (raw.points !== null && raw.points !== undefined && !Number.isInteger(raw.points)) faults.push(`${p}.points must be null or an integer`);
    }
    if (!Array.isArray(raw.criteria) || !(raw.criteria as unknown[]).every((c) => typeof c === 'string' && options.criteriaIds.has(c))) faults.push(`${p}.criteria must list criterion ids from the inventory`);
    if (!isIndexArray(raw.dependsOn, n) || (raw.dependsOn as number[]).includes(i)) faults.push(`${p}.dependsOn must be piece indexes other than its own`);
    if (!Number.isInteger(raw.order)) faults.push(`${p}.order must be an integer`);
    if (!ORDER_RUNGS.includes(raw.orderRung as OrderRung)) faults.push(`${p}.orderRung must be one of ${ORDER_RUNGS.join(', ')}`);
    parsed.push(raw as unknown as Piece);
  });
  if (parsed.length !== n) return null;

  const spikes = parsed.filter((p) => p.role === 'spike');
  const oneAdopted = n === 1 && parsed[0].kind === 'child';
  const oneSpike = n === 1 && cut.state === 'partial' && parsed[0].role === 'spike';
  if (n < 2 && !oneAdopted && !oneSpike) faults.push(`${where} has ${n} piece(s); a cut needs at least 2 (or one spike in a partial cut, or one adopted child)`);
  if (n > options.maxChildren) faults.push(`${where} has ${n} pieces; maxChildren is ${options.maxChildren}`);
  if (cut.state === 'partial' && spikes.length === 0) faults.push(`${where} is partial but has no spike`);
  if (cut.relation === 'waiting' && spikes.length === 0) faults.push(`${where} is waiting but has no spike`);
  if (cyclic(parsed)) faults.push(`${where}.pieces depend on each other in a cycle`);
  const orders = parsed.map((p) => p.order).sort((a, b) => a - b);
  if (!orders.every((o, i) => o === i + 1)) faults.push(`${where} orders must be a permutation of 1..${n}`);
  parsed.forEach((p, i) => {
    for (const d of p.dependsOn) if (parsed[d] && parsed[d].order >= p.order) faults.push(`${where}.pieces[${i}] depends on piece ${d} but is ordered before or with it`);
  });
  const owners = new Map<string, number[]>();
  parsed.forEach((p, i) => {
    for (const c of p.criteria) owners.set(c, [...(owners.get(c) ?? []), i]);
  });
  for (const [c, who] of owners) if (who.length > 1) faults.push(`criterion ${c} is owned by pieces ${who.join(', ')}; one owner each`);
  const deferred = (cut.deferred as Array<{ criterion?: unknown; waitsOn?: unknown }>) ?? [];
  for (const d of deferred) {
    if (typeof d.criterion !== 'string' || !options.criteriaIds.has(d.criterion)) faults.push(`${where}.deferred names an unknown criterion ${String(d.criterion)}`);
    if (!Number.isInteger(d.waitsOn) || !parsed[d.waitsOn as number] || parsed[d.waitsOn as number].role !== 'spike') faults.push(`${where}.deferred.waitsOn must be a spike piece`);
  }
  const groundwork = (cut.groundwork as Array<{ what?: unknown; owner?: unknown }>) ?? [];
  for (const g of groundwork) {
    if (!nonEmpty(g.what)) faults.push(`${where}.groundwork item without a name`);
    if (!Number.isInteger(g.owner) || !parsed[g.owner as number]) faults.push(`${where}.groundwork '${String(g.what)}' has no owning piece`);
  }
  if (oneAdopted) {
    const owned = new Set(parsed[0].criteria);
    for (const id of options.criteriaIds) if (!owned.has(id) && !deferred.some((d) => d.criterion === id)) faults.push(`the single adopted child must own every criterion; ${id} is unowned`);
  }
  const authored = parsed.filter((p) => p.kind === 'author').length;
  const attached = parsed.filter((p) => p.kind === 'reference').length;
  const total = (options.tree.issue.subIssuesSummary?.total ?? options.tree.children.length) + authored + attached;
  if (total > 100) faults.push(`the trunk would have ${total} sub-issues; GitHub allows 100`);
  return faults.length > 0 ? null : (cut as unknown as Cut);
}

/**
 * Validates the carver's whole answer against the mode, the knobs, the tree, and the scale.
 * Everything mechanical is checked here; the confirmer judges meaning.
 */
export function validateCarving(
  raw: unknown,
  options: { mode: 'carve' | 'revisit'; knobs: Pick<CarveKnobs, 'ceiling' | 'maxChildren'>; tree: Tree; scale: number[] },
): { ok: true; carving: Carving } | { ok: false; faults: string[] } {
  const faults: string[] = [];
  if (!isObject(raw)) return { ok: false, faults: ['not an object'] };
  if (raw.issue !== options.tree.issue.number) faults.push(`names issue ${JSON.stringify(raw.issue)}, not #${options.tree.issue.number}`);
  if (raw.mode !== options.mode) faults.push(`mode is ${JSON.stringify(raw.mode)}; this is a ${options.mode}`);
  const verdicts: string[] = options.mode === 'carve' ? CARVE_VERDICTS : REVISIT_VERDICTS;
  const verdict = raw.verdict as string;
  if (!verdicts.includes(verdict)) faults.push(`verdict ${JSON.stringify(raw.verdict)} is not one of ${verdicts.join(', ')} in ${options.mode} mode`);
  if (!nonEmpty(raw.reason)) faults.push('no reason');

  const criteriaIds = new Set<string>();
  if (!Array.isArray(raw.criteria)) faults.push('criteria must be an array');
  else {
    (raw.criteria as Array<{ id?: unknown; text?: unknown }>).forEach((c, i) => {
      if (!isObject(c) || !nonEmpty(c.id) || !nonEmpty(c.text)) faults.push(`criteria[${i}] needs id and text`);
      else if (criteriaIds.has(c.id)) faults.push(`criterion id ${c.id} appears twice`);
      else criteriaIds.add(c.id);
    });
  }
  const STATUSES = ['open', 'completed', 'deferred', 'withdrawn', 'orphaned'];
  if (!Array.isArray(raw.ledger)) faults.push('ledger must be an array');
  else {
    const seen = new Set<string>();
    for (const row of raw.ledger as Array<{ id?: unknown; status?: unknown; owner?: unknown; cite?: unknown; waitsOn?: unknown }>) {
      if (!isObject(row) || !nonEmpty(row.id) || !criteriaIds.has(row.id)) {
        faults.push(`ledger row for an unknown criterion ${JSON.stringify(row?.id)}`);
        continue;
      }
      if (seen.has(row.id)) faults.push(`ledger names ${row.id} twice`);
      seen.add(row.id);
      if (!STATUSES.includes(row.status as string)) faults.push(`ledger ${row.id} has status ${JSON.stringify(row.status)}`);
      if (row.owner !== null && row.owner !== undefined && !Number.isInteger(row.owner)) faults.push(`ledger ${row.id} owner must be a piece index or null`);
      if (row.status === 'withdrawn' && !nonEmpty(row.cite)) faults.push(`ledger ${row.id} is withdrawn without citing a comment`);
      if (row.status === 'deferred' && !Number.isInteger(row.waitsOn)) faults.push(`ledger ${row.id} is deferred without a spike to wait on`);
    }
    for (const id of criteriaIds) if (!seen.has(id)) faults.push(`ledger has no row for ${id}`);
  }

  const withCut = verdict === 'carve' || verdict === 'amend';
  const isHandOff = verdict in HAND_OFFS;
  if (withCut) {
    if (!Array.isArray(raw.cuts) || (raw.cuts as unknown[]).length === 0) faults.push('a carve or amend needs cuts');
    else {
      const cuts = raw.cuts as unknown[];
      if (!Number.isInteger(raw.chosen) || !cuts[raw.chosen as number]) faults.push('chosen must index a cut');
      cuts.forEach((cut, i) =>
        validateCut(cut, faults, `cuts[${i}]`, {
          ceiling: options.knobs.ceiling,
          scale: options.scale,
          maxChildren: options.knobs.maxChildren,
          tree: options.tree,
          criteriaIds,
          chosen: i === raw.chosen,
        }),
      );
      const chosen = cuts[raw.chosen as number] as { pieces?: Array<{ criteria?: string[]; role?: string }>; deferred?: Array<{ criterion: string }> } | undefined;
      if (chosen && Array.isArray(chosen.pieces) && Array.isArray(raw.ledger)) {
        // The ledger and the chosen cut must tell one story about owners.
        const ownerOf = new Map<string, number>();
        chosen.pieces.forEach((p, i) => {
          for (const c of p.criteria ?? []) ownerOf.set(c, i);
        });
        for (const row of raw.ledger as Array<{ id: string; owner: number | null; status: string }>) {
          const owner = ownerOf.get(row.id);
          if (row.status === 'withdrawn' || row.status === 'deferred') continue;
          if (owner === undefined) faults.push(`criterion ${row.id} is owned by no piece of the chosen cut`);
          else if (row.owner !== owner) faults.push(`ledger says ${row.id} is owned by piece ${String(row.owner)}; the cut says piece ${owner}`);
        }
      }
    }
    if (raw.supersedes !== undefined) {
      if (!Array.isArray(raw.supersedes)) faults.push('supersedes must be an array');
      else {
        const previous = new Set((options.tree.record?.children ?? []).map((c) => c.number));
        for (const s of raw.supersedes as Array<{ old?: unknown; replacements?: unknown; reason?: unknown }>) {
          if (!Number.isInteger(s.old) || !previous.has(s.old as number)) faults.push(`supersedes #${String(s.old)}, which is not a child of the latest record`);
          if (!Array.isArray(s.replacements)) faults.push(`supersedes #${String(s.old)} without replacements`);
          if (!nonEmpty(s.reason)) faults.push(`supersedes #${String(s.old)} without a reason`);
        }
      }
    }
  } else if (raw.cuts !== undefined && (raw.cuts as unknown[]).length > 0) {
    faults.push(`a ${verdict} carries no cuts`);
  }
  if (isHandOff) {
    if (!Array.isArray(raw.affected) || !(raw.affected as unknown[]).every((a) => typeof a === 'string' && criteriaIds.has(a))) faults.push('a hand-off needs affected: the criterion ids the question touches (may be empty)');
  }
  if (faults.length > 0) return { ok: false, faults };
  return { ok: true, carving: raw as unknown as Carving };
}

// ---------------------------------------------------------------------------
// The confirmer's answer
// ---------------------------------------------------------------------------

const FINDINGS_BY_MODE: { [mode: string]: Finding[] } = {
  carve: ['cover', 'gap', 'overreach', 'partition-intact', 'partition-broken', 'hand-off-agree', 'hand-off-disagree'],
  revisit: ['cover', 'gap', 'overreach', 'partition-intact', 'partition-broken', 'still-good', 'not-still-good', 'exhausted', 'not-exhausted', 'hand-off-agree', 'hand-off-disagree'],
};

export function validateConfirmation(raw: unknown, mode: 'carve' | 'revisit'): { ok: true; confirmation: Confirmation } | { ok: false; faults: string[] } {
  const faults: string[] = [];
  if (!isObject(raw)) return { ok: false, faults: ['not an object'] };
  if (!Number.isInteger(raw.issue)) faults.push('no issue number');
  if (raw.mode !== mode) faults.push(`mode is ${JSON.stringify(raw.mode)}; this is a ${mode}`);
  if (typeof raw.agree !== 'boolean') faults.push('agree must be true or false');
  const finding = raw.finding as Finding;
  if (!FINDINGS_BY_MODE[mode].includes(finding)) faults.push(`finding ${JSON.stringify(raw.finding)} is not one of ${FINDINGS_BY_MODE[mode].join(', ')} in ${mode} mode`);
  if (raw.seam !== 'agree' && raw.seam !== 'higher-available') faults.push('seam must be agree or higher-available');
  if (typeof raw.seamCase !== 'string') faults.push('seamCase must be a string');
  if (raw.seam === 'higher-available' && !nonEmpty(raw.seamCase)) faults.push('a seam dispute needs its case in seamCase');
  if (!nonEmpty(raw.reason)) faults.push('no reason');
  if (raw.agree === true && (!AGREEING.includes(finding) || raw.seam !== 'agree')) faults.push(`agree is true but the finding is ${String(raw.finding)} with seam ${String(raw.seam)}`);
  if (raw.agree === false && AGREEING.includes(finding) && raw.seam === 'agree') faults.push(`agree is false but the finding ${finding} agrees`);
  if (faults.length > 0) return { ok: false, faults };
  return { ok: true, confirmation: raw as unknown as Confirmation };
}

// ---------------------------------------------------------------------------
// Normalization: matching pieces against what the tracker already holds
// ---------------------------------------------------------------------------

export type PiecePlan =
  | { index: number; piece: Piece; action: 'author' }
  | { index: number; piece: Piece; action: 'adopt'; number: number; closed: boolean }
  | { index: number; piece: Piece; action: 'attach'; number: number }
  | { index: number; piece: Piece; action: 'edge'; number: number }
  | { index: number; piece: Piece; action: 'complete'; number: number };

/**
 * Turns the chosen cut's pieces into tracker actions. An adopted child is what it is; a reference
 * outside the tree is attached when it has no parent, depended on when it has one, recorded as
 * completed when it is closed COMPLETED, and refused when it is closed NOT_PLANNED, deleted, or
 * would close a blocked-by cycle. Refusals are faults the carver must answer on its next round.
 */
export function normalize(cut: Cut, tree: Tree, io: TrackerIo): { ok: true; plan: PiecePlan[] } | { ok: false; faults: string[] } {
  const faults: string[] = [];
  const plan: PiecePlan[] = [];
  cut.pieces.forEach((piece, index) => {
    if (piece.kind === 'author') {
      plan.push({ index, piece, action: 'author' });
      return;
    }
    const number = piece.number as number;
    const node = io.view(number);
    if (!node || node.state === 'DELETED') {
      faults.push(`piece ${index} names #${number}, which does not exist`);
      return;
    }
    if (piece.kind === 'child') {
      plan.push({ index, piece, action: 'adopt', number, closed: node.state === 'CLOSED' });
      return;
    }
    if (node.state === 'CLOSED') {
      if (node.stateReason === 'COMPLETED') plan.push({ index, piece, action: 'complete', number });
      else faults.push(`piece ${index} references #${number}, which is closed not planned; author the piece instead`);
      return;
    }
    // A reference that transitively blocks on the trunk would make the trunk wait on itself.
    if (blocksOn(number, tree.issue.number, io)) {
      faults.push(`piece ${index} references #${number}, which is blocked by #${tree.issue.number}; author the piece instead`);
      return;
    }
    if (node.parent) plan.push({ index, piece, action: 'edge', number });
    else plan.push({ index, piece, action: 'attach', number });
  });
  return faults.length > 0 ? { ok: false, faults } : { ok: true, plan };
}

/** True when `from` is blocked, transitively, by `target`. */
function blocksOn(from: number, target: number, io: TrackerIo): boolean {
  const seen = new Set<number>();
  const queue = [from];
  while (queue.length > 0) {
    const n = queue.shift() as number;
    if (seen.has(n)) continue;
    seen.add(n);
    const node = io.view(n);
    for (const b of node?.blockedBy?.nodes ?? []) {
      if (b.number === target) return true;
      queue.push(b.number);
    }
  }
  return false;
}

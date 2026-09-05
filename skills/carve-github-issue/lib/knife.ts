/**
 * The knife's state machine: one issue in, one outcome out. Claim; finish whatever a crash left
 * announced but unfinished; repair what the tracker's labels and records say should hold; then
 * decide the mode from the newest record (none or released: carve; live: revisit), run the carver
 * and the confirmer for at most `maxCarveRounds`, and apply the confirmed verdict to the tracker
 * in the order `references/lifecycle.md` gives, announcing each multi-write transition first.
 *
 * Every write goes through the journal, which remembers what this machine already saw done, and
 * through the tracker io, so a dry run logs and a test asserts. Every write checks its target
 * immediately before it lands, so a finisher on another machine and a person acting mid-flight
 * are both accounted for.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logTail, readResult, renderPrompt, runAgent } from '../../fix-github-issue/lib/agent.ts';
import { CARVING_FILE, CONFIRMATION_FILE } from '../../fix-github-issue/lib/control-files.ts';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import { assertDistinctEngines } from '../../fix-github-issue/lib/engines.ts';
import { carveCount, clearCarves, closeIssue, HOLD_LABELS, recordCarve } from '../../fix-github-issue/lib/labels.ts';
import { claimLock } from '../../fix-github-issue/lib/lane.ts';
import type { Issue } from '../../fix-github-issue/lib/pipeline.ts';
import { runCarveCallback } from './callbacks.ts';
import {
  type Carving,
  type CarveKnobs,
  type CarveOutcome,
  type Confirmation,
  HAND_OFFS,
  type Journal,
  type JournalStep,
  normalize,
  type PiecePlan,
  validateCarving,
  validateConfirmation,
} from './carve.ts';
import { claim, keepClaimed, trackerIo } from './claims.ts';
import { buildLedger, carryIds, childMarker, type Ledger, pauseSet, type Record, type RecordChild, renderChildBody, renderRecord, sameBody } from './record.ts';
import { descendants, type Fingerprint, fingerprint, type Intent, parseMarker, pointsOf, readTree, type TrackerIo, type Tree } from './tree.ts';

const SEAMS_PATH = join(import.meta.dir, '..', 'references', 'seams.md');

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

class JournalFile {
  readonly journal: Journal;
  constructor(
    private readonly ctx: Context,
    private readonly knobs: CarveKnobs,
    issue: number,
    generation: number,
    private readonly path: string | null,
  ) {
    const existing = path && existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Journal) : null;
    this.journal = existing && existing.generation === generation ? existing : { issue, generation, status: 'open', steps: [] };
  }
  done(name: JournalStep, target?: number): void {
    this.journal.steps.push({ name, target, status: 'done' });
    this.flush();
    if (this.knobs.failAfter === name) {
      this.ctx.log(`  --fail-after ${name}: exiting hard, bypassing finally on purpose`);
      process.exit(70);
    }
  }
  abandoned(name: JournalStep, why: string, target?: number): void {
    this.journal.steps.push({ name, target, status: 'abandoned', why });
    this.flush();
  }
  finish(): void {
    this.journal.status = 'done';
    this.flush();
  }
  /** True when a step of this name and target was already seen done by this machine. */
  saw(name: JournalStep, target?: number): boolean {
    return this.journal.steps.some((s) => s.name === name && s.status === 'done' && (target === undefined || s.target === target));
  }
  private flush(): void {
    if (!this.path) return;
    mkdirSync(join(this.path, '..'), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.journal, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Tracker writes, journaled
// ---------------------------------------------------------------------------

type Knife = {
  ctx: Context;
  io: TrackerIo;
  knobs: CarveKnobs;
  trunk: number;
  say: (m: string) => void;
  journal: JournalFile;
};

function write(k: Knife, step: JournalStep, description: string, argv: string[], target?: number): void {
  if (k.ctx.dryRun) {
    k.ctx.dryRunLog.push(description);
    k.say(`DRY RUN  ${description}`);
  } else {
    k.say(description);
    k.io.write({ description, argv });
  }
  k.journal.done(step, target);
}

function create(k: Knife, description: string, argv: string[], index: number): number {
  if (k.ctx.dryRun) {
    k.ctx.dryRunLog.push(description);
    k.say(`DRY RUN  ${description}`);
    k.journal.done('create', -(index + 1));
    return -(index + 1);
  }
  k.say(description);
  const number = k.io.create({ description, argv });
  k.journal.done('create', number);
  return number;
}

function labelsOf(node: { labels: Array<{ name: string }> }): string[] {
  return node.labels.map((l) => l.name);
}

function addLabel(k: Knife, step: JournalStep, issue: number, label: string, current: string[]): void {
  if (current.includes(label)) return;
  write(k, step, `label #${issue} ${label}`, ['gh', 'issue', 'edit', String(issue), '--add-label', label], issue);
}

function removeLabel(k: Knife, step: JournalStep, issue: number, label: string, current: string[]): void {
  if (!current.includes(label)) return;
  write(k, step, `unlabel #${issue} ${label}`, ['gh', 'issue', 'edit', String(issue), '--remove-label', label], issue);
}

function comment(k: Knife, step: JournalStep, issue: number, body: string, description: string): void {
  write(k, step, description, ['gh', 'issue', 'comment', String(issue), '--body', body], issue);
}

function postRecord(k: Knife, record: Record): void {
  const step: JournalStep = record.state === 'applying' ? 'applying-record' : record.state === 'released' ? 'released-record' : 'live-record';
  comment(k, step, k.trunk, renderRecord(record), `post the ${record.state} record (generation ${record.generation}) on #${k.trunk}`);
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function newRecord(k: Knife, tree: Tree, partial: Partial<Record> & Pick<Record, 'state' | 'verdict' | 'reason' | 'ledger'>): Record {
  const previous = tree.record;
  return {
    generation: tree.generation,
    epoch: tree.epoch,
    cut: previous?.cut ?? null,
    children: previous?.children ?? [],
    supersedes: [],
    affected: [],
    revisits: previous?.revisits ?? 0,
    seen: fingerprint(tree, k.ctx.botLogin),
    at: new Date().toISOString(),
    ...partial,
  };
}

function childrenFromCut(carving: Carving, plan: PiecePlan[], previous: Record | null): RecordChild[] {
  const cut = carving.cuts?.[carving.chosen ?? 0];
  if (!cut) return [];
  return cut.pieces.map((piece, index) => {
    const entry = plan.find((p) => p.index === index);
    const number = entry && 'number' in entry ? entry.number : null;
    const prior = previous?.children.find((c) => c.number !== null && c.number === number);
    return {
      number,
      piece: index,
      kind: piece.kind,
      link: entry?.action === 'edge' ? 'blocker' : 'sub-issue',
      points: piece.points,
      order: piece.order,
      orderRung: piece.orderRung,
      dependsOn: piece.dependsOn,
      status: entry?.action === 'complete' ? 'closed-completed' : entry?.action === 'adopt' && entry.closed ? 'closed-completed' : (prior?.status ?? 'open'),
      paused: false,
      role: piece.role,
      title: piece.title ?? k_title(number, previous),
    };
  });
}

function k_title(number: number | null, previous: Record | null): string {
  return previous?.children.find((c) => c.number === number)?.title ?? (number === null ? '' : `#${number}`);
}

// ---------------------------------------------------------------------------
// Pauses
// ---------------------------------------------------------------------------

/** Every issue the record commands paused: each paused child and everything under it. */
function commandedPauses(record: Record, io: TrackerIo): Set<number> {
  const out = new Set<number>();
  for (const child of record.children) {
    if (!child.paused || child.number === null || child.link !== 'sub-issue') continue;
    out.add(child.number);
    for (const d of descendants(child.number, io)) out.add(d);
  }
  return out;
}

function unreleasedPauseMarkers(node: { comments: Array<{ author: string; body: string }> }, botLogin: string): Map<number, boolean> {
  const byTrunk = new Map<number, boolean>();
  for (const c of node.comments) {
    if (c.author !== botLogin) continue;
    const m = parseMarker(c.body);
    if (!m) continue;
    if (m.name === 'carve-pause') byTrunk.set(Number(m.fields.by), true);
    if (m.name === 'carve-unpause') byTrunk.set(Number(m.fields.by), false);
  }
  return byTrunk;
}

/**
 * Makes the markers and `loop/paused` on this trunk's descendants match the record: a marker
 * naming this trunk on each commanded issue and the label on; the marker released and the label
 * off where no other trunk's unreleased marker remains; a `loop/paused` with no marker at all
 * removed as torn. Never touches another trunk's marker.
 */
export function reconcilePauses(k: Knife, record: Record): void {
  const commanded = commandedPauses(record, k.io);
  const candidates = new Set<number>([...commanded, ...descendants(k.trunk, k.io)]);
  for (const n of candidates) {
    const node = k.io.view(n);
    if (!node || node.state !== 'OPEN') continue;
    const markers = unreleasedPauseMarkers(node, k.ctx.botLogin);
    const mine = markers.get(k.trunk) === true;
    const labels = labelsOf(node);
    if (commanded.has(n)) {
      if (!mine) comment(k, 'pause', n, `<!-- carve-pause by=${k.trunk} gen=${record.generation} -->\nPaused by #${k.trunk} while a question about it is open.`, `pause #${n} for #${k.trunk}`);
      addLabel(k, 'pause', n, 'loop/paused', labels);
      continue;
    }
    if (mine) comment(k, 'unpause', n, `<!-- carve-unpause by=${k.trunk} -->\nThe question on #${k.trunk} is settled; this may proceed.`, `unpause #${n} for #${k.trunk}`);
    const others = [...markers.entries()].some(([trunk, live]) => live && trunk !== k.trunk);
    if (!others) removeLabel(k, 'unpause', n, 'loop/paused', labels);
  }
}

// ---------------------------------------------------------------------------
// Applying a generation: idempotent from an applying record
// ---------------------------------------------------------------------------

/** An existing child that is the pending piece, by marker, author, parent, title, and body; or a stop. */
function existingChild(k: Knife, tree: Tree, record: Record, index: number): { number: number } | { stop: string } | null {
  const marker = childMarker(k.trunk, record.generation, index);
  const child = record.children[index];
  const piece = record.cut?.pieces[index];
  for (const c of tree.children) {
    if (!c.body.includes(marker)) continue;
    const okAuthor = c.author === k.ctx.botLogin;
    const okTitle = piece ? c.title === (piece.title ?? child.title) : true;
    const okBody = piece ? sameBody(c.body, renderChildBody(k.trunk, record.generation, index, piece)) : true;
    if (okAuthor && okTitle && okBody) return { number: c.number };
    return { stop: `#${c.number} carries the marker for generation ${record.generation} piece ${index} but is not the knife's work (author ${c.author}${okTitle ? '' : ', title differs'}${okBody ? '' : ', body differs'})` };
  }
  return null;
}

/**
 * Finishes an `applying` record: creates, adopts, attaches, edges, supersedes, pauses, runs the
 * callback, writes the labels, clears the counter, and posts the `live` record, in that order,
 * skipping every write whose effect is already on the tracker and abandoning any whose
 * precondition a person has since undone.
 */
export async function applyRecord(k: Knife, applying: Record): Promise<{ ok: true; live: Record } | { ok: false; why: string }> {
  let tree = readTree(k.ctx, k.trunk, k.io);
  const children = applying.children.map((c) => ({ ...c }));
  const cut = applying.cut;
  if (!cut) return { ok: false, why: 'an applying record with no cut' };
  const previous = tree.record && tree.record.state === 'live' && tree.record.generation < applying.generation ? tree.record : null;

  // Pieces, in delivery order.
  const order = [...children].sort((a, b) => a.order - b.order);
  for (const child of order) {
    const piece = cut.pieces[child.piece];
    if (child.kind === 'author') {
      if (child.number !== null && child.number > 0) continue;
      const found = existingChild(k, tree, applying, child.piece);
      if (found && 'stop' in found) return { ok: false, why: found.stop };
      if (found) {
        child.number = found.number;
        continue;
      }
      const argv = ['gh', 'issue', 'create', '--title', piece.title ?? '', '--body', renderChildBody(k.trunk, applying.generation, child.piece, piece), '--parent', String(k.trunk)];
      if (piece.role === 'spike') argv.push('--label', 'spike');
      child.number = create(k, `create child "${piece.title}" of #${k.trunk}`, argv, child.piece);
      tree = readTree(k.ctx, k.trunk, k.io);
      continue;
    }
    if (child.number === null) continue;
    if (child.kind === 'child') {
      k.journal.done('adopt', child.number);
      continue;
    }
    // A reference: attach when it still has no parent, depend on it otherwise.
    const node = k.io.view(child.number);
    if (!node || node.state === 'DELETED') {
      k.journal.abandoned('reference', `#${child.number} no longer exists`, child.number);
      child.status = 'deleted';
      continue;
    }
    if (node.state === 'CLOSED') {
      child.status = node.stateReason === 'NOT_PLANNED' ? 'closed-not-planned' : 'closed-completed';
      k.journal.done('reference', child.number);
      continue;
    }
    if (node.parent?.number === k.trunk) {
      child.link = 'sub-issue';
      k.journal.done('reference', child.number);
      continue;
    }
    if (node.parent) {
      child.link = 'blocker';
      const already = (tree.issue.blockedBy?.nodes ?? []).some((b) => b.number === child.number);
      if (!already) write(k, 'reference', `depend #${k.trunk} on #${child.number}`, ['gh', 'issue', 'edit', String(k.trunk), '--add-blocked-by', String(child.number)], child.number);
      else k.journal.done('reference', child.number);
      continue;
    }
    child.link = 'sub-issue';
    write(k, 'reference', `attach #${child.number} under #${k.trunk}`, ['gh', 'issue', 'edit', String(child.number), '--parent', String(k.trunk)], child.number);
    tree = readTree(k.ctx, k.trunk, k.io);
  }

  // Edges among the children: add what the cut says, remove what the previous record said and this one does not.
  const numberOf = (piece: number): number | null => children.find((c) => c.piece === piece)?.number ?? null;
  const wanted = new Set<string>();
  for (const child of children) {
    if (child.number === null || child.link !== 'sub-issue') continue;
    for (const dep of child.dependsOn) {
      const target = numberOf(dep);
      if (target === null || target === child.number) continue;
      wanted.add(`${child.number}<${target}`);
      const node = k.io.view(child.number);
      const has = (node?.blockedBy?.nodes ?? []).some((b) => b.number === target);
      if (!has) write(k, 'edge', `block #${child.number} on #${target}`, ['gh', 'issue', 'edit', String(child.number), '--add-blocked-by', String(target)], child.number);
    }
  }
  if (previous) {
    const prevNumber = (piece: number) => previous.children.find((c) => c.piece === piece)?.number ?? null;
    for (const old of previous.children) {
      if (old.number === null) continue;
      for (const dep of old.dependsOn) {
        const target = prevNumber(dep);
        if (target === null || wanted.has(`${old.number}<${target}`)) continue;
        const node = k.io.view(old.number);
        if (!node || node.state !== 'OPEN') continue;
        if ((node.blockedBy?.nodes ?? []).some((b) => b.number === target)) {
          write(k, 'unedge', `unblock #${old.number} from #${target}`, ['gh', 'issue', 'edit', String(old.number), '--remove-blocked-by', String(target)], old.number);
        }
      }
    }
  }

  // Supersessions: a child with no work started closes not planned with a pointer; one with work
  // started, or one a person reopened after this knife closed it, is left as it is.
  for (const s of applying.supersedes) {
    const node = k.io.view(s.old);
    if (!node) continue;
    const replacements = s.replacements.map((r) => numberOf(r)).filter((n): n is number => n !== null && n > 0);
    if (node.state !== 'OPEN') {
      k.journal.done('supersede', s.old);
      continue;
    }
    const closedByUs = node.comments.some((c) => c.author === k.ctx.botLogin && c.body.startsWith('<!-- loop-close') && c.body.includes('by=knife'));
    if (closedByUs) {
      k.journal.abandoned('supersede', `#${s.old} was reopened by a person after the knife closed it`, s.old);
      continue;
    }
    if (workStarted(node)) {
      k.journal.abandoned('supersede', `#${s.old} has work started; kept`, s.old);
      continue;
    }
    if (k.ctx.dryRun) {
      k.ctx.dryRunLog.push(`close #${s.old} as superseded`);
      k.journal.done('supersede', s.old);
      continue;
    }
    await closeIssue(k.ctx, s.old, `Superseded by ${replacements.map((n) => `#${n}`).join(', ') || 'the new carving'}: ${s.reason}`, { kind: 'closed', reason: `superseded by #${replacements[0] ?? k.trunk}`, by: 'knife' });
    k.journal.done('supersede', s.old);
  }

  // Pauses to match this record (a carve or amend commands none), then the callback, then labels.
  reconcilePauses(k, { ...applying, children });
  if (!k.journal.saw('callback')) {
    await callback(k, tree, 'on-carve-pass', applying, children);
  }
  tree = readTree(k.ctx, k.trunk, k.io);
  const labels = labelsOf(tree.issue);
  addLabel(k, 'gen-label', k.trunk, `loop/carve-gen: ${applying.generation}`, labels);
  for (const old of labels.filter((l) => l.startsWith('loop/carve-gen:') && l !== `loop/carve-gen: ${applying.generation}`)) {
    removeLabel(k, 'gen-label', k.trunk, old, labels);
  }
  addLabel(k, 'carved-label', k.trunk, 'loop/carved', labels);
  removeLabel(k, 'carved-label', k.trunk, 'loop/handed-off', labels);
  if (!k.ctx.dryRun && carveCount(tree.issue.labels) > 0) clearCarves(k.ctx, k.trunk);
  k.journal.done('counters');

  tree = readTree(k.ctx, k.trunk, k.io);
  const live: Record = { ...applying, state: 'live', children, revisits: 0, seen: fingerprint(tree, k.ctx.botLogin), at: new Date().toISOString() };
  postRecord(k, live);
  k.journal.finish();
  return { ok: true, live };
}

/** Any of: a live working claim, an open pull request, an assignee, a park, a dead-letter, a review count. */
function workStarted(node: { labels: Array<{ name: string }>; comments: Array<{ author: string; body: string }> }): boolean {
  const labels = labelsOf(node);
  if (labels.some((l) => l === 'loop/working' || l === 'loop/parked' || l === 'loop/dlq' || /^loop\/reviews:\s*[1-9]/.test(l))) return true;
  return false;
}

async function callback(k: Knife, tree: Tree, name: 'on-carve-pass' | 'on-carve-fail', record: Record, children: RecordChild[]): Promise<void> {
  const cut = record.cut;
  const payload = {
    key: { issue: k.trunk, generation: record.generation, epoch: record.epoch, revisits: record.revisits, verdict: record.verdict },
    issue: k.trunk,
    title: tree.issue.title,
    mode: (record.verdict === 'carve' || (record.generation <= 1 && record.state !== 'live') ? 'carve' : 'revisit') as 'carve' | 'revisit',
    verdict: record.verdict,
    generation: record.generation,
    seam: cut?.seam ?? null,
    relation: cut?.relation ?? null,
    children: children.map((c) => c.number).filter((n): n is number => n !== null && n > 0),
    superseded: record.supersedes.map((s) => s.old),
    paused: [...commandedPauses({ ...record, children }, k.io)],
    reason: record.reason,
    repo: k.ctx.project.repo,
    baseBranch: k.ctx.project.baseBranch,
    repoRoot: k.ctx.repoRoot,
  };
  if (k.ctx.dryRun) {
    k.ctx.dryRunLog.push(`callback ${name}`);
    k.say(`DRY RUN  would run ${name}`);
  } else {
    const result = await runCarveCallback(k.knobs.callbacksDir, name, payload, k.say);
    if (result.found.length === 0) k.say(`no ${name} callback in ${k.knobs.callbacksDir}`);
  }
  k.journal.done('callback');
}

// ---------------------------------------------------------------------------
// Hand-offs, still-good, release
// ---------------------------------------------------------------------------

async function applyHandOff(k: Knife, tree: Tree, carving: Carving, opinions: Array<{ carver: string; confirmer: string }>, pauseAll: boolean, verdict: string): Promise<CarveOutcome> {
  const hold = HAND_OFFS[verdict] ?? 'needs-human';
  const ledger = carving.ledger;
  const previous = tree.record;
  const children: RecordChild[] = (previous?.children ?? []).map((c) => ({ ...c, paused: false }));
  // A trunk with no record yet still has children to command (a re-carve of a released trunk, a
  // dispute before any carve); they enter the record as adopted children so the pause is recorded.
  for (const c of tree.children) {
    if (children.some((r) => r.number === c.number)) continue;
    children.push({ number: c.number, piece: children.length, kind: 'child', link: 'sub-issue', points: pointsOf(c.labels), order: children.length + 1, orderRung: 'size', dependsOn: [], status: c.state === 'CLOSED' ? (c.stateReason === 'NOT_PLANNED' ? 'closed-not-planned' : 'closed-completed') : 'open', paused: false, role: 'work', title: c.title });
  }
  const affected = carving.affected ?? [];
  const paused = new Set<number>();
  if (pauseAll) {
    for (const c of tree.children) if (c.state === 'OPEN') paused.add(c.number);
  } else if (previous) {
    for (const n of pauseSet({ ...previous, ledger }, affected, (n) => descendants(n, k.io))) paused.add(n);
  }
  for (const c of children) if (c.number !== null && paused.has(c.number)) c.paused = true;

  const marker = `<!-- carve-handoff verdict=${verdict} gen=${tree.generation} -->`;
  const payload = { verdict, reason: carving.reason, affected, pauseSet: [...paused], opinions, logTail: null as string | null };
  const alreadyAnnounced = tree.issue.comments.some((c) => c.author === k.ctx.botLogin && c.body.startsWith(marker) && !tree.intents.find((i) => i.commentId === c.databaseId)?.finished);
  if (!alreadyAnnounced) {
    const body = [marker, '```json', JSON.stringify(payload), '```', `**${verdict}**: ${carving.reason}`, affected.length ? `Affected criteria: ${affected.join(', ')}.` : '', ...opinions.map((o, i) => `\nRound ${i + 1}. Carver: ${o.carver}\nConfirmer: ${o.confirmer}`)].filter(Boolean).join('\n');
    comment(k, 'handoff-comment', k.trunk, body, `hand off #${k.trunk} as ${verdict}`);
  }
  const labels = labelsOf(tree.issue);
  if (tree.generation === 0) addLabel(k, 'handed-off-label', k.trunk, 'loop/handed-off', labels);
  addLabel(k, 'hold-label', k.trunk, hold, labels);
  const record = newRecord(k, tree, { state: 'live', verdict, reason: carving.reason, ledger, children, affected, revisits: previous?.revisits ?? 0 });
  reconcilePauses(k, record);
  await callback(k, tree, 'on-carve-fail', record, children);
  const after = readTree(k.ctx, k.trunk, k.io);
  postRecord(k, { ...record, seen: fingerprint(after, k.ctx.botLogin), at: new Date().toISOString() });
  k.journal.finish();
  return { outcome: verdict as CarveOutcome['outcome'], reason: carving.reason, generation: tree.generation };
}

async function applyStillGood(k: Knife, tree: Tree, carving: Carving, redrive: boolean): Promise<CarveOutcome> {
  const previous = tree.record as Record;
  const children = previous.children.map((c) => ({ ...c, paused: false }));
  const revisits = redrive ? 0 : previous.revisits + 1;
  const epoch = redrive ? previous.epoch + 1 : previous.epoch;
  const record = newRecord(k, tree, { state: 'live', verdict: 'still-good', reason: carving.reason, ledger: carving.ledger, children, revisits, epoch });
  reconcilePauses(k, record);
  await callback(k, tree, 'on-carve-pass', record, children);
  const after = readTree(k.ctx, k.trunk, k.io);
  postRecord(k, { ...record, seen: fingerprint(after, k.ctx.botLogin), at: new Date().toISOString() });
  k.journal.finish();
  return { outcome: 'still-good', reason: carving.reason, generation: tree.generation };
}

/** The release intent: the released record, then the labels off, the counters off, the callback, and `loop/released` on, which completes it. */
async function applyRelease(k: Knife, tree: Tree, carving: Carving | null, released: Record | null): Promise<CarveOutcome> {
  const previous = tree.record as Record;
  const record: Record =
    released ??
    newRecord(k, tree, {
      state: 'released',
      verdict: 'exhausted',
      reason: carving?.reason ?? '',
      ledger: carving?.ledger ?? previous.ledger,
      children: previous.children.map((c) => ({ ...c, paused: false })),
      revisits: previous.revisits,
    });
  if (!released) postRecord(k, record);
  let labels = labelsOf(readTree(k.ctx, k.trunk, k.io).issue);
  for (const size of labels.filter((l) => /^size:/.test(l))) removeLabel(k, 'release-size', k.trunk, size, labels);
  labels = labelsOf(readTree(k.ctx, k.trunk, k.io).issue);
  removeLabel(k, 'release-labels', k.trunk, 'loop/carved', labels);
  for (const gen of labels.filter((l) => l.startsWith('loop/carve-gen:'))) removeLabel(k, 'release-labels', k.trunk, gen, labels);
  if (!k.ctx.dryRun && carveCount(tree.issue.labels) > 0) clearCarves(k.ctx, k.trunk);
  k.journal.done('release-counters');
  reconcilePauses(k, record);
  if (!k.journal.saw('callback')) await callback(k, tree, 'on-carve-pass', record, record.children);
  labels = labelsOf(readTree(k.ctx, k.trunk, k.io).issue);
  addLabel(k, 'release-labels', k.trunk, 'loop/released', labels);
  k.journal.finish();
  return { outcome: 'exhausted', reason: record.reason, generation: record.generation };
}

// ---------------------------------------------------------------------------
// Agent turns
// ---------------------------------------------------------------------------

function describeChildren(tree: Tree): string {
  if (tree.children.length === 0) return '  (none)';
  return tree.children.map((c) => `  - #${c.number} ${c.title} (${c.state.toLowerCase()}${c.stateReason ? `, ${c.stateReason.toLowerCase().replace('_', ' ')}` : ''}${pointsOf(c.labels) !== null ? `, ${pointsOf(c.labels)} points` : ''})`).join('\n');
}

async function runCarver(k: Knife, tree: Tree, mode: 'carve' | 'revisit', ledger: Ledger | null, feedback: string | null, trigger: string): Promise<{ ok: true; carving: Carving } | { ok: false; why: string; logPath: string | null }> {
  const cwd = join(k.ctx.runDir, `carve-${k.trunk}-${process.pid}`);
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  const vars = {
    ISSUE: String(k.trunk),
    TITLE: tree.issue.title,
    POINTS: String(pointsOf(tree.issue.labels) ?? 'unsized'),
    CEILING: String(k.knobs.ceiling),
    SCALE: k.ctx.knobs.pointScale.join(', '),
    MAX_CHILDREN: String(k.knobs.maxChildren),
    DEPTH: String(tree.depth),
    MAX_DEPTH: String(k.knobs.maxDepth),
    GENERATION: String(tree.generation),
    TRIGGER: trigger,
    CHILDREN: describeChildren(tree),
    ANCESTORS: tree.ancestors.length ? `Ancestors: ${tree.ancestors.map((a) => `#${a.number}`).join(', ')}; read each one's newest carving record.` : 'It has no parent.',
    PREVIOUS_LEDGER: ledger ? `The previous ledger, statuses re-derived from the tree:\n\n\`\`\`json\n${JSON.stringify(ledger, null, 2)}\n\`\`\`` : 'There is no previous carving of this issue.',
    FEEDBACK: feedback ? `## The confirmer's case against your last answer\n\nAnswer it in this round, or change your cut.\n\n${feedback}` : '',
    SEAMS_PATH,
    CARVING_FILE,
  };
  const prompt = renderPrompt(k.ctx, mode === 'carve' ? 'carve.md' : 'revisit.md', vars);
  const run = await runAgent(k.ctx, 'carver', k.trunk, cwd, k.knobs.seats.carver, prompt);
  if (run.exitCode !== 0) return { ok: false, why: `carver exited ${run.exitCode}`, logPath: run.logPath };
  const raw = readResult<unknown>(cwd, CARVING_FILE);
  if (raw === null && k.ctx.dryRun) return { ok: false, why: 'dry run; no carver ran', logPath: null };
  const checked = validateCarving(raw, { mode, knobs: k.knobs, tree, scale: k.ctx.knobs.pointScale });
  if (!checked.ok) return { ok: false, why: `carver's answer is invalid: ${checked.faults.join('; ')}`, logPath: run.logPath };
  rmSync(cwd, { recursive: true, force: true });
  return { ok: true, carving: checked.carving };
}

async function runConfirmer(k: Knife, tree: Tree, mode: 'carve' | 'revisit', carving: Carving, ledger: Ledger | null, round: number, reply: string | null): Promise<{ ok: true; confirmation: Confirmation } | { ok: false; why: string; logPath: string | null }> {
  const cwd = join(k.ctx.runDir, `confirm-carve-${k.trunk}-${process.pid}`);
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  const chosen = carving.cuts && carving.chosen !== undefined ? { ...carving, cuts: [carving.cuts[carving.chosen]], chosen: 0 } : carving;
  const prompt = renderPrompt(k.ctx, 'confirm-carve.md', {
    ISSUE: String(k.trunk),
    TITLE: tree.issue.title,
    MODE: mode,
    VERDICT: carving.verdict,
    ROUND: String(round),
    MAX_ROUNDS: String(k.knobs.maxCarveRounds),
    CHILDREN: describeChildren(tree),
    PREVIOUS_LEDGER: ledger ? `\`\`\`json\n${JSON.stringify(ledger)}\n\`\`\`` : 'none',
    CARVING: JSON.stringify(chosen, null, 2),
    CARVER_REPLY: reply ? `The carver's reply to your last case:\n\n${reply}` : '',
    SEAMS_PATH,
    CONFIRMATION_FILE,
  });
  const run = await runAgent(k.ctx, 'confirmer', k.trunk, cwd, k.knobs.seats.confirmer, prompt);
  if (run.exitCode !== 0) return { ok: false, why: `confirmer exited ${run.exitCode}`, logPath: run.logPath };
  const raw = readResult<unknown>(cwd, CONFIRMATION_FILE);
  if (raw === null && k.ctx.dryRun) return { ok: false, why: 'dry run; no confirmer ran', logPath: null };
  const checked = validateConfirmation(raw, mode);
  if (!checked.ok) return { ok: false, why: `confirmer's answer is invalid: ${checked.faults.join('; ')}`, logPath: run.logPath };
  rmSync(cwd, { recursive: true, force: true });
  return { ok: true, confirmation: checked.confirmation };
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

function heldBy(tree: Tree): string | null {
  return labelsOf(tree.issue).find((l) => HOLD_LABELS.includes(l) && l !== 'loop/paused') ?? null;
}

/** One more failed attempt on the trunk; at the cap it goes to a person with the log tail. */
async function countFailure(k: Knife, tree: Tree, why: string, logPath: string | null): Promise<CarveOutcome> {
  if (k.ctx.dryRun) return { outcome: 'failed', reason: why };
  const attempts = recordCarve(k.ctx, k.trunk, carveCount(tree.issue.labels));
  k.say(`carve attempt ${attempts} of ${k.knobs.maxCarveAttempts} failed: ${why}`);
  if (attempts < k.knobs.maxCarveAttempts) return { outcome: 'failed', reason: why };
  const tail = logPath ? logTail(logPath) : 'no log';
  const fresh = readTree(k.ctx, k.trunk, k.io);
  const carving: Carving = { issue: k.trunk, mode: fresh.record && fresh.record.state === 'live' ? 'revisit' : 'carve', verdict: 'indivisible', reason: `The knife failed ${attempts} times on this issue and stops trying. Last failure: ${why}. Log tail: ${tail}`, criteria: [], ledger: fresh.record?.ledger ?? [], affected: [] };
  const out = await applyHandOff(k, fresh, carving, [], false, 'indivisible');
  return { ...out, reason: carving.reason };
}

export async function carveIssue(ctx: Context, issue: Issue, knobs: CarveKnobs, io: TrackerIo = trackerIo(ctx)): Promise<CarveOutcome> {
  const say = (m: string) => ctx.log(`#${issue.number}  ${m}`);
  assertDistinctEngines(knobs.seats.carver, knobs.seats.confirmer, 'carver and confirmer');

  let unlock = () => {};
  if (!ctx.dryRun && !ctx.io) {
    try {
      unlock = claimLock(ctx, `carve-${issue.number}.lock`);
    } catch (error) {
      return { outcome: 'busy', reason: (error as Error).message };
    }
  }
  let tree: Tree;
  try {
    tree = readTree(ctx, issue.number, io);
  } catch (error) {
    unlock();
    return { outcome: 'failed', reason: (error as Error).message };
  }
  if (tree.issue.state !== 'OPEN') {
    unlock();
    return { outcome: 'left-alone', reason: `#${issue.number} is ${tree.issue.state.toLowerCase()}` };
  }
  const journalPath = ctx.dryRun || ctx.io ? null : join(ctx.runDir, `carve-${issue.number}-gen${tree.generation}.json`);
  const k: Knife = { ctx, io, knobs, trunk: issue.number, say, journal: new JournalFile(ctx, knobs, issue.number, tree.generation, journalPath) };

  const handle = claim(ctx, io, issue.number, 'carving');
  if (handle === 'busy') {
    unlock();
    return { outcome: 'busy', reason: 'another run holds this issue' };
  }
  const stopRenewing = keepClaimed(handle);
  try {
    return await drive(k, tree);
  } finally {
    stopRenewing();
    try {
      handle.release({ keepLabel: k.journal.journal.status === 'open' && k.journal.journal.steps.length > 0 });
    } catch (error) {
      say(`could not release the claim: ${(error as Error).message}`);
    }
    unlock();
  }
}

async function drive(k: Knife, first: Tree): Promise<CarveOutcome> {
  let tree = readTree(k.ctx, k.trunk, k.io);
  void first;

  // 1. Finish the newest unfinished knife intent, if any.
  const pending = [...tree.intents].reverse().find((i) => !i.finished && (i.kind === 'applying' || i.kind === 'released' || i.kind === 'carve-handoff'));
  if (pending) {
    const done = await finishIntent(k, tree, pending);
    return done;
  }

  // 2. Repairs a held trunk needs, then leave it to its person.
  const hold = heldBy(tree);
  if (hold) {
    if (tree.record && !tree.record.seen.holds.includes(hold)) {
      const snapshot: Record = { ...tree.record, note: 'hold-observed', seen: fingerprint(tree, k.ctx.botLogin), at: new Date().toISOString() };
      postRecord(k, snapshot);
      k.say(`snapshotted the hold ${hold} so its removal is seen`);
    }
    return { outcome: 'left-alone', reason: `it carries ${hold}` };
  }
  if (tree.record && tree.record.state === 'live') reconcilePauses(k, tree.record);

  // 3. Mode, from the newest record alone.
  const record = tree.record;
  const mode: 'carve' | 'revisit' = record && record.state === 'live' ? 'revisit' : 'carve';
  const points = pointsOf(tree.issue.labels);
  const openChildren = tree.children.some((c) => c.state === 'OPEN');
  if (mode === 'carve' && !(points !== null && points > k.knobs.ceiling) && !openChildren) {
    return { outcome: 'left-alone', reason: points === null ? 'it is unsized' : `it is sized ${points}, not over the ceiling ${k.knobs.ceiling}, and has no open child` };
  }
  const redrive = Boolean(record && record.state === 'live' && record.seen.holds.some((h) => !labelsOf(tree.issue).includes(h)));
  const trigger = redrive ? 'a person removed a hold; this is a redrive' : 'the tracker differs from the record';

  // 4. Guards that need no agent.
  if (mode === 'carve' && tree.depth >= k.knobs.maxDepth) {
    const carving: Carving = { issue: k.trunk, mode, verdict: 'indivisible', reason: `at depth ${tree.depth}, the cap; cannot be carved further`, criteria: [], ledger: [], affected: [] };
    return applyHandOff(k, tree, carving, [], false, 'indivisible');
  }
  if (record && record.state === 'live' && !redrive) {
    if (record.revisits >= k.knobs.maxRevisitsPerGeneration) {
      const carving: Carving = { issue: k.trunk, mode, verdict: 'indivisible', reason: `revisited ${record.revisits} times in generation ${record.generation}, epoch ${record.epoch}; a person decides whether the carving stands`, criteria: [], ledger: record.ledger, affected: [] };
      return applyHandOff(k, tree, carving, [], false, 'indivisible');
    }
  }

  // 5. The carver and the confirmer, for at most maxCarveRounds pairs.
  const previousLedger = record ? buildLedger(record.ledger, carryIds(record.ledger, record.ledger), record, tree) : null;
  const before = fingerprint(tree, k.ctx.botLogin);
  let feedback: string | null = null;
  let reply: string | null = null;
  const opinions: Array<{ carver: string; confirmer: string }> = [];
  for (let round = 1; round <= k.knobs.maxCarveRounds; round++) {
    const carved = await runCarver(k, tree, mode, previousLedger, feedback, trigger);
    if (!carved.ok) return countFailure(k, tree, carved.why, carved.logPath);
    const carving = carved.carving;
    k.say(`carver (round ${round}): ${carving.verdict}; ${carving.reason}`);

    if (carving.verdict === 'amend' && record && record.generation >= k.knobs.maxGenerations && !redrive) {
      const handOff: Carving = { ...carving, verdict: 'indivisible', reason: `generation ${record.generation} is the cap for epoch ${record.epoch}; the carver wanted to amend again. ${carving.reason}`, affected: [] };
      return applyHandOff(k, tree, handOff, opinions, false, 'indivisible');
    }

    let plan: PiecePlan[] = [];
    if (carving.verdict === 'carve' || carving.verdict === 'amend') {
      const normalized = normalize(carving.cuts?.[carving.chosen ?? 0] as NonNullable<Carving['cuts']>[number], tree, k.io);
      if (!normalized.ok) {
        feedback = `Normalization refused the cut: ${normalized.faults.join('; ')}`;
        reply = null;
        k.say(feedback);
        continue;
      }
      plan = normalized.plan;
    }

    const confirmed = await runConfirmer(k, tree, mode, carving, previousLedger, round, reply);
    if (!confirmed.ok) return countFailure(k, tree, confirmed.why, confirmed.logPath);
    const confirmation = confirmed.confirmation;
    k.say(`confirmer (round ${round}): ${confirmation.finding}, seam ${confirmation.seam}; ${confirmation.reason}`);
    opinions.push({ carver: carving.reason, confirmer: confirmation.reason });

    if (!confirmation.agree) {
      feedback = `${confirmation.finding}: ${confirmation.reason}${confirmation.seam === 'higher-available' ? `\nSeam: ${confirmation.seamCase}` : ''}`;
      reply = carving.reason;
      continue;
    }

    // Agreed. The fingerprint is re-read immediately before anything lands; a difference restarts.
    tree = readTree(k.ctx, k.trunk, k.io);
    const now = fingerprint(tree, k.ctx.botLogin);
    if (JSON.stringify(now) !== JSON.stringify(before)) {
      return { outcome: 'failed', reason: 'the tracker changed while the cut was being confirmed; the next visit starts over' };
    }
    if (carving.verdict in HAND_OFFS) return applyHandOff(k, tree, carving, opinions, false, carving.verdict);
    if (carving.verdict === 'still-good') return applyStillGood(k, tree, carving, redrive);
    if (carving.verdict === 'exhausted') return applyRelease(k, tree, carving, null);

    // carve or amend
    const generation = tree.generation + 1;
    const epoch = redrive ? (record?.epoch ?? 1) + 1 : (record?.epoch ?? 1);
    const children = childrenFromCut(carving, plan, record);
    const applying: Record = {
      generation,
      epoch,
      state: 'applying',
      verdict: carving.verdict,
      reason: carving.reason,
      cut: carving.cuts?.[carving.chosen ?? 0] ?? null,
      children,
      supersedes: carving.supersedes ?? [],
      affected: [],
      ledger: carving.ledger,
      revisits: 0,
      seen: now,
      at: new Date().toISOString(),
    };
    k.journal = new JournalFile(k.ctx, k.knobs, k.trunk, generation, k.ctx.dryRun || k.ctx.io ? null : join(k.ctx.runDir, `carve-${k.trunk}-gen${generation}.json`));
    postRecord(k, applying);
    const applied = await applyRecord(k, applying);
    if (!applied.ok) {
      const handOff: Carving = { ...carving, verdict: 'indivisible', reason: applied.why, affected: [] };
      return applyHandOff(k, readTree(k.ctx, k.trunk, k.io), handOff, opinions, false, 'indivisible');
    }
    return { outcome: carving.verdict, reason: carving.reason, generation, children: applied.live.children.map((c) => c.number).filter((n): n is number => n !== null), journal: k.journal.journal };
  }

  // The round cap: a dispute about the whole carving pauses every open leaf.
  const last = opinions[opinions.length - 1];
  const carving: Carving = { issue: k.trunk, mode, verdict: 'indivisible', reason: `carver and confirmer disagreed ${k.knobs.maxCarveRounds} times; last: ${last?.confirmer ?? 'no confirmer answer'}`, criteria: [], ledger: record?.ledger ?? [], affected: [] };
  const out = await applyHandOff(k, tree, carving, opinions, true, 'indivisible');
  return { ...out, reason: carving.reason };
}

/** Finishes what a crash left announced: the newest applying record, released record, or hand-off. */
async function finishIntent(k: Knife, tree: Tree, pending: Intent): Promise<CarveOutcome> {
  k.say(`finishing an unfinished ${pending.kind} announcement (comment ${pending.commentId})`);
  if (pending.kind === 'applying') {
    const record = pending.payload as Record;
    k.journal = new JournalFile(k.ctx, k.knobs, k.trunk, record.generation, k.ctx.dryRun || k.ctx.io ? null : join(k.ctx.runDir, `carve-${k.trunk}-gen${record.generation}.json`));
    const applied = await applyRecord(k, record);
    if (!applied.ok) {
      const carving: Carving = { issue: k.trunk, mode: 'carve', verdict: 'indivisible', reason: applied.why, criteria: [], ledger: record.ledger, affected: [] };
      return applyHandOff(k, readTree(k.ctx, k.trunk, k.io), carving, [], false, 'indivisible');
    }
    return { outcome: 'resumed', reason: `finished generation ${record.generation} from its applying record`, generation: record.generation, children: applied.live.children.map((c) => c.number).filter((n): n is number => n !== null), journal: k.journal.journal };
  }
  if (pending.kind === 'released') {
    const record = pending.payload as Record;
    const out = await applyRelease(k, tree, null, record);
    return { ...out, outcome: 'resumed', reason: `finished the release announced by generation ${record.generation}` };
  }
  const payload = pending.payload as { verdict: string; reason: string; affected?: string[]; pauseSet?: number[]; opinions?: Array<{ carver: string; confirmer: string }> };
  const carving: Carving = { issue: k.trunk, mode: tree.record && tree.record.state === 'live' ? 'revisit' : 'carve', verdict: payload.verdict as Carving['verdict'], reason: payload.reason, criteria: [], ledger: tree.record?.ledger ?? [], affected: payload.affected ?? [] };
  const out = await applyHandOff(k, tree, carving, payload.opinions ?? [], false, payload.verdict);
  return { ...out, outcome: 'resumed', reason: `finished the ${payload.verdict} hand-off` };
}

export type { Knife };

/**
 * The floor directory: `list.jsonl` in, `ledger.jsonl` out, both append only. This module owns the
 * file names, the two record shapes, the verdict vocabulary, and the reads and writes. The ledger is
 * the floor's memory across runs: what was walked, against which deployed revision, what was
 * found, and the evidence. Nothing here knows about GitHub or agents; see references/floor.md.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const FILES = {
  list: 'list.jsonl',
  ledger: 'ledger.jsonl',
  evidence: 'evidence',
} as const;

export type ListItem = {
  id: string;
  addedAt: string;
  source: string;
  text: string;
  ref?: { issue?: number; pullRequest?: number; sha?: string; mergedAt?: string; paths?: string[]; unseenBase?: string };
};

export const RUNGS = ['liveness', 'classify', 'look', 'exercise', 'fallback', 'exists-in-git'] as const;
export type Rung = (typeof RUNGS)[number];
/** Rungs an agent may report; the other two belong to the driver. */
export const AGENT_RUNGS: ReadonlySet<Rung> = new Set<Rung>(['look', 'exercise', 'fallback', 'exists-in-git']);

export const VERDICTS = ['present', 'intact', 'not-checkable', 'absent', 'down', 'not-yet-deployed', 'unverified'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Verdicts that retire an item. Everything else leaves it on the walk list. */
export const TERMINAL: ReadonlySet<Verdict> = new Set<Verdict>(['present', 'intact', 'not-checkable']);
/** Verdicts the agent may write. The pending ones are the driver's to assign. */
export const AGENT_VERDICTS: ReadonlySet<Verdict> = new Set<Verdict>(['present', 'intact', 'not-checkable', 'absent']);
/** Verdicts that mean the environment is wrong and an incident is owed. */
export const REPAIR: ReadonlySet<Verdict> = new Set<Verdict>(['absent', 'down']);

export type LedgerEntry = {
  itemId: string;
  checkedAt: string;
  deployedRevision?: string;
  rung: Rung;
  verdict: Verdict;
  reason: string;
  evidence?: string;
  /** Recorded inside a quiet window, so nothing was paused or run for it. */
  quiet?: true;
};

/** The synthetic item the liveness probe reports against; never on the list. */
export const LIVENESS_ITEM = 'liveness';

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // A torn line from a crash mid-write is skipped rather than fatal; the record it would
      // have carried is re-derived on the next walk.
    }
  }
  return out;
}

/**
 * The list, deduplicated on id: the first item with an id wins, so producers append blindly. The
 * one exception is a merge the forge listed before the loop's own record of it arrived: the loop's
 * record knows the issue, so it fills in what the forge's lacked.
 */
export function readList(dir: string): ListItem[] {
  const byId = new Map<string, ListItem>();
  for (const item of readJsonl<ListItem>(join(dir, FILES.list))) {
    if (!item?.id) continue;
    const kept = byId.get(item.id);
    if (!kept) byId.set(item.id, item);
    else if (kept.source === 'forge' && item.source !== 'forge') byId.set(item.id, { ...kept, ...item, ref: { ...kept.ref, ...item.ref } });
  }
  return [...byId.values()];
}

export function readLedger(dir: string): LedgerEntry[] {
  return readJsonl<LedgerEntry>(join(dir, FILES.ledger));
}

/**
 * Appends one JSONL record. A crash mid-write can leave the last line without its newline; a plain
 * append would then fuse the torn fragment and the new record into one invalid line and lose both,
 * so the file is terminated first when it does not end in a newline.
 */
function appendLine(path: string, line: string): void {
  if (existsSync(path)) {
    const size = statSync(path).size;
    if (size > 0) {
      const fd = openSync(path, 'r');
      const last = Buffer.alloc(1);
      try {
        readSync(fd, last, 0, 1, size - 1);
      } finally {
        closeSync(fd);
      }
      if (last[0] !== 0x0a) appendFileSync(path, '\n');
    }
  }
  appendFileSync(path, `${line}\n`);
}

export function appendItem(dir: string, item: ListItem): void {
  mkdirSync(dir, { recursive: true });
  appendLine(join(dir, FILES.list), JSON.stringify(item));
}

export function appendEntry(dir: string, entry: LedgerEntry): void {
  mkdirSync(dir, { recursive: true });
  appendLine(join(dir, FILES.ledger), JSON.stringify(entry));
}

/** The newest ledger entry per item id. */
export function latestByItem(ledger: LedgerEntry[]): Map<string, LedgerEntry> {
  const latest = new Map<string, LedgerEntry>();
  for (const entry of ledger) latest.set(entry.itemId, entry);
  return latest;
}

/** Items with no terminal verdict yet: never walked, still pending, or awaiting repair. */
export function pending(list: ListItem[], ledger: LedgerEntry[]): ListItem[] {
  const latest = latestByItem(ledger);
  return list.filter((item) => {
    const entry = latest.get(item.id);
    return !entry || !TERMINAL.has(entry.verdict);
  });
}

/** The newest liveness entry that found the environment up, if any. */
export function lastClean(ledger: LedgerEntry[]): LedgerEntry | undefined {
  for (let i = ledger.length - 1; i >= 0; i--) {
    const entry = ledger[i];
    if (entry.itemId === LIVENESS_ITEM && entry.verdict === 'intact') return entry;
  }
  return undefined;
}

export function evidenceDir(dir: string): string {
  const path = join(dir, FILES.evidence);
  mkdirSync(path, { recursive: true });
  return path;
}

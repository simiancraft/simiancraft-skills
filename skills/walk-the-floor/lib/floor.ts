/**
 * The floor: the directory contract between the walker and whoever feeds it. This module owns the
 * file names, the two record shapes, the verdict vocabulary, and the append-only reads and writes.
 * Nothing here knows about GitHub, agents, or the burndown; see references/the-floor.md.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FILES = {
  list: 'list.jsonl',
  ledger: 'ledger.jsonl',
  onPass: 'on-pass',
  onFail: 'on-fail',
  lock: 'floor.lock',
  evidence: 'evidence',
} as const;

export type ListItem = {
  id: string;
  addedAt: string;
  source: string;
  text: string;
  ref?: { pullRequest?: number; sha?: string; mergedAt?: string; paths?: string[] };
};

export const RUNGS = ['liveness', 'classify', 'look', 'exercise', 'fallback', 'exists-in-git'] as const;
export type Rung = (typeof RUNGS)[number];
/** Rungs an agent may report; the other two belong to the driver. */
export const AGENT_RUNGS: ReadonlySet<Rung> = new Set<Rung>(['look', 'exercise', 'fallback', 'exists-in-git']);

export const VERDICTS = [
  'present',
  'intact',
  'not-checkable',
  'absent',
  'down',
  'not-yet-deployed',
  'unverified',
] as const;
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
  incident?: number;
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
      // have carried is re-derived on the next wake.
    }
  }
  return out;
}

/** The list, deduplicated on id: the first item with an id wins, so producers append blindly. */
export function readList(dir: string): ListItem[] {
  const seen = new Set<string>();
  const items: ListItem[] = [];
  for (const item of readJsonl<ListItem>(join(dir, FILES.list))) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

export function readLedger(dir: string): LedgerEntry[] {
  return readJsonl<LedgerEntry>(join(dir, FILES.ledger));
}

export function appendItem(dir: string, item: ListItem): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, FILES.list), `${JSON.stringify(item)}\n`);
}

export function appendEntry(dir: string, entry: LedgerEntry): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, FILES.ledger), `${JSON.stringify(entry)}\n`);
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

/** A filename-safe form of an item id for evidence files. */
export function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * One walker per floor. The lock holds the pid; a lock whose pid is dead is reclaimed, so a crash
 * never wedges the floor. Returns the release function.
 */
export function claimFloorLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, FILES.lock);
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
      throw new Error(`another walker (pid ${pid}) holds ${path}`);
    }
  }
  writeFileSync(path, `${process.pid}\n`);
  return () => {
    try {
      if (readFileSync(path, 'utf8').trim() === String(process.pid)) rmSync(path);
    } catch {
      // already gone
    }
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

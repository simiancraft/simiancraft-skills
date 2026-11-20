/**
 * The appraisal stamp: what a valid appraisal judged, so a later reader can tell whether that
 * judgment still describes the issue. It records the base commit the appraiser read, the paths it
 * said the work touches, and a digest of the thread as people wrote it. The loop's own comments are
 * left out of the digest, so the loop's bookkeeping never makes its own appraisal look stale.
 *
 * A missing stamp, or a stamp with no base, is unknowable rather than fresh: nothing recorded what
 * the appraisal judged, so a reader cannot say it still holds.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARKER } from '../../carve-github-issue/lib/tree.ts';

export const STAMP_MARKER = '<!-- appraise-stamp';

export type Stamp = {
  /** The base commit the appraiser read, or null when it could not be read. */
  base: string | null;
  /** The repository paths the appraiser said the work changes; empty when it named none. */
  touches: string[];
  /** A digest of the title, body, and every comment not written by the loop. */
  thread: string;
  points: number;
  at: string;
  /** The thread by part, so a changed digest can say what changed; absent on older stamps. */
  parts?: ThreadParts;
};

/** The thread by part: the title, the body, and each person's comment as `author:digest`, in order. */
export type ThreadParts = { title: string; body: string; comments: string[] };

type Thread = { title: string; body?: string | null; comments: Array<{ author: string; body: string }> };

/**
 * The digest of what people wrote on the issue; the loop's own comments do not move it. A loop
 * comment is one by the loop's account that carries a loop marker, so a loop that runs under a
 * person's own account still counts that person's unmarked comments as theirs.
 */
export function threadDigest(issue: Thread, botLogin: string): string {
  const hash = createHash('sha256');
  hash.update(issue.title);
  hash.update('\0');
  hash.update(issue.body ?? '');
  for (const c of peopleComments(issue, botLogin)) {
    hash.update('\0');
    hash.update(c.author);
    hash.update('\0');
    hash.update(c.body);
  }
  return hash.digest('hex').slice(0, 16);
}

function peopleComments(issue: Thread, botLogin: string): Array<{ author: string; body: string }> {
  return issue.comments.filter((c) => !(c.author === botLogin && MARKER.test(c.body)));
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

export function threadParts(issue: Thread, botLogin: string): ThreadParts {
  return {
    title: digest(issue.title),
    body: digest(issue.body ?? ''),
    comments: peopleComments(issue, botLogin).map((c) => `${c.author}:${digest(c.body)}`),
  };
}

/** What moved between two readings of the thread, in words; empty when neither part moved. */
export function threadChanges(then: ThreadParts, now: ThreadParts): string[] {
  const changes: string[] = [];
  if (then.title !== now.title) changes.push('the title was edited');
  if (then.body !== now.body) changes.push('the body was edited');
  const remaining = [...then.comments];
  const added: string[] = [];
  for (const c of now.comments) {
    const at = remaining.indexOf(c);
    if (at >= 0) remaining.splice(at, 1);
    else added.push(c.slice(0, c.lastIndexOf(':')));
  }
  if (added.length) changes.push(`${added.length} comment${added.length === 1 ? '' : 's'} added or edited (by ${[...new Set(added)].join(', ')})`);
  if (remaining.length > added.length) changes.push(`${remaining.length - added.length} comment${remaining.length - added.length === 1 ? '' : 's'} removed`);
  return changes;
}

export function renderStamp(stamp: Stamp): string {
  const base = stamp.base ? `\`${stamp.base.slice(0, 12)}\`` : 'an unreadable base';
  const touches = stamp.touches.length ? stamp.touches.map((t) => `\`${t}\``).join(', ') : 'no paths named';
  return [
    `${STAMP_MARKER} base=${stamp.base ?? 'none'} thread=${stamp.thread} points=${stamp.points} at=${stamp.at} -->`,
    '```json',
    JSON.stringify(stamp.parts ? { touches: stamp.touches, parts: stamp.parts } : { touches: stamp.touches }),
    '```',
    `Appraised at ${stamp.points} points against ${base}; touches ${touches}.`,
  ].join('\n');
}

/** The newest stamp the loop wrote on the thread, or null when it wrote none. */
export function latestStamp(comments: Array<{ author: string; body: string }>, botLogin: string): Stamp | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i] as { author: string; body: string };
    if (c.author !== botLogin || !c.body.startsWith(STAMP_MARKER)) continue;
    const head = /^<!-- appraise-stamp base=(\S+) thread=(\S+) points=(\d+) at=(\S+) -->/.exec(c.body);
    if (!head) continue;
    let touches: string[] = [];
    let parts: ThreadParts | undefined;
    const json = /```json\n([\s\S]*?)\n```/.exec(c.body);
    try {
      const parsed = json ? (JSON.parse(json[1] as string) as { touches?: unknown; parts?: unknown }) : {};
      if (Array.isArray(parsed.touches)) touches = parsed.touches.filter((t): t is string => typeof t === 'string');
      const p = parsed.parts as Partial<ThreadParts> | undefined;
      if (p && typeof p.title === 'string' && typeof p.body === 'string' && Array.isArray(p.comments)) parts = { title: p.title, body: p.body, comments: p.comments.filter((x): x is string => typeof x === 'string') };
    } catch {
      touches = [];
    }
    const stamp: Stamp = { base: head[1] === 'none' ? null : (head[1] as string), thread: head[2] as string, points: Number(head[3]), at: head[4] as string, touches };
    if (parts) stamp.parts = parts;
    return stamp;
  }
  return null;
}

/** The stamps this process wrote, by repository and issue, as the `at` each carries. */
const stampedHere = new Map<string, string>();

export function noteStampedHere(repo: string, issue: number, at: string): void {
  stampedHere.set(`${repo}#${issue}`, at);
}

/** Whether this process wrote the stamp written at `at`: one judged moments ago, in this same run. */
export function wroteStampHere(repo: string, issue: number, at: string | null): boolean {
  return at !== null && stampedHere.get(`${repo}#${issue}`) === at;
}

const SINCE_FILE = 'stamping-since';

/** Records, once per run directory, when its appraisals began to be stamped. */
export function noteStampingSince(runDir: string, at: string): void {
  const path = join(runDir, SINCE_FILE);
  if (existsSync(path)) return;
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path, `${at}\n`);
}

/** When this run directory's appraisals began to be stamped, or null when it never recorded it. */
export function stampingSince(runDir: string): string | null {
  try {
    const at = readFileSync(join(runDir, SINCE_FILE), 'utf8').trim();
    return Number.isFinite(Date.parse(at)) ? at : null;
  } catch {
    return null;
  }
}

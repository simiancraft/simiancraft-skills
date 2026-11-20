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
};

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
  for (const c of issue.comments) {
    if (c.author === botLogin && MARKER.test(c.body)) continue;
    hash.update('\0');
    hash.update(c.author);
    hash.update('\0');
    hash.update(c.body);
  }
  return hash.digest('hex').slice(0, 16);
}

export function renderStamp(stamp: Stamp): string {
  const base = stamp.base ? `\`${stamp.base.slice(0, 12)}\`` : 'an unreadable base';
  const touches = stamp.touches.length ? stamp.touches.map((t) => `\`${t}\``).join(', ') : 'no paths named';
  return [
    `${STAMP_MARKER} base=${stamp.base ?? 'none'} thread=${stamp.thread} points=${stamp.points} at=${stamp.at} -->`,
    '```json',
    JSON.stringify({ touches: stamp.touches }),
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
    const json = /```json\n([\s\S]*?)\n```/.exec(c.body);
    try {
      const parsed = json ? (JSON.parse(json[1] as string) as { touches?: unknown }) : {};
      if (Array.isArray(parsed.touches)) touches = parsed.touches.filter((t): t is string => typeof t === 'string');
    } catch {
      touches = [];
    }
    return { base: head[1] === 'none' ? null : (head[1] as string), thread: head[2] as string, points: Number(head[3]), at: head[4] as string, touches };
  }
  return null;
}

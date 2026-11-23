/**
 * The stop record: what stopped the work, written on the issue's thread by the loop that stopped
 * it. Every stop the loop makes writes one, in one format:
 *
 *   <!-- loop-stop kind=<kind> [field=value ...] -->
 *   <the words a person and the next seat read>
 *
 * The kinds are the ways work stops: `park` (handed to a person with a reason), `boundary` (an
 * approved change the merge boundary kept for a person), `dead-letter` (a machine gave up, with its
 * `phase`), `proof-held` (a prover asked for a person after the code was pushed), `held` (a seat
 * asked for a person or a decision, with its `verdict`), `outside` (a stop the change did not cause,
 * with its `cause` and `seat`; see `environment-fault.ts`), and `approved` (a review approved the
 * head named by `sha`; the newest record says the work was not stopped since).
 *
 * One reader, `readStop`, answers "what stopped this work last": the newest record the loop wrote,
 * since the pull request in hand was opened. Threads written before the record existed are read
 * through a fallback: the `loop-proof-held` and `loop-held` markers, and the words of a loop note
 * (a dead letter's queue, a park, the boundary's own reason).
 */

import { noteText } from './note.ts';

export const STOP = 'loop-stop';

export type StopKind = 'park' | 'boundary' | 'dead-letter' | 'proof-held' | 'held' | 'outside' | 'approved';
const KINDS: StopKind[] = ['park', 'boundary', 'dead-letter', 'proof-held', 'held', 'outside', 'approved'];

/** A stop as read: its kind, the fields its marker carries, and the words below the marker. */
export type StopRecord = { kind: StopKind; fields: { [key: string]: string }; text: string };

/** The reason the merge boundary writes when it parks an approved change (`pipeline.ts`, land). */
export const BOUNDARY_PARK = /^autoMerge is \S+ and the change touches /;

/** The markers a thread written before the stop record carries for two of its kinds. */
const LEGACY: { [name: string]: StopKind } = { 'loop-proof-held': 'proof-held', 'loop-held': 'held' };

/** A marker field is one whitespace-free token; anything else is refused. */
function token(value: string, what: string): string {
  if (!/^[^\s>]+$/.test(value)) throw new Error(`a ${what} for a ${STOP} marker must be one token: ${JSON.stringify(value)}`);
  return value;
}

/** The comment that records a stop: the marker line, then the words. */
export function stopComment(kind: StopKind, fields: { [key: string]: string | number | undefined }, text: string): string {
  const pairs = Object.entries(fields)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== '')
    .map(([key, value]) => ` ${key}=${token(String(value), key)}`)
    .join('');
  return `<!-- ${STOP} kind=${kind}${pairs} -->\n${text.trim()}`;
}

/** The leading marker of a comment, when it opens with one: its name and fields. */
function leadingMarker(body: string): { name: string; fields: { [key: string]: string } } | null {
  const match = /^<!--\s*([\w-]+)\b([^>]*)-->/.exec(body.trim());
  if (!match) return null;
  const fields: { [key: string]: string } = {};
  for (const pair of match[2].trim().split(/\s+/)) {
    const eq = pair.indexOf('=');
    if (eq > 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return { name: match[1], fields };
}

/** The words below a comment's marker line. */
const below = (body: string): string => body.trim().split('\n').slice(1).join('\n').trim();

/**
 * The stop one comment records, or null when it records none. A `loop-stop` marker is read as
 * written; the two older markers as their kind; any other marker (a coded step, a claim, a record)
 * is not a stop. A comment with no marker but a loop note's is read by its words, as threads
 * written before the stop record have to be: the boundary's reason is a boundary park, a dead
 * letter's queue is a dead letter, and a park's own word is a park.
 */
export function stopIn(body: string): StopRecord | null {
  const marker = leadingMarker(body);
  if (marker?.name === STOP) {
    const kind = marker.fields.kind as StopKind;
    if (!KINDS.includes(kind)) return null;
    const { kind: _, ...fields } = marker.fields;
    return { kind, fields, text: below(body) };
  }
  if (marker && LEGACY[marker.name]) return { kind: LEGACY[marker.name], fields: marker.fields, text: below(body) };
  if (marker && marker.name !== 'loop-note') return null;
  const text = noteText(body);
  if (BOUNDARY_PARK.test(text)) return { kind: 'boundary', fields: {}, text };
  if (/dead-letter queue/.test(text)) return { kind: 'dead-letter', fields: {}, text };
  if (/parked|Parked/.test(text)) return { kind: 'park', fields: {}, text };
  return null;
}

/**
 * Which comments a reader of the stop considers: the loop's own (`botLogin`; every author when it
 * is not given), and when `since` is given, only those written after it: the moment the pull
 * request in hand was opened, since an issue's thread also holds the stops of earlier attempts
 * that pull request never met.
 */
export type StopScope = { botLogin?: string; since?: string };

type Thread = Array<{ author?: string; body: string; createdAt?: string }>;

/** The newest stop record in scope and where it sits on the thread. */
function newestStop(comments: Thread, scope: StopScope): { stop: StopRecord; at: number } | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const { author, body, createdAt } = comments[i];
    if (scope.botLogin !== undefined && author !== scope.botLogin) continue;
    if (scope.since !== undefined && createdAt !== undefined && createdAt <= scope.since) continue;
    const stop = stopIn(body);
    if (stop) return { stop, at: i };
  }
  return null;
}

/** What stopped the work last: the newest stop record in scope, oldest comment first; null when none. */
export function readStop(comments: Thread, scope: StopScope = {}): StopRecord | null {
  return newestStop(comments, scope)?.stop ?? null;
}

/**
 * What the newest stop asks of the pickup. A park or a dead letter is an objection a redrive hands
 * a coder; a held proof is the prover's request for a person, and the pickup after it proves the
 * pull request again; a seat's ask is a person's to answer; a boundary park or an approval is
 * neither an objection nor a hold.
 */
export type StandingStop =
  | { kind: 'objection'; text: string }
  | { kind: 'proof-held' }
  | { kind: 'held'; text: string }
  | { kind: 'boundary' }
  | { kind: 'approved'; sha: string }
  | { kind: 'outside'; cause: string; seat: string; text: string; behind: StandingStop }
  | null;

/** The causes of an outside stop that wait on a person; the others rerun the work (`environment-fault.ts`). */
const WAITING = ['base', 'needs-person'];

/**
 * `readStop`, read as what the pickup does with it. An outside stop carries the stop behind it,
 * since it says the work was interrupted, not what the work was answering.
 */
export function standingStop(comments: Thread, botLogin?: string, since?: string): StandingStop {
  const found = newestStop(comments, { botLogin, since });
  if (!found) return null;
  const { stop } = found;
  switch (stop.kind) {
    case 'outside':
      return { kind: 'outside', cause: stop.fields.cause ?? '', seat: stop.fields.seat ?? '', text: stop.text, behind: standingStop(comments.slice(0, found.at), botLogin, since) };
    case 'park':
    case 'dead-letter':
      return { kind: 'objection', text: stop.text };
    case 'proof-held':
      return { kind: 'proof-held' };
    case 'held':
      return { kind: 'held', text: stop.text };
    case 'boundary':
      return { kind: 'boundary' };
    case 'approved':
      return { kind: 'approved', sha: stop.fields.sha ?? '' };
  }
}

/**
 * The approval the work still stands on: the newest `approved` record in scope, when nothing newer
 * than it judged the change. Only a boundary park (the approval parked by policy) and an outside
 * stop (a host, a signal, a transport failure, a stuck check, or one of those held for a person
 * after it repeated) may sit above it, since neither says anything about the change; a park, a dead
 * letter, a held proof, or a seat's hold each say something happened to the work since. Whether
 * the head still matches is the caller's question. Null when there is no such approval. The record
 * names the head the reviewer read (`sha`) and, when both seats classified the change, the
 * classification (`touches`, comma-separated).
 */
export function standingApproval(comments: Thread, scope: StopScope = {}): { sha: string; pr?: number; touches: string[] } | null {
  let upTo = comments.length;
  for (;;) {
    const found = newestStop(comments.slice(0, upTo), scope);
    if (!found) return null;
    const { stop, at } = found;
    if (stop.kind === 'approved') {
      if (!stop.fields.sha) return null;
      const pr = Number(stop.fields.pr);
      return { sha: stop.fields.sha, pr: Number.isInteger(pr) && pr > 0 ? pr : undefined, touches: (stop.fields.touches ?? '').split(',').filter(Boolean) };
    }
    const passing = stop.kind === 'boundary' || stop.kind === 'outside';
    if (!passing) return null;
    upTo = at;
  }
}

/**
 * Whether `needs-human` stands because the loop held the work for a person: a held proof, or an
 * outside stop that waits on a person. The pickup lifts that hold, on the issue and on the pull
 * request; any other `needs-human` is a person's own, and stays.
 */
export function loopHoldStands(stop: StandingStop): boolean {
  return stop?.kind === 'proof-held' || (stop?.kind === 'outside' && WAITING.includes(stop.cause));
}

/**
 * The objection the pickup hands a coder, or null when the pickup proves again. A park's or a dead
 * letter's words; through an outside stop, the stop behind it; and when an outside stop that waited
 * on a person stopped the coder with nothing behind it, its own words, so the coder carries on.
 */
export function objectionAfter(stop: StandingStop): string | null {
  if (!stop) return null;
  if (stop.kind === 'objection') return stop.text.trim() || null;
  if (stop.kind !== 'outside') return null;
  const behind = objectionAfter(stop.behind);
  if (behind) return behind;
  return WAITING.includes(stop.cause) && stop.seat === 'coder' ? stop.text.trim() || null : null;
}

// ---------------------------------------------------------------------------
// The writers' words, for the kinds whose text the record composes itself
// ---------------------------------------------------------------------------

/**
 * A prover that needs a person holds the work where it stands: the code is pushed, the pull
 * request (when the prover opened one) stays open, and the issue carries `needs-human`. This
 * record is the hold, so the pickup after a person lifts it proves the same work again instead of
 * reading the hold as an objection a coder must answer.
 */
export function proofHeldComment(runId: string, held: { branch: string; pr?: number }, reason: string): string {
  const where = held.pr ? `pull request #${held.pr} stays open on \`${held.branch}\`` : `the coded commit stays on \`${held.branch}\``;
  const again = held.pr ? `proves #${held.pr} again` : 'proves the coded commit again';
  return stopComment('proof-held', { run: runId, branch: held.branch, pr: held.pr }, [
    `**Held for a person while proving.** The code is done; ${where}.`,
    '',
    reason.trim(),
    '',
    `Remove the \`needs-human\` label from this issue once what the proof needs is in place: the next burndown run ${again}, or run the fix command with \`--redrive\` to do it at once.`,
  ].join('\n'));
}

/**
 * A seat that asked for a person or a decision, other than a prover holding its proof. The record
 * makes the ask a stop a reader of the thread can see, so a held proof written before it is no
 * longer the standing one.
 */
export function heldComment(verdict: 'needs-human' | 'needs-decision', reason: string): string {
  return stopComment('held', { verdict }, reason);
}

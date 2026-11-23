/**
 * The facts the Work lanes leave on the issue. A seat's own answer file lives in a worktree that a
 * crash or a retirement removes; these comments are what the next seat, and the next run, read to
 * know where the work stands. The driver writes them, never a seat, and only after checking the
 * remote holds what they name.
 *
 * `coded` says the coder pushed a commit it gated, and carries its hand-off to the prover.
 * `unproved` says a prover could not prove that commit, and carries what could not be shown, which
 * is the next coder's brief. The newest of the two, by the bot, is the standing fact.
 */

import { parseMarker } from '../../carve-github-issue/lib/tree.ts';
import { noteText } from './note.ts';

export type Touch = 'code' | 'data' | 'migration' | 'stored-string' | 'ci';

export type CodedStep = { kind: 'coded'; sha: string; branch: string; gated: string; touches: Touch[]; handoff: string };
export type UnprovedStep = { kind: 'unproved'; sha: string; branch: string; brief: string };
export type WorkStep = CodedStep | UnprovedStep;

const TOUCHES: Touch[] = ['code', 'data', 'migration', 'stored-string', 'ci'];

/** A marker field is one whitespace-free token; a branch name already is, and anything else is refused. */
function token(value: string, what: string): string {
  if (!/^[^\s>]+$/.test(value)) throw new Error(`a ${what} for a loop-step marker must be one token: ${JSON.stringify(value)}`);
  return value;
}

export function codedComment(runId: string, coded: { branch: string; sha: string; gated: string; touches: Touch[] }, handoff: string): string {
  const { branch, sha, gated, touches } = coded;
  const kinds = touches.length > 0 ? touches.join(',') : 'code';
  return [
    `<!-- loop-step coded run=${token(runId, 'run')} branch=${token(branch, 'branch')} sha=${token(sha, 'sha')} gated=${token(gated, 'gated sha')} touches=${kinds} -->`,
    `**Coded** at \`${sha.slice(0, 12)}\` on \`${branch}\`; proving next.`,
    '',
    handoff.trim(),
  ].join('\n');
}

export function unprovedComment(runId: string, branch: string, sha: string, brief: string): string {
  return [
    `<!-- loop-step unproved run=${token(runId, 'run')} branch=${token(branch, 'branch')} sha=${token(sha, 'sha')} -->`,
    `**Not proved** at \`${sha.slice(0, 12)}\`; back to coding with what could not be shown.`,
    '',
    brief.trim(),
  ].join('\n');
}

/** The text a marker comment carries for the next seat: everything after its two header lines. */
function carried(body: string): string {
  return body.split('\n').slice(2).join('\n').trim();
}

/** The standing Work fact on an issue: the newest `loop-step` marker the bot wrote, or null. */
export function latestStep(comments: Array<{ author: string; body: string }>, botLogin: string): WorkStep | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (comment.author !== botLogin) continue;
    const marker = parseMarker(comment.body);
    if (marker?.name !== 'loop-step') continue;
    const { sha, branch } = marker.fields;
    if (!sha || !branch) continue;
    const kind = comment.body.slice(comment.body.indexOf('loop-step') + 'loop-step'.length).trim().split(/\s+/)[0];
    if (kind === 'coded') {
      const touches = (marker.fields.touches ?? 'code').split(',').filter((t): t is Touch => (TOUCHES as string[]).includes(t));
      return { kind, sha, branch, gated: marker.fields.gated ?? '', touches, handoff: carried(comment.body) };
    }
    if (kind === 'unproved') return { kind, sha, branch, brief: carried(comment.body) };
  }
  return null;
}

/**
 * A prover that needs a person holds the work where it stands: the code is pushed, the pull
 * request (when the prover opened one) stays open, and the issue carries `needs-human`. This
 * comment is the hold's record, so the pickup after a person lifts it proves the same work again
 * instead of reading the hold as an objection a coder must answer.
 */
export const PROOF_HELD = 'loop-proof-held';

export function proofHeldComment(runId: string, held: { branch: string; pr?: number }, reason: string): string {
  const where = held.pr ? `pull request #${held.pr} stays open on \`${held.branch}\`` : `the coded commit stays on \`${held.branch}\``;
  const again = held.pr ? `proves #${held.pr} again` : 'proves the coded commit again';
  return [
    `<!-- ${PROOF_HELD} run=${token(runId, 'run')} branch=${token(held.branch, 'branch')}${held.pr ? ` pr=${held.pr}` : ''} -->`,
    `**Held for a person while proving.** The code is done; ${where}.`,
    '',
    reason.trim(),
    '',
    `Remove the \`needs-human\` label from this issue once what the proof needs is in place: the next burndown run ${again}, or run the fix command with \`--redrive\` to do it at once.`,
  ].join('\n');
}

/**
 * A seat that asked for a person or a decision, other than a prover holding its proof: the work stops
 * there, and the pull request (when there was one) is closed. The marker makes the ask a stop a
 * reader of the thread can see, so a held proof written before it is no longer the standing one.
 */
export const HELD = 'loop-held';

export function heldComment(verdict: 'needs-human' | 'needs-decision', reason: string): string {
  return [`<!-- ${HELD} verdict=${verdict} -->`, reason.trim()].join('\n');
}

/**
 * What stopped the work last, read from the loop's comments: an objection a revision answers, a held
 * proof, which is not one, or a seat's ask for a person or a decision, which a person answers.
 */
export type StandingStop = { kind: 'objection'; text: string } | { kind: 'proof-held' } | { kind: 'held'; text: string } | null;

/**
 * The newest stop on a thread, oldest comment first. A park or a dead letter is an objection, and
 * a redrive hands it to a coder; a held proof is the prover's request for a person, and the pickup
 * after it proves the pull request again; a seat's ask is a person's to answer. When `botLogin` is
 * given, only its comments count; when `since` is given, only comments written after it.
 */
export function standingStop(comments: Array<{ author?: string; body: string; createdAt?: string }>, botLogin?: string, since?: string): StandingStop {
  for (let i = comments.length - 1; i >= 0; i--) {
    const { author, body, createdAt } = comments[i];
    if (botLogin !== undefined && author !== botLogin) continue;
    if (since !== undefined && createdAt !== undefined && createdAt <= since) continue;
    const marker = parseMarker(body)?.name;
    if (marker === PROOF_HELD) return { kind: 'proof-held' };
    if (marker === HELD) return { kind: 'held', text: body.trim().split('\n').slice(1).join('\n').trim() };
    // A park or dead-letter note opens with the loop-note marker; its words are what the next coder answers.
    const text = noteText(body);
    if (/dead-letter queue|parked|Parked/.test(text)) return { kind: 'objection', text };
  }
  return null;
}

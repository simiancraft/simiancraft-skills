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

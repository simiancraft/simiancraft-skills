/**
 * The work turn's steps, and the durable facts they end at.
 *
 * A step ends at something the next run can read on the remote and the tracker: a pushed branch,
 * and a marker on the issue announcing what the step reached. The driver dispatches the next step
 * from those, never from a dead process's memory, so a kill, a cap, a stop, or a lost lease costs
 * one step. The markers follow the carve lifecycle's announced intents and are parsed by the same
 * parser.
 */

import { parseMarker } from '../../carve-github-issue/lib/tree.ts';
import type { Context } from './context.ts';
import { mutate } from './shell.ts';

/**
 * `coded`: the change is on the remote and passed the repository's own gate at `gated`. `proved`: a
 * draft carries proof of `sha`. `refused`: a prover could not prove `sha`, and the hand-off is its
 * reason, which is the next coder's brief.
 */
export type Step = 'coded' | 'proved' | 'refused';

export type StepMarker = {
  step: Step;
  runId: string;
  /** The head the step reached, on the remote. */
  sha: string;
  /** The head the repository's gate last passed on; a prover whose head differs runs the gate again. */
  gated: string;
  touches: string[];
  /** What the next step needs and cannot read from the diff: what changed, and how to exercise it. */
  handoff: string;
};

const STEPS: Step[] = ['coded', 'proved', 'refused'];
const SHA = /^[0-9a-f]{7,40}$/;

/** The comment that announces a step: a marker line a driver parses, then the hand-off a person or an agent reads. */
export function renderStepMarker(marker: StepMarker): string {
  const fields = `step=${marker.step} run=${marker.runId} sha=${marker.sha} gated=${marker.gated} touches=${marker.touches.join(',') || 'none'}`;
  return `<!-- loop-step ${fields} -->\n${marker.handoff.trim()}`;
}

/** The step a comment announces, or null: not a step marker, or one a driver cannot act on. */
export function parseStepMarker(body: string): StepMarker | null {
  const parsed = parseMarker(body);
  if (parsed?.name !== 'loop-step') return null;
  const { step, run, sha, gated, touches } = parsed.fields;
  if (!STEPS.includes(step as Step) || !run || !SHA.test(sha ?? '') || !SHA.test(gated ?? '')) return null;
  const end = body.indexOf('-->');
  return { step: step as Step, runId: run, sha, gated, touches: !touches || touches === 'none' ? [] : touches.split(','), handoff: body.slice(end + 3).trim() };
}

/**
 * The newest step the loop itself announced on an issue. Only the bot's own comments count: a
 * marker anybody else can type is not a fact about what a step reached.
 */
export function newestStep(comments: Array<{ author: string; body: string }>, botLogin: string): StepMarker | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].author !== botLogin) continue;
    const marker = parseStepMarker(comments[i].body);
    if (marker) return marker;
  }
  return null;
}

/** Announces a step on the issue. A mutation like any other: refused under a stop, rehearsed in a dry run. */
export function announceStep(ctx: Context, issue: number, marker: StepMarker): void {
  mutate(ctx, `announce ${marker.step} at ${marker.sha.slice(0, 10)} on #${issue}`, ['gh', 'issue', 'comment', String(issue), '--body', renderStepMarker(marker)]);
}

/** What is known about a card's work, all of it readable from the remote and the tracker. */
export type WorkFacts = {
  /** A pull request for the issue's branch that is ready for review. */
  readyPr: boolean;
  /** A draft pull request exists, and the sha at its head. */
  draftHead: string | null;
  /** The issue's branch on the remote, or null when there is none. */
  remoteHead: string | null;
  marker: StepMarker | null;
  /**
   * Whether the remote branch is at exactly the head the marker names. A descendant is not enough:
   * an unfinished later commit descends from a finished one too. The driver announces again after
   * its own catch-up moves the head, so an exact match is always available to finished work.
   */
  remoteCarriesMarker: boolean;
};

/** Where in Work a card is, and what is dispatched from there. */
export type WorkPlacement =
  | { lane: 'E1'; dispatch: 'review' }
  | { lane: 'D3'; dispatch: 'mark-ready' }
  | { lane: 'D2'; dispatch: 'prove' }
  | { lane: 'D1'; dispatch: 'code'; from: 'branch' | 'nothing' | 'refusal' };

/**
 * Places a card in Work from facts, in order. A pushed branch whose head no marker names dispatches
 * Code, never Prove: a push says work happened, and only the announcement says the coder called
 * it finished and gated.
 */
export function placeInWork(facts: WorkFacts): WorkPlacement {
  if (facts.readyPr) return { lane: 'E1', dispatch: 'review' };
  const announced = facts.marker !== null && facts.remoteCarriesMarker;
  // A refusal stands until a newer Code announcement supersedes it, whatever the head has done
  // since: a catch-up moves the head and repairs nothing, so the refused code is not proved again.
  if (facts.marker?.step === 'refused' && facts.remoteHead) return { lane: 'D1', dispatch: 'code', from: 'refusal' };
  if (facts.draftHead && announced && facts.marker?.step === 'proved' && facts.marker.sha === facts.draftHead) return { lane: 'D3', dispatch: 'mark-ready' };
  if (announced) return { lane: 'D2', dispatch: 'prove' };
  return { lane: 'D1', dispatch: 'code', from: facts.remoteHead ? 'branch' : 'nothing' };
}

/** The reads placement needs, injectable so a test neither shells out nor needs a remote. */
export type WorkReads = {
  /** The newest step the loop announced on the issue. */
  marker: () => StepMarker | null;
  /** The remote branches whose names end in `-<issue>`, with their heads: the coder's naming rule. */
  remoteBranches: () => Array<{ branch: string; sha: string }>;
  /** The open pull request for a branch, if any. */
  pull: (branch: string) => { number: number; isDraft: boolean; headRefOid: string } | null;
};

/**
 * Where a card's work stands, from the remote and the tracker alone. This is what makes a step
 * resumable by any run on any machine: nothing here is read from a worktree or a verdict file.
 */
export function readWorkFacts(reads: WorkReads): WorkFacts & { branch: string | null; pr: number | null } {
  const marker = reads.marker();
  const branches = reads.remoteBranches();
  // The branch the marker speaks of is the one that carries its head; with no marker, the one
  // branch named for the issue, and with several and no marker there is no telling which.
  const carrying = marker ? branches.find((b) => b.sha === marker.sha) : undefined;
  const chosen = carrying ?? (branches.length === 1 ? branches[0] : undefined);
  const pull = chosen ? reads.pull(chosen.branch) : null;
  return {
    readyPr: pull !== null && !pull.isDraft,
    draftHead: pull?.isDraft ? pull.headRefOid : null,
    remoteHead: chosen?.sha ?? null,
    marker,
    remoteCarriesMarker: carrying !== undefined,
    branch: chosen?.branch ?? null,
    pr: pull?.number ?? null,
  };
}


/**
 * The knife's two callback slots, `on-carve-pass` and `on-carve-fail`, on the shared slot mechanism
 * in fix-github-issue. Either an executable the knife runs with the payload on stdin, or a
 * Markdown prompt (not run by the knife; left for a producer that wants one), or both. The knife
 * never knows what a callback does.
 *
 * A callback runs before the write that completes its intent, so a crash between the two replays
 * it on repair; the payload's `key` is the idempotency key an adopter drops replays on.
 */

import { type CallbackResult, runCallback as runSlot } from '../../fix-github-issue/lib/callbacks.ts';
import type { Relation, Seam } from './tree.ts';

export type CarveCallbackName = 'on-carve-pass' | 'on-carve-fail';
export type { CallbackResult };

export type CarveCallbackPayload = {
  key: { issue: number; generation: number | null; epoch: number; revisits: number; verdict: string };
  issue: number;
  title: string;
  mode: 'carve' | 'revisit';
  verdict: string;
  generation: number | null;
  seam: Seam | null;
  relation: Relation | null;
  children: number[];
  superseded: number[];
  paused: number[];
  reason: string;
  repo: string;
  baseBranch: string;
  repoRoot: string;
};

export function runCarveCallback(dir: string, name: CarveCallbackName, payload: CarveCallbackPayload, log: (message: string) => void): Promise<CallbackResult> {
  return runSlot(dir, name, payload, log, { timeoutMs: 0 });
}

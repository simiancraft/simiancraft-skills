/**
 * The context: everything the fix pipeline used to read off module-level globals, gathered into one
 * object that every extracted function takes as its first parameter.
 *
 * One process can hold two of these (a burndown driver and a heartbeat, say), so anything a
 * pipeline must not share between drivers belongs here rather than on a module.
 */

import { resolve } from 'node:path';
import type { PipelineKnobs, ProjectConfig } from './config.ts';
import type { Seat } from './engines.ts';
import { log as defaultLog, step as defaultStep } from './shell.ts';

/** What the pull master tells a driver once a merge is confirmed. */
export type MergeEvent = { issue: number; title: string; pr: number; sha: string; mergedAt: string; paths: string[] };

/**
 * A driver's answer to "may this merge now". Resolving `ok` lets the merge proceed; a driver that
 * wants to hold the line waits before resolving, and one that gives up resolves a refusal, which
 * parks the pull request with the reason and spends no review round.
 */
export type MergePermission = { ok: true } | { ok: false; reason: string };

export type Context = {
  /** Everything true of the repository being worked. */
  project: ProjectConfig;
  /** The pipeline's own boundaries. A driver's extra knobs stay with the driver. */
  knobs: Omit<PipelineKnobs, 'seats'>;
  /** The two seats the pipeline fills. A driver's third seat is never visible here. */
  seats: { worker: Seat; reviewer: Seat };
  /** The main checkout. Never an agent's working directory. */
  repoRoot: string;
  /** The checkout the driver was invoked from, which is where the config was read. */
  invokeRoot: string;
  /** Where agent logs and the instance lock live. */
  runDir: string;
  /** Prompt directories, searched in order, so a driver's own prompts shadow the pipeline's. */
  promptsDirs: string[];
  dryRun: boolean;
  /**
   * The pull master's serial queue. Held here rather than on the module so two contexts in one
   * process never share one; the base branch each guards is not the same branch.
   */
  integrationQueue: Promise<unknown>;
  log: (message: string) => void;
  step: (message: string) => void;
  /** Asked once, just before every merge. Absent means always allowed. */
  mayMerge?: () => Promise<MergePermission>;
  /** Told once, after every confirmed merge. */
  afterMerge?: (event: MergeEvent) => void;
};

export function createContext(options: {
  project: ProjectConfig;
  knobs: Omit<PipelineKnobs, 'seats'>;
  seats: { worker: Seat; reviewer: Seat };
  repoRoot: string;
  invokeRoot: string;
  promptsDirs: string[];
  dryRun: boolean;
  runDir?: string;
  log?: (message: string) => void;
  step?: (message: string) => void;
  mayMerge?: () => Promise<MergePermission>;
  afterMerge?: (event: MergeEvent) => void;
}): Context {
  return {
    project: options.project,
    knobs: options.knobs,
    seats: options.seats,
    repoRoot: options.repoRoot,
    invokeRoot: options.invokeRoot,
    runDir: options.runDir ?? resolve(options.repoRoot, options.project.worktreeRoot, 'runs'),
    promptsDirs: options.promptsDirs,
    dryRun: options.dryRun,
    integrationQueue: Promise.resolve(),
    log: options.log ?? defaultLog,
    step: options.step ?? defaultStep,
    mayMerge: options.mayMerge,
    afterMerge: options.afterMerge,
  };
}

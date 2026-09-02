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

export type Context = {
  /** Everything true of the repository being worked. */
  project: ProjectConfig;
  /** The pipeline's own boundaries. A driver's extra knobs stay with the driver. */
  knobs: { autoMerge: PipelineKnobs['autoMerge']; maxReviewRounds: number };
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
};

export function createContext(options: {
  project: ProjectConfig;
  knobs: { autoMerge: PipelineKnobs['autoMerge']; maxReviewRounds: number };
  seats: { worker: Seat; reviewer: Seat };
  repoRoot: string;
  invokeRoot: string;
  promptsDirs: string[];
  dryRun: boolean;
  runDir?: string;
  log?: (message: string) => void;
  step?: (message: string) => void;
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
  };
}

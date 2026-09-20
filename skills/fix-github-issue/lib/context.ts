/**
 * The context: everything the fix pipeline used to read off module-level globals, gathered into one
 * object that every extracted function takes as its first parameter.
 *
 * One process can hold two of these (a burndown driver and a heartbeat, say), so anything a
 * pipeline must not share between drivers belongs here rather than on a module.
 */

import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { PIPELINE_DEFAULTS, type PipelineKnobs, type ProjectConfig } from './config.ts';
import type { Seat } from './engines.ts';
import { log as defaultLog, step as defaultStep } from './shell.ts';

/** What the pull master tells a driver once a merge is confirmed. */
export type MergeEvent = {
  issue: number;
  title: string;
  pr: number;
  sha: string;
  mergedAt: string;
  paths: string[];
  /**
   * Set when the merge landed on a base this lane never saw: another writer merged between the
   * last look upstream and this merge, so the combination that now sits on the base was never
   * checked by anything. The value is the base commit the merge actually landed on.
   */
  unseenBase?: string;
};

/**
 * A driver's answer to "may this merge now". Resolving `ok` lets the merge proceed; a driver that
 * wants to hold the line waits before resolving, and one that gives up resolves a refusal, which
 * parks the pull request with the reason and spends no review round.
 */
export type MergePermission = { ok: true } | { ok: false; reason: string };

/** What `closeIssue` tells a driver after every close it makes, whichever path made it. */
export type CloseEvent = {
  issue: number;
  kind: 'merged' | 'closed' | 'answered';
  pr?: number;
  mergeSha?: string;
  /** Read back from the issue after the close; the dry run's is the time of the would-be close. */
  closedAt: string;
  reason: string;
  /** Which path made the close; carried on the announcement's marker. */
  by: 'appraiser' | 'worker' | 'knife' | 'reconcile';
};

/**
 * A card moving on the operator's board: the issue, the lane key it enters (`D1`, `F3`; the keys
 * are the burndown's lane table), and a note for the card's reason field. The pipeline raises one
 * at every seam a card visibly passes; a driver without a board leaves the hook unset.
 */
export type LaneEvent = { issue: number; title: string; lane: string; note?: string };

export type Context = {
  /** Everything true of the repository being worked. */
  project: ProjectConfig;
  /** The pipeline's own boundaries. A driver's extra knobs stay with the driver. */
  knobs: Omit<PipelineKnobs, 'seats'>;
  /** The seats the pipeline fills. A driver's other seats are never visible here. */
  seats: { worker: Seat; reviewer: Seat; confirmer?: Seat };
  /** The main checkout. Never an agent's working directory. */
  repoRoot: string;
  /** The checkout the driver was invoked from, which is where the config was read. */
  invokeRoot: string;
  /** Where agent logs and the instance lock live. */
  runDir: string;
  /** Prompt directories, searched in order, so a driver's own prompts shadow the pipeline's. */
  promptsDirs: string[];
  dryRun: boolean;
  /** Every mutation a dry run would have made, in order, so a test can assert a whole flow. */
  dryRunLog: string[];
  /** The GitHub login this run acts as. Markers on the tracker are trusted only from this author. */
  botLogin: string;
  /** Names this process on the tracker: `${hostname}-${pid}-${startMs}`. */
  runId: string;
  /**
   * The pull master's serial queue. Held here rather than on the module so two contexts in one
   * process never share one; the base branch each guards is not the same branch.
   */
  integrationQueue: Promise<unknown>;
  /** The issues in the integration queue, the one landing now first, so a lane that joins can say whom it waits behind. */
  landingLine?: number[];
  log: (message: string) => void;
  step: (message: string) => void;
  /** Asked once, just before every merge. Absent means always allowed. */
  mayMerge?: () => Promise<MergePermission>;
  /** Told once, after every confirmed merge. */
  afterMerge?: (event: MergeEvent) => void;
  /** Awaited by `closeIssue` after every close it makes, dry runs excepted. A throw is logged, never propagated. */
  onClosed?: (event: CloseEvent) => Promise<void>;
  /** Told every time a card should move lanes. Never awaited; a throw is the driver's to catch. */
  onLane?: (event: LaneEvent) => void;
  /** When set, every mutation goes here instead of to gh: a fake tracker under test. */
  io?: { write: (op: { description: string; argv: string[] }) => void; view?: (n: number) => unknown; search?: (q: string) => unknown };
};

/**
 * Reads the authenticated login once. A run with no identity cannot tell its own markers from a
 * person's, so a failure here is a refusal to start, in a dry run too: it is a read.
 */
function readBotLogin(): string {
  const proc = Bun.spawnSync(['gh', 'api', 'user', '--jq', '.login'], { stderr: 'pipe' });
  const login = proc.stdout.toString().trim();
  if (proc.exitCode !== 0 || !login) {
    throw new Error(`cannot read the GitHub login this run acts as (gh api user): ${proc.stderr.toString().trim() || 'empty answer'}`);
  }
  return login;
}

export function createContext(options: {
  project: ProjectConfig;
  /** The newest knobs default, so a driver that predates them still compiles and runs. */
  knobs: Partial<Pick<PipelineKnobs, 'pointScale' | 'maxWorkerAttempts' | 'checks' | 'requiredChecks' | 'idleCheckSuiteApps'>> & Omit<PipelineKnobs, 'seats' | 'pointScale' | 'maxWorkerAttempts' | 'checks' | 'requiredChecks' | 'idleCheckSuiteApps'>;
  seats: { worker: Seat; reviewer: Seat; confirmer?: Seat };
  repoRoot: string;
  invokeRoot: string;
  promptsDirs: string[];
  dryRun: boolean;
  runDir?: string;
  log?: (message: string) => void;
  step?: (message: string) => void;
  mayMerge?: () => Promise<MergePermission>;
  afterMerge?: (event: MergeEvent) => void;
  onClosed?: (event: CloseEvent) => Promise<void>;
  onLane?: (event: LaneEvent) => void;
  /** A test supplies its own; production reads it from gh. */
  botLogin?: string;
  io?: Context['io'];
}): Context {
  return {
    project: options.project,
    knobs: {
      ...options.knobs,
      pointScale: options.knobs.pointScale ?? PIPELINE_DEFAULTS.pointScale,
      maxWorkerAttempts: options.knobs.maxWorkerAttempts ?? PIPELINE_DEFAULTS.maxWorkerAttempts,
      checks: options.knobs.checks ?? PIPELINE_DEFAULTS.checks,
    },
    seats: options.seats,
    repoRoot: options.repoRoot,
    invokeRoot: options.invokeRoot,
    runDir: options.runDir ?? resolve(options.repoRoot, options.project.worktreeRoot, 'runs'),
    promptsDirs: options.promptsDirs,
    dryRun: options.dryRun,
    dryRunLog: [],
    botLogin: options.botLogin ?? readBotLogin(),
    runId: `${hostname()}-${process.pid}-${Date.now()}`,
    integrationQueue: Promise.resolve(),
    log: options.log ?? defaultLog,
    step: options.step ?? defaultStep,
    mayMerge: options.mayMerge,
    afterMerge: options.afterMerge,
    onClosed: options.onClosed,
    onLane: options.onLane,
    io: options.io,
  };
}

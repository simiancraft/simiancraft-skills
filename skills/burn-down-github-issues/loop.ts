/**
 * burn-down-github-issues: a headless loop that triages recent issues, fixes the small ones,
 * proves the work on a PR, and lets a second agent with no shared context decide whether it can
 * merge.
 *
 * One fresh agent process per role, so neither inherits the other's reasoning. The reviewer's
 * isolation is the point: it is the only thing that catches a worker that convinced itself.
 *
 * Issues are worked concurrently, each in its own git worktree. The worktree is what makes that
 * safe: two agents never share a working tree, so a long fix on one issue does not hold up
 * the queue behind it.
 *
 * This file is shared: it ships with the skill and is not copied into a repository. Everything
 * true of a repository lives in `burn-down-github-issues.config.ts` at that repository's root,
 * and the loop refuses to start without it. Run it from inside the target repository:
 *
 *   bun run <skill-dir>/loop.ts --dry-run
 *   bun run <skill-dir>/loop.ts --limit 3
 *   bun run <skill-dir>/loop.ts --worker codex:gpt-5.6-sol --reviewer claude:claude-opus-5
 *
 * Hard dependency: the sibling `prove-work-on-github` skill, shipped alongside this one in
 * simiancraft-skills. Both prompts load it by name, and the staleness rule below implements its
 * references/freshness-and-reproof.md.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentCapMs, children, killAgent } from '../fix-github-issue/lib/agent.ts';
import { invokeRootFrom, loadProjectConfig, parseOnly, repoRootFrom } from '../fix-github-issue/lib/config.ts';
import { createContext } from '../fix-github-issue/lib/context.ts';
import { parseSeat, type Seat, seatLabel } from '../fix-github-issue/lib/engines.ts';
import { closeIssue, ensureLabels, HOLD_LABELS, isHeldBy, repairDurableState, reviewCount } from '../fix-github-issue/lib/labels.ts';
import { claimLock } from '../fix-github-issue/lib/lane.ts';
import { DELIBERATING_LABEL, deliberatingSince, holdInterruptedPanel, PANEL_DEFAULTS, type PanelKnobs, type PanelSetup } from '../fix-github-issue/lib/panel.ts';
import { fixIssue, type Issue, redriveIssue } from '../fix-github-issue/lib/pipeline.ts';
import { pool } from '../fix-github-issue/lib/pool.ts';
import { findStranded, reconcile, resumeStranded } from '../fix-github-issue/lib/resume.ts';
import { isStopping, log, RunStopping, sh, step, stoppableSleep, teeConsole } from '../fix-github-issue/lib/shell.ts';
import { importClosure } from '../fix-github-issue/lib/staleness.ts';
import { appraiseIssue, assertConfirmCloses, recordAppraisalThrow, allOpenIssues, looksLikeTrunk, pointsFromLabels, resolveCallbacksDir, selectForAppraisal } from '../appraise-github-issues/lib/appraise.ts';
import { refusal, trackerIo } from '../carve-github-issue/lib/claims.ts';
import { readTree } from '../carve-github-issue/lib/tree.ts';
import { CARVE_DEFAULTS, type CarveKnobs } from '../carve-github-issue/lib/carve.ts';
import { createBoardWriter, placeByFacts, readBoardPointer } from './lib/board-writer.ts';
import { Carving } from './lib/carving.ts';
import { placeSizeCallbacks as renderSizeCallbacks } from './lib/place-callbacks.ts';
import { issueRefs } from './lib/refs.ts';
import { type FloorConfigInput, resolveFloor } from './lib/floor/config.ts';
import { Floor, FLOOR_PAUSE } from './lib/floor/floor.ts';
import { INCIDENT_LABEL } from './lib/floor/incident.ts';
import { configureStatus, elapsed, lineState, mark, pulse, setLine, stamp, startPulse } from './status.ts';
import { installStopHandler } from '../fix-github-issue/lib/stop.ts';
import { guardCli } from '../fix-github-issue/lib/cli.ts';

// ---------------------------------------------------------------------------
// Defaults. Every boundary the loop enforces is here or in the repository's config file; nothing
// below hard-codes one. Any of these knobs can be overridden by that config file.
// ---------------------------------------------------------------------------

type LoopKnobs = {
  ageDays: number;
  maxPoints: number;
  autoMerge: 'always' | 'code-only' | 'never';
  maxReviewRounds: number;
  checksTimeoutMinutes: number;
  agentTimeoutMinutes?: number | Partial<Record<string, number>>;
  checks: 'required' | 'none';
  requiredChecks?: string[];
  idleCheckSuiteApps?: string[];
  smokeTimeoutMinutes: number;
  pointScale: number[];
  maxWorkerAttempts: number;
  /** How far back merged pull requests are read at startup to close issues a dead run merged. */
  reconciliationDays: number;
  limit: number;
  concurrency: number;
  appraiserConcurrency: number;
  appraiseLimit: number;
  maxAppraiseAttempts: number;
  sizeCallbackTimeoutMinutes: number;
  skipLabels: string[];
  /** Whether a close verdict from the appraiser needs the confirmer's agreement; see appraise-github-issues. */
  confirmCloses: boolean;
  /**
   * Where the loop writes the size callbacks it ships (`callbacks/` beside this file) for the
   * appraiser to look up, and where an adopter may add its own. See the appraise skill's
   * references/callbacks.md for the ladder.
   */
  callbacksDir: string;
  seats: { appraiser: string; confirmer: string; callback: string; worker: string; reviewer: string; walker: string; carver?: string; carveConfirmer?: string };
  /** The knife's knobs; see carve-github-issue/references/adopting.md. */
  carve: typeof CARVE_DEFAULTS;
  /**
   * The decision panel that weighs an agent-raised `needs-decision` before it holds an issue:
   * `seats`, the candidates for the two seats beside the raising seat's, best first (empty means
   * every distinct seat this run fills); `maxPanels` per issue; and the reasoning `effort` every
   * panel turn runs at. Without three distinct models on two engines the hold is applied as before.
   */
  panel: PanelKnobs;
  /**
   * When set, every merge goes up onto the floor, the loop walks the deployed base on a cadence,
   * and a walk that finds it wrong pauses the line until it is right again. See references/floor.md.
   */
  floor?: FloorConfigInput;
};

const DEFAULTS: LoopKnobs = {
  /** Only consider issues opened within this many days. Widen once a run has gone well. */
  ageDays: 30,

  /** Fibonacci points the loop is willing to attempt, on whatever scale PROJECT.sizingScale names. */
  maxPoints: 2,

  /**
   * What the loop may merge once the reviewer approves.
   * 'always':    merge anything approved
   * 'code-only': merge code; park anything touching production data, a migration, a stored string, or CI
   * 'never':     never merge; leave approved PRs for a human
   */
  autoMerge: 'code-only',

  /**
   * Review rounds an issue gets before it is ejected to the dead-letter queue.
   *
   * A per-issue high-water mark, not a per-run allowance: the count is kept on the issue as
   * `loop/reviews: N` and survives restarts, so rounds spent in an earlier run are already spent.
   * This is what prevents an issue-level death spiral, where a change nobody can get right cycles
   * between worker and reviewer indefinitely because each new run starts its counting over.
   */
  maxReviewRounds: 3,

  /** See the fix pipeline's PIPELINE_DEFAULTS for both. */
  checksTimeoutMinutes: 45,
  checks: 'required',
  smokeTimeoutMinutes: 10,

  /** Merged pull requests this recent are checked against open sized issues on start. */
  reconciliationDays: 14,

  /** Issues to process in one run. */
  limit: 5,

  /**
   * Workers running at once. Each gets its own worktree, so two agents never share a working tree
   * and the loop does not wait out a long fix before starting the next issue. That isolation
   * is the whole reason the loop uses worktrees rather than branches in one checkout.
   */
  concurrency: 2,

  /**
   * Appraisers running at once, sized independently of the workers.
   *
   * Appraisal is the lighter job: it reads an issue, its thread, and the code it names, and answers
   * whether the issue is real and how big it is. No worktree, no port, no install, no writes. It is
   * also finite, since a backlog only needs appraising once, so this population empties itself.
   */
  appraiserConcurrency: 3,

  /** Issues to appraise in one run. */
  appraiseLimit: 12,

  /** Failed appraisals an issue may absorb before it goes to `loop/dlq: appraisal`. */
  maxAppraiseAttempts: 3,

  /** How long a size callback may run; 0 means no timer, since the knife runs agents. */
  sizeCallbackTimeoutMinutes: 0,

  /**
   * Labels that take an issue out of the loop's reach until a human removes them. `loop/parked`
   * belongs here: parked means a human owns the next call, and without it a parked issue slid
   * back into selection the moment its pull request closed.
   */
  skipLabels: ['needs-decision', 'needs-human', 'loop/skip', 'loop/parked'],

  /**
   * Who sits in each seat, as an `engine` or `engine:model` spec resolved against the ENGINES
   * registry below. These are the defaults; each is overridable at invocation with `--appraiser`,
   * `--worker`, and `--reviewer`, so trying a new model is a flag rather than an edit.
   *
   * Worker and reviewer are set separately on purpose: running them on different engines means the
   * merge gate does not share the worker's blind spots by construction. The reviewer is the
   * expensive judgement, so it does not get the cheaper seat. An omitted model inherits the
   * engine's own default (for codex, whatever `~/.codex/config.toml` sets), which is the safer
   * choice when unsure: a model the local auth does not support fails the run in seconds.
   */
  confirmCloses: true,

  callbacksDir: '<worktreeRoot>/appraisal-callbacks',

  carve: CARVE_DEFAULTS,

  panel: PANEL_DEFAULTS,

  /** The scale every size is on, and the worker's attempt budget; see fix-github-issue/lib/config.ts. */
  pointScale: [1, 2, 3, 5, 8, 13, 21, 34],
  maxWorkerAttempts: 3,

  seats: {
    appraiser: 'codex:gpt-5.6-sol',
    confirmer: 'claude:claude-opus-5',
    callback: 'codex:gpt-5.6-sol',
    worker: 'codex:gpt-5.6-sol',
    reviewer: 'claude:claude-opus-5',
    walker: 'claude:claude-opus-5',
  },
};

// ---------------------------------------------------------------------------
// The repository's config. The loop ships with the skill, outside any target repository, so the
// invoking directory is the only signal for which repository it serves, and that repository must
// declare itself before anything runs.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
/** The appraisal prompts, shipped with the sibling skill this loop depends on for sizing. */
const APPRAISE_PROMPTS = join(HERE, '..', 'appraise-github-issues', 'prompts');
/** The loop's own prompts: the floor's walk and diagnosis. */
const LOOP_PROMPTS = join(HERE, 'prompts');
/** The fix pipeline's own prompts, shipped with the sibling skill this loop depends on. */
const FIX_PROMPTS = join(HERE, '..', 'fix-github-issue', 'prompts');
/** The knife's prompts: the sweep revisits trunks in process, so the loop renders carve.md and revisit.md itself. */
const CARVE_PROMPTS = join(HERE, '..', 'carve-github-issue', 'prompts');

/**
 * The main checkout of the target repository, resolved from the invoking directory. The loop may
 * be run from a worktree; `--git-common-dir` is the same `.git` for every worktree of a
 * repository, so this answers with the main checkout wherever it is invoked from.
 */
/** Every flag this command reads is named here and in USAGE; a source test holds the three together. */
export const CLI = { flags: ['dry-run', 'no-appraise', 'silent'], options: ['limit', 'only', 'max-points', 'appraise-limit', 'pulse', 'closure', 'issue', 'worker', 'reviewer', 'confirmer', 'appraiser', 'carver', 'carve-confirmer', 'callback-seat', 'walker', 'floor', 'base-url'] } as const;
export const USAGE = `burn-down-github-issues: appraise, carve, work, review, and land a repository's open issues, headless.
Run it from inside the target repository. With no flags it starts a REAL run on the whole window.

  bun run <skill-dir>/loop.ts [flags]

  --dry-run               rehearse: no agent is run and nothing is written; say what would happen
  --limit <n>             work at most n issues this run
  --only <n,n,...>        restrict the run to these issues, in appraisal, selection, and the sweep
  --max-points <n>        the largest size a worker may take on (default: the config's)
  --no-appraise           skip the sizing pass
  --appraise-limit <n>    appraise at most n unsized issues (default: the config's)
  --pulse <minutes>       how often the whole operator board is printed
  --silent                print no operator board
  --closure <file>        print every module the import-closure walk reaches from that file, and exit
  --floor <mode>          walk the floor and work no issue: once, liveness (probe only), watch
                          (on the cadence until Ctrl+C), or drain (until every merge is verified)
  --base-url <url>        walk this URL in place of the floor's configured one
  --worker, --reviewer, --confirmer, --appraiser, --carver, --carve-confirmer, --callback-seat, --walker <seat>
                          engine[:model] for that seat, for example codex:gpt-5.6-sol
  --issue <n>             not accepted here: one issue alone is fix.ts --issue <n>
  --help, -h              print this and exit

Ctrl+C stops the run: its agents are killed, nothing is settled from them, and its claims are released.`;
// Before anything else: an argument this command does not know must never fall through to a real run.
guardCli(process.argv.slice(2), CLI, USAGE);

const REPO_ROOT = repoRootFrom(process.cwd());

/**
 * The config is read from the invoking checkout's own top level, not from REPO_ROOT: when the loop
 * is started from a worktree, the branch checked out there carries the config the operator edited,
 * and the main checkout may hold another branch without one.
 */
const INVOKE_ROOT = invokeRootFrom(process.cwd(), REPO_ROOT);

const CONFIG = await loadProjectConfig<LoopKnobs>({
  invokeRoot: INVOKE_ROOT,
  repoRoot: REPO_ROOT,
  fileName: 'burn-down-github-issues.config.ts',
  defaults: DEFAULTS,
  positiveIntegers: [
    'ageDays',
    'maxPoints',
    'maxReviewRounds',
    'limit',
    'concurrency',
    'appraiserConcurrency',
    'appraiseLimit',
    'checksTimeoutMinutes',
    'smokeTimeoutMinutes',
    'reconciliationDays',
    'maxAppraiseAttempts',
    'maxWorkerAttempts',
    'carve.maxDepth',
    'carve.maxChildren',
    'carve.maxCarveRounds',
    'carve.maxCarveAttempts',
    'carve.maxGenerations',
    'carve.maxRevisitsPerGeneration',
    'panel.maxPanels',
  ],
  nonNegativeIntegers: ['sizeCallbackTimeoutMinutes'],
  blocks: ['carve', 'panel'],
  help: [
    'This loop is shared across repositories; everything true of a repository lives in that file.',
    'Copy the template from references/adopting.md in the burn-down-github-issues skill and fill it in.',
  ],
});

assertConfirmCloses(CONFIG.confirmCloses, 'burn-down-github-issues.config.ts');
const FLOOR_CONFIG = (() => {
  if (!CONFIG.floor) return null;
  const { floor, faults } = resolveFloor(CONFIG.floor);
  if (faults.length > 0) {
    console.error(['config floor is invalid:', ...faults.map((f) => `  - ${f}`)].join('\n'));
    process.exit(1);
  }
  return floor;
})();

const PROJECT = CONFIG.project;
const REMOTE = PROJECT.remote;
const BASE = PROJECT.baseBranch;

const RUN_DIR = resolve(REPO_ROOT, PROJECT.worktreeRoot, 'runs');

// ---------------------------------------------------------------------------
// The line. A file switch anyone can flip stops the loop at its three seams: before the appraisal
// batch, before each issue is dispatched, and inside the pull master before every merge. The
// floor, when configured, pauses it when a walk finds the deployed base wrong and releases its own
// pause once nothing is; a person flips it with `echo pause > <runs>/line-switch`. Absent means
// go; an unknown word means pause.
// ---------------------------------------------------------------------------

const SWITCH_FILE = join(RUN_DIR, 'line-switch');
const FLOOR_DIR = resolve(REPO_ROOT, PROJECT.worktreeRoot, 'floor');
const SWITCH_POLL_MS = 30 * 1000;

function readSwitch(): { state: 'go' | 'pause'; reason: string } {
  if (!existsSync(SWITCH_FILE)) return { state: 'go', reason: '' };
  const [first = '', ...rest] = readFileSync(SWITCH_FILE, 'utf8').split('\n');
  const word = first.trim().toLowerCase();
  return { state: word === 'go' ? 'go' : 'pause', reason: rest.join(' ').trim() || first.trim() };
}

/**
 * Holds until the switch says go. The log gets one line per pause; the operator board gets the
 * elapsed pause on every poll, so a paused line is never mistaken for a quiet one.
 */
async function waitForGo(where: string, passFloorPause = false): Promise<void> {
  let announced = false;
  for (;;) {
    // A paused line holds a card for as long as it takes; a stop ends the hold, and the lane with it.
    if (isStopping()) throw new RunStopping(`the run is stopping; no longer holding ${where}`);
    const sw = readSwitch();
    // An incident's fix is the merge that clears the floor's own pause; a person's pause still holds it.
    if (sw.state === 'go' || (passFloorPause && sw.reason.startsWith(FLOOR_PAUSE))) {
      if (sw.state === 'go') setLine('active');
      if (announced) log(`line is go again; resuming ${where}`);
      return;
    }
    setLine('paused', sw.reason);
    if (!announced) {
      log(`line is paused (${sw.reason || 'no reason given'}); holding ${where} until ${SWITCH_FILE} says go`);
      announced = true;
    } else if (!SILENT) {
      console.log(`⏸️ paused ${elapsed(lineState().since)}  holding ${where}  ⏱ ${stamp()}`);
    }
    await stoppableSleep(SWITCH_POLL_MS);
  }
}

const args = process.argv.slice(2);

const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const DRY_RUN = flag('dry-run');
const FLOOR_MODES = ['once', 'liveness', 'watch', 'drain'] as const;
const FLOOR_MODE = opt('floor') as (typeof FLOOR_MODES)[number] | undefined;
if (FLOOR_MODE !== undefined && !FLOOR_MODES.includes(FLOOR_MODE)) {
  console.error(`--floor expects one of ${FLOOR_MODES.join(', ')}, got '${FLOOR_MODE}'`);
  process.exit(1);
}
// Another URL makes the floor a rehearsal that records nothing, which a real run could never drain.
if (opt('base-url') !== undefined && FLOOR_MODE === undefined) {
  console.error('--base-url rehearses the floor alone; pair it with --floor');
  process.exit(1);
}
/** A count option: a mistyped value must refuse, not become NaN and quietly select nothing. */
function countOption(name: string, fallback: number): number {
  const raw = opt(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.error(`--${name} expects a whole number, got '${raw}'`);
    process.exit(1);
  }
  return parsed;
}
const LIMIT = countOption('limit', CONFIG.limit);
// Per-run ambition knob: a one-off ceiling raise belongs on the command line, not in the durable
// config, whose value is what unattended runs get.
const MAX_POINTS = (() => {
  const raw = opt('max-points');
  if (raw === undefined) return CONFIG.maxPoints;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`--max-points expects a positive integer, got '${raw}'`);
    process.exit(1);
  }
  return parsed;
})();
// One named issue is what the sibling fix skill is; the loop is selection over a backlog.
if (opt('issue') !== undefined) {
  console.error('--issue moved to the fix-github-issue skill: bun run <skill-dir>/fix.ts --issue <n>');
  process.exit(2);
}
const SKIP_APPRAISAL = flag('no-appraise');
/**
 * `--only 12,34`: the run restricts itself to these issues, in appraisal, selection, and the sweep,
 * and lifts the age window for them; every other filter still applies and an exclusion is logged.
 */
const ONLY: Set<number> | null = (() => {
  const raw = opt('only');
  if (raw === undefined) return null;
  try {
    return new Set(parseOnly(raw));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
})();
const APPRAISE_LIMIT = countOption('appraise-limit', CONFIG.appraiseLimit);
const CLOSURE_PROBE = opt('closure');
// Operator feedback is on by default: a board line per issue on every change, the whole board on
// a cadence, and the pause duration on every poll of the switch. `--silent` keeps only the log.
const SILENT = flag('silent');
const PULSE_MINUTES = (() => {
  const raw = opt('pulse');
  if (raw === undefined) return 5;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`--pulse expects minutes as a positive integer, got '${raw}'`);
    process.exit(1);
  }
  return parsed;
})();
configureStatus({ silent: SILENT });

/** Who actually sits in each seat this run: the flag when given, the configured default otherwise. */
const SEATS = (() => {
  try {
    return {
      appraiser: parseSeat(opt('appraiser') ?? CONFIG.seats.appraiser, '--appraiser'),
      confirmer: parseSeat(opt('confirmer') ?? CONFIG.seats.confirmer, '--confirmer'),
      callback: parseSeat(opt('callback-seat') ?? CONFIG.seats.callback, '--callback-seat'),
      worker: parseSeat(opt('worker') ?? CONFIG.seats.worker, '--worker'),
      reviewer: parseSeat(opt('reviewer') ?? CONFIG.seats.reviewer, '--reviewer'),
      walker: parseSeat(opt('walker') ?? CONFIG.seats.walker, '--walker'),
      // The knife's seats resolve after the merge, so an adopter's worker override carries.
      carver: parseSeat(opt('carver') ?? CONFIG.seats.carver ?? CONFIG.seats.worker, '--carver'),
      carveConfirmer: parseSeat(opt('carve-confirmer') ?? CONFIG.seats.carveConfirmer ?? CONFIG.seats.confirmer ?? CONFIG.seats.reviewer, '--carve-confirmer'),
    };
  } catch (error) {
    // A mistyped engine deserves the composed message, not a raw stack trace.
    console.error((error as Error).message);
    process.exit(1);
  }
})();

/**
 * Everything the fix pipeline reads, gathered once. The loop's own concerns (age, appraisal, the
 * appraiser seat) stay here; the pipeline never sees them.
 */
/** The operator's board, when board.ts has run for this repository; every lane move lands on it. */
const BOARD = (() => {
  const pointer = readBoardPointer(REPO_ROOT, PROJECT.worktreeRoot);
  return pointer ? createBoardWriter(pointer, PROJECT.repo, log) : undefined;
})();

/**
 * One placement, two projections: the console board always, and the GitHub board when board.ts
 * has run for this repository and this is not a dry run. Every lane change the driver, the knife,
 * or the fix pipeline makes comes through here, so the two views never disagree.
 */
function place(issue: number, title: string, lane: string, note?: string): void {
  mark(issue, title, lane, note ?? '');
  if (!DRY_RUN) BOARD?.onLane({ issue, title, lane, note });
}

/**
 * Places a card from what the tracker says now, for the moments a driver knows only that
 * something changed under it (an issue that became a trunk, was held, or closed while a turn ran).
 * Guessing a lane from the turn's outcome would show a hold nobody placed.
 */
function placeFromTracker(issue: number, title: string, note: string): void {
  if (DRY_RUN) return;
  try {
    const tree = readTree(ctx, issue, trackerIo(ctx));
    // Every fact the placement reads, from the one tree: holds, another run's claim, a pause
    // above, children, blockers, and the pull requests that name the issue.
    const now = Date.now();
    const foreign = tree.claims.find((c) => !c.released && Date.parse(c.expires) > now && c.runId !== ctx.runId);
    const placed = placeByFacts({
      state: tree.issue.state === 'OPEN' ? 'OPEN' : 'CLOSED',
      labels: tree.issue.labels.map((l) => l.name),
      pulls: pullsNaming(issue),
      points: pointsFromLabels(tree.issue.labels) ?? undefined,
      ceiling: MAX_POINTS,
      blocked: tree.blockers.some((b) => !(b.state === 'CLOSED' && b.stateReason === 'COMPLETED')),
      openChildren: tree.children.some((c) => c.state === 'OPEN'),
      claimedBy: foreign?.runId,
      pausedAbove: tree.ancestors.some((a) => a.labels.includes('loop/paused')),
    });
    place(issue, title, placed.lane, `${note}; ${placed.why}`.slice(0, 120));
  } catch (error) {
    log(`  #${issue} could not be placed from the tracker: ${(error as Error).message.split('\n')[0]}`);
  }
}

/** The open pull requests whose branch names the issue. Throws when the list cannot be read: "unknown" is not "none", and the caller leaves the card where it is. */
function pullsNaming(issue: number): Array<{ number: number; isDraft: boolean; merged: boolean }> {
  const raw = sh(ctx, ['gh', 'pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,isDraft,headRefName']);
  return (JSON.parse(raw) as Array<{ number: number; isDraft: boolean; headRefName: string }>).filter((pr) => pr.headRefName.endsWith(`-${issue}`)).map((pr) => ({ number: pr.number, isDraft: pr.isDraft, merged: false }));
}

/**
 * The decision panel's candidate seats: the configured list, else every distinct seat this run
 * already fills, which are the models the adopter has. A spec that does not parse stops the run.
 */
const PANEL: PanelSetup = (() => {
  const configured = CONFIG.panel.seats ?? [];
  let seats: Seat[];
  try {
    seats = configured.length > 0 ? configured.map((spec, i) => parseSeat(spec, `panel.seats[${i}]`)) : [SEATS.confirmer, SEATS.reviewer, SEATS.worker, SEATS.appraiser, SEATS.carver, SEATS.carveConfirmer];
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  return { seats, maxPanels: CONFIG.panel.maxPanels ?? PANEL_DEFAULTS.maxPanels, effort: CONFIG.panel.effort ?? PANEL_DEFAULTS.effort };
})();

const ctx = createContext({
  project: PROJECT,
  knobs: {
    autoMerge: CONFIG.autoMerge,
    maxReviewRounds: CONFIG.maxReviewRounds,
    checksTimeoutMinutes: CONFIG.checksTimeoutMinutes,
    agentTimeoutMinutes: CONFIG.agentTimeoutMinutes,
    checks: CONFIG.checks,
    requiredChecks: CONFIG.requiredChecks,
    idleCheckSuiteApps: CONFIG.idleCheckSuiteApps,
    smokeTimeoutMinutes: CONFIG.smokeTimeoutMinutes,
    pointScale: CONFIG.pointScale,
    maxWorkerAttempts: CONFIG.maxWorkerAttempts,
  },
  seats: { worker: SEATS.worker, reviewer: SEATS.reviewer, confirmer: SEATS.confirmer },
  onClosed: (event) => CARVING.onClosed(event),
  onLane: (event) => place(event.issue, event.title, event.lane, event.note),
  panel: PANEL,
  repoRoot: REPO_ROOT,
  invokeRoot: INVOKE_ROOT,
  runDir: RUN_DIR,
  promptsDirs: [LOOP_PROMPTS, APPRAISE_PROMPTS, FIX_PROMPTS, CARVE_PROMPTS],
  dryRun: DRY_RUN,
  // An incident's fix is the merge that clears the floor's own pause, so it passes that pause;
  // a person's pause holds it like any other.
  mayMerge: async (issue) => {
    await waitForGo('the merge queue', issue.labels.some((label) => label.name === INCIDENT_LABEL));
    return { ok: true } as const;
  },
  // The pipeline has already placed the card in Merged by the time this fires.
  afterMerge: (event) => FLOOR?.put(event),
});

/**
 * The floor, when configured: merges go up onto it, and walks of the deployed base pause the line
 * when they find it wrong. An incident's fix lands through a pull master of its own. Sharing the
 * lanes' queue would deadlock: a lane waits at the paused gate inside its slot, and the fix that
 * clears the pause would queue behind it. A lane released from that gate looks upstream again
 * before it merges, so the fix that landed meanwhile is caught up like any other.
 */
// A dry run walks only when asked to (`--floor`): it probes and classifies and writes nothing.
const FLOOR: Floor | null =
  FLOOR_CONFIG && (!DRY_RUN || FLOOR_MODE)
    ? new Floor({
        ctx: { ...ctx, integrationQueue: Promise.resolve(), landingLine: [] },
        config: FLOOR_CONFIG,
        dir: FLOOR_DIR,
        switchFile: SWITCH_FILE,
        callbacksDir: resolveCallbacksDir(ctx, CONFIG.callbacksDir),
        seats: { walker: SEATS.walker, callback: SEATS.callback },
        maxPoints: MAX_POINTS,
        log,
        baseUrl: opt('base-url'),
        print: (readout) => console.log(`\n${readout}\n`),
        // A walk that passes is the machine's WALKED event: the card moves to Verified on the floor.
        onWalked: (item, entry, incident) => {
          if (!item.ref?.issue) return;
          if (entry.verdict === 'present' || entry.verdict === 'intact') place(item.ref.issue, item.text, 'T3', `${entry.verdict} by ${entry.rung}`);
          else if (entry.verdict === 'absent') place(item.ref.issue, item.text, 'T1', `floor: absent${incident ? `; incident #${incident}` : ''}`);
        },
      })
    : null;

/** The knife, as the loop runs it: the loop's ceiling, the config's carve block, the resolved seats. */
const CARVE_KNOBS: CarveKnobs = {
  ceiling: MAX_POINTS,
  ...CONFIG.carve,
  callbacksDir: resolveCallbacksDir(ctx, CONFIG.callbacksDir),
  seats: { carver: SEATS.carver, confirmer: SEATS.carveConfirmer },
};
// The size callback runs the knife in its own process; it inherits the seats this run chose.
process.env.LOOP_CARVER = seatLabel(SEATS.carver);
process.env.LOOP_CARVE_CONFIRMER = seatLabel(SEATS.carveConfirmer);

const CARVING = new Carving({
  ctx,
  knobs: CARVE_KNOBS,
  appraisal: {
    seats: { appraiser: SEATS.appraiser, confirmer: SEATS.confirmer },
    confirmCloses: CONFIG.confirmCloses,
    skipLabels: CONFIG.skipLabels,
    maxAppraiseAttempts: CONFIG.maxAppraiseAttempts,
    sizeCallbackTimeoutMinutes: CONFIG.sizeCallbackTimeoutMinutes,
  },
  only: ONLY,
  ageDays: CONFIG.ageDays,
  mark: place,
  log,
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function allIssues(): Issue[] {
  return allOpenIssues(ctx);
}

/** Labels under which an issue is a trunk, a claimed issue, or a paused leaf: never a worker's. */
const NOT_A_LEAF = ['loop/carved', 'loop/released', 'loop/carving', 'loop/working', 'loop/paused'];

function notALeafLabel(issue: Issue): string | null {
  return issue.labels.map((l) => l.name).find((name) => NOT_A_LEAF.includes(name) || name.startsWith('loop/carve-gen')) ?? null;
}

/**
 * A merge the pull master landed but never recorded: the process died between `gh pr merge` and
 * the issue close, so the issue is still open and sized and would be fixed a second time. Merged
 * pull requests that reference an open, unheld, sized issue close it with a pointer, and the merge
 * goes on the floor as it would have. Runs under the lock before anything is selected.
 */
type Merged = {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  mergedAt: string;
  mergeCommit: { oid: string } | null;
  files: Array<{ path: string }>;
};

/** Pull requests merged into the base within the reconciliation window, read once per run. */
const mergedPullRequests = (() => {
  let cached: Merged[] | null = null;
  return (): Merged[] => {
    if (cached) return cached;
    const since = new Date(Date.now() - CONFIG.reconciliationDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    cached = JSON.parse(
      sh(ctx, [
        'gh',
        'pr',
        'list',
        '--state',
        'merged',
        '--base',
        BASE,
        '--limit',
        '500',
        '--search',
        `merged:>=${since}`,
        '--json',
        'number,title,body,headRefName,mergedAt,mergeCommit,files',
      ]),
    ) as Merged[];
    return cached;
  };
})();

async function reconcileMergedPullRequests(all: Issue[]): Promise<void> {
  let merged: Merged[];
  try {
    merged = mergedPullRequests();
  } catch (error) {
    log(`could not list merged pull requests: ${(error as Error).message}; skipping merge reconciliation`);
    return;
  }
  const open = new Map(all.map((issue) => [issue.number, issue]));
  const io = trackerIo(ctx);
  for (const pr of merged) {
    // Only a closing keyword counts: a merged pull request that mentions an issue did not
    // necessarily resolve it, and closing a trunk or a held leaf by reconciliation is a wrong close.
    for (const ref of new Set(issueRefs([pr], 'closing'))) {
      const issue = open.get(ref);
      if (!issue) continue;
      if (isHeldBy(issue.labels, CONFIG.skipLabels) || issue.labels.some((l) => HOLD_LABELS.includes(l.name))) continue;
      if (notALeafLabel(issue) || looksLikeTrunk(issue)) continue;
      if ((issue.blockedBy?.nodes ?? []).some((b) => !(b.state === 'CLOSED' && b.stateReason === 'COMPLETED'))) continue;
      if (pointsFromLabels(issue.labels) === null) continue; // an unsized issue was never the loop's merge
      // Immediately before the close, once more against the live issue.
      if (!DRY_RUN) {
        const tree = threadOf(issue.number);
        if (!tree) continue;
        const why = refusal(tree, MAX_POINTS);
        if (why) {
          log(`repair: #${issue.number} is referenced by merged PR #${pr.number} but is not closed, because ${why}`);
          continue;
        }
      }
      log(`repair: #${issue.number} is open but PR #${pr.number} merged at ${pr.mergedAt} closes it; closing with a pointer`);
      await closeIssue(ctx, issue.number, `Resolved by #${pr.number}, merged at ${pr.mergedAt}. The run that merged it did not finish recording the close.`, {
        kind: 'merged',
        pr: pr.number,
        mergeSha: pr.mergeCommit?.oid,
        reason: `merged #${pr.number} by reconciliation`,
        by: 'reconcile',
      });
      place(issue.number, issue.title, 'T1', `PR #${pr.number} ${(pr.mergeCommit?.oid ?? '').slice(0, 10)} (recovered)`);
      if (!DRY_RUN && pr.mergeCommit) {
        FLOOR?.put({ issue: issue.number, title: pr.title, pr: pr.number, sha: pr.mergeCommit.oid, mergedAt: pr.mergedAt, paths: pr.files.map((f) => f.path) });
      }
      open.delete(ref);
    }
  }
}

/** Where the facts put every issue in the window: the queue the run dispatches from. */
type Placement = Map<number, { lane: string; why: string; issue: Issue; pull?: { number: number; branch: string; author: string } }>;

/**
 * The machine's `reconcile` for every card at once: the run start puts each issue in the window,
 * and each card already on the board, where its facts say (references/state-machine.md,
 * "Reconcile"). The placement is the queue: the appraisers take the inbox, the workers take
 * Ready, and nothing is selected by re-reading labels a second way. With a board, the cards whose
 * lane differs are written, straight to the board rather than the console, so a large backlog
 * costs one read and a line per move. An issue another run holds is left where it is; the sweep
 * has already cleared dead claims.
 */
async function placeBacklog(all: Issue[]): Promise<Placement> {
  const placement: Placement = new Map();
  let cards = new Map<number, { lane?: { key: string; phase: string }; state: 'OPEN' | 'CLOSED'; labels: string[] }>();
  if (BOARD) {
    try {
      cards = BOARD.snapshot();
    } catch (error) {
      log(`board: could not read the cards: ${(error as Error).message}; the placement is computed but not written`);
    }
  }
  const cutoff = Date.now() - CONFIG.ageDays * 24 * 60 * 60 * 1000;
  const inWindow = (issue: Issue) => (ONLY ? ONLY.has(issue.number) : Boolean(issue.parent) || Date.parse(issue.createdAt) >= cutoff || cards.has(issue.number));
  type Pull = { number: number; isDraft: boolean; body: string; title: string; headRefName: string; author?: { login?: string } };
  const openPulls = JSON.parse(sh(ctx, ['gh', 'pr', 'list', '--state', 'open', '--limit', '5000', '--json', 'number,isDraft,body,title,headRefName,author'])) as Pull[];
  const owning = (pulls: Array<Pull | Merged>, issue: number) => pulls.filter((pr) => issueRefs([pr], 'owning').includes(issue));
  let moved = 0;
  let kept = 0;
  const settle = (issue: number, title: string, lane: string, why: string) => {
    const current = cards.get(issue)?.lane?.key;
    if (current === lane) {
      kept += 1;
      return;
    }
    moved += 1;
    const note = `${current ? `was ${current}; ` : ''}${why}`;
    if (DRY_RUN) log(`DRY RUN  would place #${issue} in ${lane} (${note})`);
    else BOARD?.onLane({ issue, title, lane, note });
  };

  const open = new Set<number>();
  for (const issue of all) {
    if (!inWindow(issue)) continue;
    open.add(issue.number);
    const labels = issue.labels.map((l) => l.name);
    if (labels.includes('loop/working') || labels.includes('loop/carving')) {
      placement.set(issue.number, { lane: cards.get(issue.number)?.lane?.key ?? 'W3', why: `it carries ${labels.includes('loop/working') ? 'loop/working' : 'loop/carving'}`, issue });
      kept += 1;
      continue;
    }
    const mine = owning(openPulls, issue.number) as Pull[];
    const placed = placeByFacts({
      state: 'OPEN',
      labels,
      pulls: mine.map((pr) => ({ number: pr.number, isDraft: pr.isDraft, merged: false })),
      points: pointsFromLabels(issue.labels) ?? undefined,
      ceiling: MAX_POINTS,
      blocked: (issue.blockedBy?.nodes ?? []).some((b) => !(b.state === 'CLOSED' && b.stateReason === 'COMPLETED')),
      openChildren: looksLikeTrunk(issue),
    });
    placement.set(issue.number, { ...placed, issue, pull: mine[0] ? { number: mine[0].number, branch: mine[0].headRefName, author: mine[0].author?.login ?? '' } : undefined });
    if (BOARD) settle(issue.number, issue.title, placed.lane, placed.why);
  }
  const byLane = new Map<string, number>();
  for (const { lane } of placement.values()) byLane.set(lane, (byLane.get(lane) ?? 0) + 1);
  log(`backlog by lane: ${[...byLane.entries()].sort().map(([lane, n]) => `${lane} ${n}`).join(', ') || 'nothing in the window'}`);
  if (!BOARD) return placement;
  // A card whose issue closed since it was placed: merged by a pull request that owns it, or closed without code.
  let merged: Merged[] = [];
  try {
    merged = mergedPullRequests();
  } catch (error) {
    log(`board: could not list merged pull requests: ${(error as Error).message}; closed cards keep their lane`);
  }
  for (const [number, card] of cards) {
    if (open.has(number) || card.state !== 'CLOSED' || card.lane?.phase === 'terminal') continue;
    const placed = placeByFacts({
      state: 'CLOSED',
      labels: card.labels,
      pulls: owning(merged, number).map((pr) => ({ number: pr.number, isDraft: false, merged: true })),
      ceiling: MAX_POINTS,
    });
    settle(number, '', placed.lane, placed.why);
  }
  log(`board: ${moved} card(s) ${DRY_RUN ? 'would be ' : ''}placed by their facts, ${kept} already where the facts put them`);
  return placement;
}

/**
 * Work that already has a pull request and nobody driving it: a card the facts put in Drafted or
 * Ready for review whose lane is gone (a park or a dead letter a person lifted, a run on another
 * machine that died). The stranded path resumes only what still has a local worktree; without
 * this the card would sit in Review forever, since the workers take only Ready. Limited to pull
 * requests the loop itself worked, which its claim markers on the thread show: a person's own
 * branch that happens to name the issue is theirs.
 */
function selectResumable(placement: Placement): Array<{ issue: Issue; pull: { number: number; branch: string } }> {
  const io = trackerIo(ctx);
  const out: Array<{ issue: Issue; pull: { number: number; branch: string } }> = [];
  for (const { lane, issue, pull } of placement.values()) {
    if ((lane !== 'E1' && lane !== 'D3') || !pull) continue;
    // Ownership is the pull request's, not the issue's: the loop once working an issue does not
    // make a person's later branch for it the loop's to resume. The loop's own pull requests are
    // opened by its login on a branch that ends in the issue number.
    if (pull.author !== ctx.botLogin || !pull.branch.endsWith(`-${issue.number}`)) {
      log(`  #${issue.number} has PR #${pull.number} by ${pull.author || 'an unknown author'} on ${pull.branch}, which is not the loop's; left to its author`);
      continue;
    }
    const tree = threadOf(issue.number);
    if (!tree) continue;
    if (!tree.claims.some((c) => c.kind === 'working')) {
      log(`  #${issue.number} has PR #${pull.number} but the loop never worked it; left to its author`);
      continue;
    }
    const why = refusal(tree, MAX_POINTS);
    if (why) {
      log(`  #${issue.number} PR #${pull.number} not resumed: ${why}`);
      continue;
    }
    out.push({ issue, pull });
  }
  return out;
}

/**
 * The newest reason the loop itself left on the thread for stopping this pull request, which is
 * the brief a redriven worker gets. Bound to the work in hand: only the loop's own comments, and
 * only those written after this pull request was opened, since an issue's thread also holds the
 * stops of earlier attempts that this pull request never met. Null when the loop never stopped
 * this work: it only lost its driver, and it is resumed from Proving with no objection to answer.
 * A thread that cannot be read throws: "unknown" is neither an objection nor the absence of one.
 */
function lastObjection(issue: number, pull: number): string | null {
  const opened = sh(ctx, ['gh', 'pr', 'view', String(pull), '--json', 'createdAt', '--jq', '.createdAt']).trim();
  if (!opened) throw new Error(`pull request #${pull} has no creation time`);
  const raw = sh(ctx, [
    'gh', 'issue', 'view', String(issue), '--json', 'comments', '--jq',
    `[.comments[] | select(.author.login == "${ctx.botLogin}") | select(.createdAt > "${opened}") | select(.body | test("dead-letter queue|parked|Parked"))] | last | .body // ""`,
  ]);
  return raw.trim() || null;
}

/**
 * The workers' queue is the Ready lane: every issue the placement put in B1 (sized within the
 * band, unheld, no pull request, not a trunk, not blocked, not paused), less any the tree refuses
 * (a pause above, an edge in a carving record) and any at its review cap. Every other lane is
 * another seat's: the inbox is the appraisers', To carve is the knife's, the human and dead-letter
 * lanes wait for a person. A trunk's leaves are worked in the order its newest carving record
 * says, grouped where the trunk's newest leaf would have sat; the rest stays newest-first.
 */
function selectCandidates(placement: Placement): Issue[] {
  const io = trackerIo(ctx);
  const orderIn = new Map<number, Map<number, number>>();
  const exclude = (issue: Issue, rule: string): false => {
    log(`  #${issue.number} not selected: ${rule}`);
    return false;
  };

  const kept = [...placement.values()]
    .filter(({ lane, why, issue }) => {
      if (lane !== 'B1') return ONLY ? exclude(issue, `it is in ${lane} (${why})`) : false;
      if (reviewCount(issue.labels) >= CONFIG.maxReviewRounds) return exclude(issue, 'its review budget is spent');
      // Ancestors and blockers need the thread: a pause above, an edge on the tracker or in a record.
      if (issue.parent || (issue.blockedBy?.nodes.length ?? 0) > 0) {
        const tree = threadOf(issue.number);
        if (!tree) return exclude(issue, 'its thread could not be read');
        const why2 = refusal(tree, MAX_POINTS);
        if (why2) return exclude(issue, why2);
        const trunk = tree.ancestors[0];
        if (trunk?.record) {
          const orders = orderIn.get(trunk.number) ?? new Map<number, number>();
          for (const child of trunk.record.children) if (child.number !== null) orders.set(child.number, child.order);
          orderIn.set(trunk.number, orders);
        }
      }
      return true;
    })
    .map(({ issue }) => issue);

  if (ONLY) {
    for (const n of ONLY) if (!placement.has(n)) log(`  #${n} is not an open issue`);
  }

  // Newest first, with each trunk's leaves grouped at the position of the group's newest member and
  // ordered within the group by the record (a leaf the record does not know sorts by number).
  const newestFirst = [...kept].sort((a, b) => b.number - a.number);
  const emitted = new Set<number>();
  const out: Issue[] = [];
  for (const issue of newestFirst) {
    if (emitted.has(issue.number)) continue;
    const parent = issue.parent?.number ?? null;
    if (parent === null) {
      out.push(issue);
      emitted.add(issue.number);
      continue;
    }
    const orders = orderIn.get(parent) ?? new Map<number, number>();
    const group = newestFirst
      .filter((i) => i.parent?.number === parent)
      .sort((a, b) => (orders.get(a.number) ?? Number.POSITIVE_INFINITY) - (orders.get(b.number) ?? Number.POSITIVE_INFINITY) || a.number - b.number);
    for (const member of group) {
      out.push(member);
      emitted.add(member.number);
    }
  }
  return out;
}

/**
 * One issue's thread, or null when it cannot be read: a rate limit on one read costs that issue
 * this pass, never the run. A stop is not a read failure and still propagates.
 */
function threadOf(issue: number): ReturnType<typeof readTree> | null {
  try {
    return readTree(ctx, issue, trackerIo(ctx));
  } catch (error) {
    if (error instanceof RunStopping || isStopping()) throw error;
    log(`  #${issue} could not read its thread (${(error as Error).message.split('\n')[0]}); skipped this pass`);
    return null;
  }
}

/**
 * Issue numbers already referenced by an open pull request, so the loop never opens a second one.
 *
 * Only `#1234` in the title or body, and a trailing `-1234` on the branch name, count as a claim. A
 * bare number is not a reference: proof bodies are full of them, and matching those would let a
 * receipt reading "1,234 packages" claim issue 1234 and silently drop it from selection.
 */
function openPullRequestIssueRefs(): number[] {
  const raw = sh(ctx, ['gh', 'pr', 'list', '--state', 'open', '--limit', '5000', '--json', 'body,title,headRefName']);
  return issueRefs(JSON.parse(raw), 'owning');
}

let SKIP_APPRAISAL_THIS_RUN = false;

/** The size callbacks this loop ships, copied into the callbacks directory on every start so the appraiser finds them. */
const SHIPPED_CALLBACKS = join(HERE, 'callbacks');

/**
 * Writes the loop's size callbacks where the appraiser looks. Shipped files are overwritten so a
 * skill update reaches the adopter; any file the adopter added under another name (the floor's
 * `on-walk` and `on-walk-fail` among them) is left alone. Returns the directory.
 */
function placeSizeCallbacks(): string {
  const dir = resolveCallbacksDir(ctx, CONFIG.callbacksDir);
  const template = readFileSync(join(SHIPPED_CALLBACKS, 'on-size-over-ceiling'), 'utf8');
  renderSizeCallbacks(dir, template, { repoRoot: REPO_ROOT, carveDir: join(HERE, '..', 'carve-github-issue'), maxPoints: MAX_POINTS }, log, DRY_RUN);
  return dir;
}

/** The sizing stage: fetch the base ref, take the inbox lane, appraise it through the sibling skill. */
async function sizeTheWindow(placement: Placement): Promise<void> {
  // Appraisers judge "already in the base" against the fetched base ref, not the main checkout's
  // working state, which may be stale, dirty, or on another branch; give them a fresh ref.
  if (!DRY_RUN) sh(ctx, ['git', 'fetch', REMOTE, BASE]);
  const callbacksDir = placeSizeCallbacks();
  log(`size callbacks in ${callbacksDir}`);
  // The appraisers' queue is the inbox lane; the appraise skill's own filter runs over it too, so
  // its contract (the window, the holds, the trunks) is honoured by the same code its command uses.
  const inbox = [...placement.values()].filter(({ lane }) => lane === 'A1').map(({ issue }) => issue);
  const toAppraise = selectForAppraisal(inbox, CONFIG, { allAges: ONLY !== null }).slice(0, APPRAISE_LIMIT);
  if (toAppraise.length === 0) {
    log('nothing to appraise; the window is fully sized');
  } else {
    step(`Appraising ${toAppraise.length} issue(s), ${CONFIG.appraiserConcurrency} at a time`);
    log(toAppraise.map((i) => `#${i.number}`).join(', '));
    await pool(
      toAppraise,
      CONFIG.appraiserConcurrency,
      async (issue) => {
        place(issue.number, issue.title, 'A2');
        let outcome: Awaited<ReturnType<typeof appraiseIssue>>;
        try {
          outcome = await appraiseIssue(ctx, issue, {
            ageDays: CONFIG.ageDays,
            seats: { appraiser: SEATS.appraiser, confirmer: SEATS.confirmer },
            confirmCloses: CONFIG.confirmCloses,
            skipLabels: CONFIG.skipLabels,
            maxAppraiseAttempts: CONFIG.maxAppraiseAttempts,
            sizeCallbackTimeoutMinutes: CONFIG.sizeCallbackTimeoutMinutes,
            callbacks: { dir: callbacksDir, seat: SEATS.callback },
          });
        } catch (error) {
          // A lane that threw is a failed appraisal: counted, a dead letter at the cap, and the
          // card says which. Never left saying Appraising, and never an uncounted retry.
          try {
            const counted = recordAppraisalThrow(ctx, issue, CONFIG.maxAppraiseAttempts, error as Error, (m) => log(`#${issue.number}  ${m}`));
            place(issue.number, issue.title, counted.deadLetter ? 'Q1' : 'A1', counted.reason.slice(0, 120));
          } catch (second) {
            log(`#${issue.number}  could not record the failed appraisal: ${(second as Error).message.split('\n')[0]}`);
            place(issue.number, issue.title, 'A1', `appraiser threw: ${(error as Error).message}`.slice(0, 120));
          }
          throw error;
        }
        // An appraisal that stopped because the issue changed under it (held, closed, claimed,
        // became a trunk) has no lane of its own to report: the tracker says where the card is.
        // A callback is another driver: the knife, usually, which carves, hands off, or fails, and
        // writes what it did to the tracker. Nothing here can name the lane that left behind, so
        // the tracker is asked, as for any other issue that changed under this appraisal.
        if (outcome.changed || outcome.callback?.executable !== undefined || (outcome.verdict === 'failed' && !outcome.retry && !outcome.deadLetter)) {
          placeFromTracker(issue.number, issue.title, outcome.callback?.executable ? `${outcome.reason}; ${outcome.callback.name} ran` : outcome.reason);
          return;
        }
        // `retry` means nothing changed on the issue and the next run tries again; the card
        // says so rather than claiming a size or a hand-off that never landed.
        const note = outcome.retry
          ? outcome.reason
          : outcome.points
            ? `${outcome.verdict}, ${outcome.points} points${outcome.callback?.name ? `, ${outcome.callback.name}` : ''}`
            : outcome.close
              ? `${outcome.verdict}, close ${outcome.close}`
              : outcome.verdict;
        // The card follows the appraisal: sized within the ceiling is Ready, over it is To carve,
        // a confirmed close is Closed without code, a hand-off is its human lane, a retry is Inbox,
        // and a question a decision panel settled goes back to the Inbox to be sized again.
        const lane = outcome.deadLetter
          ? 'Q1'
          : outcome.retry || outcome.panel === 'proceed'
            ? 'A1'
          : outcome.verdict === 'valid'
            ? (outcome.points ?? 0) > MAX_POINTS
              ? 'C1'
              : 'B1'
            : outcome.close === 'confirmed' || outcome.close === 'skipped'
              ? 'T2'
              : outcome.verdict === 'needs-decision'
                ? 'H1'
                : 'H2';
        place(issue.number, issue.title, lane, note.slice(0, 120));
      },
      (issue) => `#${issue.number}`,
    );
  }

}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // A read-only probe of the import-closure walk, for verifying a port's `pathAliases` before any
  // agent runs. A closure of one module (only the entry) means aliases resolve nothing, which is
  // the silent failure that degrades staleness to filename comparison.
  if (CLOSURE_PROBE) {
    // Scan the invoking checkout, not the main one: from a linked worktree the two can hold
    // different branches, and the probe must inspect the tree the config under test describes.
    const closure = importClosure(ctx, INVOKE_ROOT, [CLOSURE_PROBE]);
    for (const file of [...closure].sort()) console.log(file);
    log(`${closure.size} module(s) reachable from ${CLOSURE_PROBE}`);
    return;
  }

  // Every run appends to runs/driver.log, which is what `watch.ts` follows; stdout is still
  // whatever the operator pointed it at. The header names the pid so a reader can tell runs apart.
  teeConsole(join(RUN_DIR, 'driver.log'));
  step(`${PROJECT.name} burn-down-github-issues`);
  log(`run pid ${process.pid} started ${new Date().toISOString()}`);
  log(`base ${BASE} | last ${CONFIG.ageDays} days | up to ${MAX_POINTS} points | merge: ${CONFIG.autoMerge}`);
  log(`appraiser ${seatLabel(SEATS.appraiser)} | confirmer ${seatLabel(SEATS.confirmer)} | worker ${seatLabel(SEATS.worker)} | reviewer ${seatLabel(SEATS.reviewer)} | carver ${seatLabel(SEATS.carver)} | carve confirmer ${seatLabel(SEATS.carveConfirmer)}`);
  if (SEATS.worker.engine === SEATS.reviewer.engine) {
    log('WARNING: worker and reviewer share an engine, so the merge gate shares the author\'s blind spots');
  }
  // Pairs the stages refuse issue by issue, refused once here instead of failing every issue.
  const sharedEngines = [
    CONFIG.confirmCloses && SEATS.appraiser.engine === SEATS.confirmer.engine ? 'appraiser and confirmer' : null,
    SEATS.carver.engine === SEATS.carveConfirmer.engine ? 'carver and carve confirmer' : null,
    SEATS.worker.engine === SEATS.confirmer.engine ? 'worker and confirmer' : null,
  ].filter(Boolean);
  if (sharedEngines.length > 0) {
    console.error(`these seats must be different engines: ${sharedEngines.join('; ')}`);
    process.exit(2);
  }
  if (DRY_RUN) log('DRY RUN: no GitHub mutation and no agent will run');

  let releaseLock: () => void;
  try {
    releaseLock = claimLock(ctx, 'loop.lock');
  } catch (error) {
    log((error as Error).message);
    process.exitCode = 1;
    return;
  }
  // A polite kill should leave nothing behind: release the lock and take the agents with it. Only
  // SIGKILL can still leave wreckage, which is what `reconcile` exists to clear on the next run.
  // The run is done when its merges are verified on the floor too, so the floor drains under the
  // lock: a second run never walks the same floor at the same time.
  const finish = async () => {
    if (FLOOR) {
      step('Walking the floor until this run\'s merges are verified');
      await FLOOR.drain('run');
    }
    step('done');
    pulse('final');
    stopPulse();
    releaseLock();
  };
  const stopPulse = startPulse(PULSE_MINUTES);
  if (!SILENT) log(`operator board: a line per issue on every change, the whole board every ${PULSE_MINUTES} minute(s); --silent turns it off`);
  process.on('exit', () => {
    stopPulse();
    FLOOR?.stop();
    releaseLock();
  });
  installStopHandler(log, async () => {
    FLOOR?.stop();
    releaseLock();
  });
  if (FLOOR_MODE) {
    process.exitCode = await walkTheFloorOnly(FLOOR_MODE);
    releaseLock();
    return;
  }
  // The floor starts before the stranded resume: a resumed landing waits at the gate on a floor
  // pause an earlier run left, and only a walk can clear it. An incident a crashed lane was fixing
  // is still open, so the first walk leaves it to the resume rather than working it twice.
  FLOOR?.start();

  ensureLabels(ctx);
  if (!DRY_RUN) {
    reconcile(ctx, new Set(openPullRequestIssueRefs()));

    // Half-written label transitions are repaired before anything reads them, so a crash mid-DLQ
    // or mid-count-swap costs one repair pass rather than a permanently wedged issue.
    repairDurableState(ctx, allIssues(), CONFIG.skipLabels, {
      reviews: CONFIG.maxReviewRounds,
      attempts: CONFIG.maxWorkerAttempts,
      appraisals: CONFIG.maxAppraiseAttempts,
      carves: CONFIG.carve.maxCarveAttempts,
    });
    await reconcileMergedPullRequests(allIssues());

    // A decision panel runs inside the process that raised its question, so a label older than
    // any panel's turns belongs to a run that died: its question is held with the reviews posted.
    // An age that cannot be read is not an old one; that card waits for the next run.
    const panelStaleMs = 3 * agentCapMs(ctx, 'panelist') + 15 * 60_000;
    for (const issue of allIssues()) {
      if ((ONLY && !ONLY.has(issue.number)) || !issue.labels.some((label) => label.name === DELIBERATING_LABEL)) continue;
      const since = deliberatingSince(ctx, issue.number);
      if (since === null || Date.now() - since < panelStaleMs) continue;
      log(`  #${issue.number}  its decision review was interrupted; held for a person`);
      holdInterruptedPanel(ctx, issue.number);
      place(issue.number, issue.title, 'H1', 'decision review interrupted');
    }

    // Resume before selecting anything new: a stranded pull request is finished work, and landing
    // it first also moves the base before fresh lanes cut their branches from it. Re-read the
    // issues rather than reusing the repair pass's snapshot; the repair may have moved labels.
    // `--only` bounds resumption too: a run restricted to #12 must not land a stranded #34.
    const stranded = findStranded(ctx, allIssues().filter((issue) => !ONLY || ONLY.has(issue.number)), CONFIG.skipLabels);
    for (const entry of stranded) place(entry.issue.number, entry.issue.title, 'E1', `resumed PR #${entry.result.pr}`);
    await resumeStranded(
      ctx,
      stranded,
      CONFIG.concurrency,
      MAX_POINTS,
    );
  }

  // The sweep: finish what a crash left announced, repair torn claims and pauses, and hand the
  // knife every trunk the tracker says needs it, so closes, edits, and holds made outside the loop
  // are seen before anything new is selected.
  // Every seat reads the base as it is now: the knife and the appraisers judge against the
  // fetched ref, and the lanes below are cut from it.
  if (!DRY_RUN) sh(ctx, ['git', 'fetch', REMOTE, BASE]);

  step('Sweeping trunks, claims, and pauses');
  await CARVING.sweep(allIssues());

  // Every card where its facts put it, before any lane moves one: the board is resumed from, so it
  // has to be right at the start of a run, not only after the run has touched a card. The
  // placement is also the queue every seat below takes from.
  let placement = await placeBacklog(allIssues());

  // Appraisal first, and on its own timeline. Workers only ever pick up something already judged
  // real and sized, so the expensive population never pays for a worktree to discover an issue was
  // already fixed. This queue drains: once the window is appraised there is nothing here to do.
  if (!SKIP_APPRAISAL) {
    await waitForGo('appraisal');
    // The same lock the standalone appraiser holds, so a heartbeat and a burndown never size the
    // same issue at once. Held only around the sizing stage; the lanes hold loop.lock.
    let releaseAppraisal: () => void;
    try {
      releaseAppraisal = claimLock(ctx, 'appraise.lock');
    } catch (error) {
      log(`${(error as Error).message}; skipping the sizing stage this run`);
      releaseAppraisal = () => {};
      SKIP_APPRAISAL_THIS_RUN = true;
    }
    try {
      if (!SKIP_APPRAISAL_THIS_RUN) await sizeTheWindow(placement);
    } finally {
      releaseAppraisal();
    }
  }

  // Placed again rather than reused: the appraisal above has just changed the labels the
  // placement depends on, and a worker must see them.
  if (!SKIP_APPRAISAL && !SKIP_APPRAISAL_THIS_RUN) placement = await placeBacklog(allIssues());
  // Finished work first: a pull request waiting for a driver lands before anything new starts,
  // which also moves the base before fresh lanes are cut from it.
  const stranded = DRY_RUN ? [] : selectResumable(placement);
  const resumable = stranded.slice(0, LIMIT);
  for (const { issue, pull } of stranded.slice(LIMIT)) log(`  #${issue.number} not resumed: over this run's limit of ${LIMIT} (PR #${pull.number}; --limit raises it)`);
  const ready = selectCandidates(placement);
  const room = Math.max(0, LIMIT - resumable.length);
  const candidates = ready.slice(0, room);
  // An issue left out by the limit is Ready, not held: say so, or it reads as silently skipped.
  for (const issue of ready.slice(room)) log(`  #${issue.number} not selected: over this run's limit of ${LIMIT} (--limit raises it)`);
  if (resumable.length > 0) {
    step(`Resuming ${resumable.length} pull request(s) with no driver`);
    log(resumable.map((r) => `#${r.issue.number} (PR #${r.pull.number})`).join(', '));
    await pool(
      resumable,
      CONFIG.concurrency,
      async ({ issue, pull }) => {
        await waitForGo(`#${issue.number}`);
        let objection: string | null;
        try {
          objection = lastObjection(issue.number, pull.number);
        } catch (error) {
          log(`#${issue.number}  PR #${pull.number} not resumed this run: its thread could not be read (${(error as Error).message.split('\n')[0]})`);
          return;
        }
        const result = await redriveIssue(ctx, issue, pull, objection, { maxPoints: MAX_POINTS, ceiling: MAX_POINTS, confirmer: SEATS.confirmer });
        if (result.outcome === 'busy') place(issue.number, issue.title, 'W3', result.reason.slice(0, 120));
      },
      ({ issue }) => `#${issue.number}`,
    );
  }
  if (candidates.length === 0 && resumable.length === 0) {
    log('nothing in Ready; the backlog by lane above says where the window is (widen CONFIG.ageDays, raise --max-points, or clear a hold)');
    await finish();
    return;
  }
  if (candidates.length === 0) {
    await finish();
    return;
  }

  step(`Working ${candidates.length} issue(s), ${Math.min(CONFIG.concurrency, candidates.length)} at a time`);
  log(candidates.map((i) => `#${i.number}`).join(', '));
  await pool(
    candidates,
    CONFIG.concurrency,
    async (issue) => {
      await waitForGo(`#${issue.number}`);
      // The pipeline places the card at every seam from Coding on; the two ways it can decline to
      // start are placed here, since no lane of its own ever saw the issue.
      const result = await fixIssue(ctx, issue, { maxPoints: MAX_POINTS, ceiling: MAX_POINTS, confirmer: SEATS.confirmer });
      if (result.outcome === 'busy') place(issue.number, issue.title, 'W3', result.reason.slice(0, 120));
      if (result.outcome === 'left-alone') log(`#${issue.number}  card left where the facts put it: ${result.reason}`);
    },
    (issue) => `#${issue.number}`,
  );

  await finish();
}

/** `--floor <mode>`: the floor alone, under the instance lock, so it never races a running loop. */
async function walkTheFloorOnly(mode: (typeof FLOOR_MODES)[number]): Promise<number> {
  if (!FLOOR) {
    log('--floor needs a floor block in burn-down-github-issues.config.ts; see references/floor.md');
    return 2;
  }
  step(`${PROJECT.name} floor: ${mode}`);
  if (mode === 'watch') {
    FLOOR.start();
    await new Promise(() => {});
  }
  if (mode === 'drain') {
    await FLOOR.drain('all');
    return FLOOR.owed('all').length > 0 ? 1 : 0;
  }
  const walk = await FLOOR.walkOnce({ livenessOnly: mode === 'liveness' });
  return walk === null || walk.wrong ? 1 : 0;
}

// A stop unwinds main through RunStopping; that is the signal handler's exit to make, once the
// lanes have released their claims, so it is not an error here.
if (import.meta.main) {
  await main().catch((error) => {
    if (!(error instanceof RunStopping)) throw error;
    log('the run is stopping; nothing further is started');
  });
}
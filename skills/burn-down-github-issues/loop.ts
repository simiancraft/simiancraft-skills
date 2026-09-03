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

import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { children, killAgent, shutdownAgents } from '../fix-github-issue/lib/agent.ts';
import { invokeRootFrom, loadProjectConfig, repoRootFrom } from '../fix-github-issue/lib/config.ts';
import { createContext } from '../fix-github-issue/lib/context.ts';
import { parseSeat, seatLabel } from '../fix-github-issue/lib/engines.ts';
import { closeIssue, ensureLabels, repairDurableState, reviewCount } from '../fix-github-issue/lib/labels.ts';
import { claimLock } from '../fix-github-issue/lib/lane.ts';
import { fixIssue, type Issue } from '../fix-github-issue/lib/pipeline.ts';
import { pool } from '../fix-github-issue/lib/pool.ts';
import { findStranded, reconcile, resumeStranded } from '../fix-github-issue/lib/resume.ts';
import { log, sh, step, teeConsole } from '../fix-github-issue/lib/shell.ts';
import { importClosure } from '../fix-github-issue/lib/staleness.ts';
import { appraiseIssue, assertConfirmCloses, pointsFromLabels, resolveCallbacksDir, selectForAppraisal } from '../appraise-github-issues/lib/appraise.ts';
import { type ListItem as FloorItem, pending, readLedger, readList } from '../walk-the-floor/lib/floor.ts';
import { configureStatus, elapsed, lineState, mark, pulse, setLine, stamp, startPulse } from './status.ts';

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
  smokeTimeoutMinutes: number;
  /** How far back merged pull requests are read at startup to close issues a dead run merged. */
  reconciliationDays: number;
  limit: number;
  concurrency: number;
  appraiserConcurrency: number;
  appraiseLimit: number;
  skipLabels: string[];
  /** Whether a close verdict from the appraiser needs the confirmer's agreement; see appraise-github-issues. */
  confirmCloses: boolean;
  /**
   * Where the loop writes the size callbacks it ships (`callbacks/` beside this file) for the
   * appraiser to look up, and where an adopter may add its own. See the appraise skill's
   * references/callbacks.md for the ladder.
   */
  callbacksDir: string;
  seats: { appraiser: string; confirmer: string; callback: string; worker: string; reviewer: string };
  /**
   * When set, the loop starts the walk-the-floor skill beside itself, puts every merge on the
   * floor, and stops merging the moment a walk finds the deployed base wrong. Requires a
   * walk-the-floor.config.ts in the same repository.
   */
  floor?: {
    cadenceMinutes: number;
    /**
     * How long, after the run is done, to wait for the walker to finish the items still on the
     * floor (the run's own last merges among them) before stopping it. Default 60.
     */
    drainMinutes?: number;
  };
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

  seats: {
    appraiser: 'codex:gpt-5.6-sol',
    confirmer: 'claude:claude-opus-5',
    callback: 'codex:gpt-5.6-sol',
    worker: 'codex:gpt-5.6-sol',
    reviewer: 'claude:claude-opus-5',
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
/** The fix pipeline's own prompts, shipped with the sibling skill this loop depends on. */
const FIX_PROMPTS = join(HERE, '..', 'fix-github-issue', 'prompts');

/**
 * The main checkout of the target repository, resolved from the invoking directory. The loop may
 * be run from a worktree; `--git-common-dir` is the same `.git` for every worktree of a
 * repository, so this answers with the main checkout wherever it is invoked from.
 */
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
  ],
  help: [
    'This loop is shared across repositories; everything true of a repository lives in that file.',
    'Copy the template from references/adopting.md in the burn-down-github-issues skill and fill it in.',
  ],
});

assertConfirmCloses(CONFIG.confirmCloses, 'burn-down-github-issues.config.ts');
if (CONFIG.floor) {
  for (const key of ['cadenceMinutes', 'drainMinutes'] as const) {
    const value = CONFIG.floor[key];
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      console.error(`config floor.${key} must be a positive integer, got ${JSON.stringify(value)}`);
      process.exit(1);
    }
  }
}

const PROJECT = CONFIG.project;
const REMOTE = PROJECT.remote;
const BASE = PROJECT.baseBranch;

const RUN_DIR = resolve(REPO_ROOT, PROJECT.worktreeRoot, 'runs');

// ---------------------------------------------------------------------------
// The line. A file switch anyone can flip stops the loop at its three seams: before the appraisal
// batch, before each issue is dispatched, and inside the pull master before every merge. The
// walker, when configured, flips it through the callbacks written below; a person flips it with
// `echo pause > <runs>/line-switch`. Absent means go; an unknown word means pause.
// ---------------------------------------------------------------------------

const SWITCH_FILE = join(RUN_DIR, 'line-switch');
const FLOOR_DIR = resolve(REPO_ROOT, PROJECT.worktreeRoot, 'floor');
const WALK_TS = join(HERE, '..', 'walk-the-floor', 'walk.ts');
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
async function waitForGo(where: string): Promise<void> {
  let announced = false;
  for (;;) {
    const sw = readSwitch();
    if (sw.state === 'go') {
      setLine('active');
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
    await Bun.sleep(SWITCH_POLL_MS);
  }
}

/** One list item per merge, in the floor's documented shape, so the walker checks what landed. */
function putOnTheFloor(event: { issue: number; title: string; pr: number; sha: string; mergedAt: string; paths: string[] }): void {
  if (!CONFIG.floor) return;
  mkdirSync(FLOOR_DIR, { recursive: true });
  const item = {
    id: `pull-request:${event.pr}`,
    addedAt: new Date().toISOString(),
    source: 'burndown',
    text: event.title,
    ref: { pullRequest: event.pr, sha: event.sha, mergedAt: event.mergedAt, paths: event.paths },
  };
  appendFileSync(join(FLOOR_DIR, 'list.jsonl'), `${JSON.stringify(item)}\n`);
}

/**
 * Starts the walker beside the loop and writes the two callbacks that tie it to the switch. The
 * executable form is deliberate: the interlock must not depend on an agent following a prompt.
 * Returns the function that stops it.
 */
type Walker = { stop: () => void;
  /** stop, then wait for the exit with a bounded escalation to SIGKILL. */
  stopAndWait: () => Promise<void>; drain: () => Promise<void> };

function startWalker(cadenceMinutes: number, drainMinutes: number): Walker {
  mkdirSync(FLOOR_DIR, { recursive: true });
  mkdirSync(RUN_DIR, { recursive: true });
  const onFail = `#!/bin/sh
# Written by burn-down-github-issues. A failed walk pauses the line; the reason names the item.
entry=$(cat)
id=$(printf '%s' "$entry" | sed -E 's/.*"itemId":"([^"]*)".*/\\1/')
verdict=$(printf '%s' "$entry" | sed -E 's/.*"verdict":"([^"]*)".*/\\1/')
printf 'pause\nfloor: %s is %s; see the ledger on the floor\n' "$id" "$verdict" > '${SWITCH_FILE}'
`;
  const onPass = `#!/bin/sh
# Written by burn-down-github-issues. A passing walk releases a pause that the same item caused,
# and nothing else: a pause a person set by hand stays until that person clears it.
entry=$(cat)
id=$(printf '%s' "$entry" | sed -E 's/.*"itemId":"([^"]*)".*/\\1/')
f='${SWITCH_FILE}'
if [ -f "$f" ] && sed -n '2p' "$f" | grep -q "^floor: $id is "; then printf 'go\n' > "$f"; fi
`;
  writeFileSync(join(FLOOR_DIR, 'on-fail'), onFail);
  writeFileSync(join(FLOOR_DIR, 'on-pass'), onPass);
  chmodSync(join(FLOOR_DIR, 'on-fail'), 0o755);
  chmodSync(join(FLOOR_DIR, 'on-pass'), 0o755);

  const logFd = openSync(join(RUN_DIR, 'floor.log'), 'a');
  const proc = Bun.spawn(['bun', 'run', WALK_TS, '--dir', FLOOR_DIR, '--every', String(cadenceMinutes)], {
    cwd: INVOKE_ROOT,
    stdout: logFd,
    stderr: logFd,
  });
  log(`walker started (pid ${proc.pid}) on ${FLOOR_DIR}, every ${cadenceMinutes} minute(s); log in ${join(RUN_DIR, 'floor.log')}`);
  const stop = () => {
    try {
      proc.kill();
    } catch {
      // already gone
    }
  };
  /** SIGTERM, then a bounded wait, then SIGKILL: an orphan walker would keep floor.lock and silently unprotect the next run. */
  const stopAndWait = async () => {
    if (proc.exitCode !== null) return;
    stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      proc.exited.then(() => 'exited' as const),
      new Promise<'timeout'>((done) => {
        timer = setTimeout(() => done('timeout'), 5_000);
      }),
    ]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      log('walker ignored SIGTERM; killing it');
      try {
        proc.kill('SIGKILL');
      } catch {
        // gone
      }
    }
  };
  // The run's last merges land on the floor seconds before "done"; killing the walker there
  // would leave them unwalked. SIGUSR1 asks it to finish what is pending and exit on its own.
  const drain = async () => {
    if (proc.exitCode !== null) return;
    const stillPending = () => pendingOnTheFloor().length;
    log(`asking the walker to finish the ${stillPending()} item(s) still on the floor; waiting up to ${drainMinutes} minute(s)`);
    proc.kill('SIGUSR1');
    // A plain timer, cleared on exit: a pending sleep would keep this process alive for the whole
    // window after the walker had already gone.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((done) => {
      timer = setTimeout(() => done('timeout'), drainMinutes * 60_000);
    });
    const outcome = await Promise.race([proc.exited.then(() => 'exited' as const), timeout]);
    clearTimeout(timer);
    if (outcome === 'exited') {
      log('walker finished; the floor is clear');
      return;
    }
    log(`walker still has ${stillPending()} item(s) pending after ${drainMinutes} minute(s); stopping it. Finish them with: bun run ${WALK_TS} --dir ${FLOOR_DIR} --once`);
    stop();
  };
  return { stop, stopAndWait, drain };
}

/** Floor items with no terminal verdict yet, read the same way the walker reads them. */
function pendingOnTheFloor(): FloorItem[] {
  return pending(readList(FLOOR_DIR), readLedger(FLOOR_DIR));
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const DRY_RUN = flag('dry-run');
const LIMIT = Number(opt('limit') ?? CONFIG.limit);
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
const APPRAISE_LIMIT = Number(opt('appraise-limit') ?? CONFIG.appraiseLimit);
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
const ctx = createContext({
  project: PROJECT,
  knobs: {
    autoMerge: CONFIG.autoMerge,
    maxReviewRounds: CONFIG.maxReviewRounds,
    checksTimeoutMinutes: CONFIG.checksTimeoutMinutes,
    smokeTimeoutMinutes: CONFIG.smokeTimeoutMinutes,
  },
  seats: { worker: SEATS.worker, reviewer: SEATS.reviewer },
  repoRoot: REPO_ROOT,
  invokeRoot: INVOKE_ROOT,
  runDir: RUN_DIR,
  promptsDirs: [APPRAISE_PROMPTS, FIX_PROMPTS],
  dryRun: DRY_RUN,
  mayMerge: async () => {
    await waitForGo('the merge queue');
    return { ok: true } as const;
  },
  afterMerge: (event) => {
    mark(event.issue, event.title, 'merged', `PR #${event.pr} ${event.sha.slice(0, 10)}`);
    putOnTheFloor(event);
  },
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function allIssues(): Issue[] {
  return JSON.parse(
    sh(ctx, ['gh', 'issue', 'list', '--state', 'open', '--limit', '500', '--json', 'number,title,createdAt,labels']),
  );
}

/**
 * A merge the pull master landed but never recorded: the process died between `gh pr merge` and
 * the issue close, so the issue is still open and sized and would be fixed a second time. Merged
 * pull requests that reference an open, unheld, sized issue close it with a pointer, and the merge
 * goes on the floor as it would have. Runs under the lock before anything is selected.
 */
async function reconcileMergedPullRequests(all: Issue[]): Promise<void> {
  type Merged = {
    number: number;
    title: string;
    body: string;
    headRefName: string;
    mergedAt: string;
    mergeCommit: { oid: string } | null;
    files: Array<{ path: string }>;
  };
  const since = new Date(Date.now() - CONFIG.reconciliationDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let merged: Merged[];
  try {
    merged = JSON.parse(
      sh(ctx, [
        'gh',
        'pr',
        'list',
        '--state',
        'merged',
        '--base',
        BASE,
        '--limit',
        '100',
        '--search',
        `merged:>=${since}`,
        '--json',
        'number,title,body,headRefName,mergedAt,mergeCommit,files',
      ]),
    );
  } catch (error) {
    log(`could not list merged pull requests: ${(error as Error).message}; skipping merge reconciliation`);
    return;
  }
  const open = new Map(all.map((issue) => [issue.number, issue]));
  for (const pr of merged) {
    for (const ref of new Set(issueRefs([pr]))) {
      const issue = open.get(ref);
      if (!issue) continue;
      if (issue.labels.some((l) => CONFIG.skipLabels.includes(l.name) || l.name === 'loop/dlq')) continue;
      if (pointsFromLabels(issue.labels) === null) continue; // an unsized issue was never the loop's merge
      log(`repair: #${issue.number} is open but PR #${pr.number} merged at ${pr.mergedAt} references it; closing with a pointer`);
      await closeIssue(ctx, issue.number, `Resolved by #${pr.number}, merged at ${pr.mergedAt}. The run that merged it did not finish recording the close.`, {
        kind: 'merged',
        pr: pr.number,
        mergeSha: pr.mergeCommit?.oid,
        reason: `merged #${pr.number} by reconciliation`,
        by: 'reconcile',
      });
      mark(issue.number, issue.title, 'merged', `PR #${pr.number} ${(pr.mergeCommit?.oid ?? '').slice(0, 10)} (recovered)`);
      if (!DRY_RUN && pr.mergeCommit) {
        putOnTheFloor({ issue: issue.number, title: pr.title, pr: pr.number, sha: pr.mergeCommit.oid, mergedAt: pr.mergedAt, paths: pr.files.map((f) => f.path) });
      }
      open.delete(ref);
    }
  }
}

/**
 * Candidates are recent, open, unclaimed issues that are either already sized within the band or
 * not yet sized at all. An issue already sized above the band is left alone: it has been judged,
 * and re-judging it every run is churn.
 */
function selectCandidates(): Issue[] {
  const raw = sh(ctx, [
    'gh',
    'issue',
    'list',
    '--state',
    'open',
    '--limit',
    '500',
    '--json',
    'number,title,createdAt,labels',
  ]);
  const all: Issue[] = JSON.parse(raw);

  const claimed = new Set(openPullRequestIssueRefs());

  const cutoff = Date.now() - CONFIG.ageDays * 24 * 60 * 60 * 1000;

  return all
    .filter((issue) => Date.parse(issue.createdAt) >= cutoff)
    .filter((issue) => !issue.labels.some((l) => CONFIG.skipLabels.includes(l.name) || l.name === 'loop/dlq'))
    .filter((issue) => reviewCount(issue.labels) < CONFIG.maxReviewRounds)
    .filter((issue) => !claimed.has(issue.number))
    // Sized only. An unsized issue belongs to the appraisers; handing one to a worker is what the
    // split exists to stop, since a worker pays for a worktree before discovering it is not work.
    .filter((issue) => {
      const points = pointsFromLabels(issue.labels);
      return points !== null && points <= MAX_POINTS;
    })
    .sort((a, b) => b.number - a.number);
}

/**
 * Issue numbers already referenced by an open pull request, so the loop never opens a second one.
 *
 * Only `#1234` in the title or body, and a trailing `-1234` on the branch name, count as a claim. A
 * bare number is not a reference: proof bodies are full of them, and matching those would let a
 * receipt reading "1,234 packages" claim issue 1234 and silently drop it from selection.
 */
function openPullRequestIssueRefs(): number[] {
  const raw = sh(ctx, ['gh', 'pr', 'list', '--state', 'open', '--limit', '200', '--json', 'body,title,headRefName']);
  return issueRefs(JSON.parse(raw));
}

/** The issue numbers a set of pull requests reference, by `#1234` in title or body or `-1234` in the branch. */
function issueRefs(prs: Array<{ body: string; title: string; headRefName: string }>): number[] {
  const refs: number[] = [];
  for (const pr of prs) {
    for (const match of `${pr.title}\n${pr.body}`.matchAll(/#(\d{2,6})\b/g)) {
      refs.push(Number(match[1]));
    }
    // A branch name is structured, so a number standing alone between separators is a reference:
    // `fix/1234-null-guard` and `feat/1240-export-button` both name their issue.
    for (const match of pr.headRefName.matchAll(/(?:^|[/_-])(\d{2,6})(?=$|[/_-])/g)) {
      refs.push(Number(match[1]));
    }
  }
  return refs;
}

let SKIP_APPRAISAL_THIS_RUN = false;

/** The size callbacks this loop ships, copied into the callbacks directory on every start so the appraiser finds them. */
const SHIPPED_CALLBACKS = join(HERE, 'callbacks');

/**
 * Writes the loop's size callbacks where the appraiser looks, the way `startWalker` writes the
 * floor's `on-fail`. Shipped files are overwritten so a skill update reaches the adopter; any file
 * the adopter added under another name is left alone. Returns the directory.
 */
function placeSizeCallbacks(): string {
  const dir = resolveCallbacksDir(ctx, CONFIG.callbacksDir);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(SHIPPED_CALLBACKS)) return dir;
  for (const name of readdirSync(SHIPPED_CALLBACKS)) {
    if (!/^on-size/.test(name)) continue; // a README beside the slots is documentation, not a slot
    const from = join(SHIPPED_CALLBACKS, name);
    const to = join(dir, name);
    copyFileSync(from, to);
    chmodSync(to, statSync(from).mode & 0o777);
  }
  return dir;
}

/** The sizing stage: fetch the base ref, select the unsized window, appraise it through the sibling skill. */
async function sizeTheWindow(): Promise<void> {
  // Appraisers judge "already in the base" against the fetched base ref, not the main checkout's
  // working state, which may be stale, dirty, or on another branch; give them a fresh ref.
  if (!DRY_RUN) sh(ctx, ['git', 'fetch', REMOTE, BASE]);
  const callbacksDir = placeSizeCallbacks();
  log(`size callbacks in ${callbacksDir}`);
  const toAppraise = selectForAppraisal(allIssues(), CONFIG).slice(0, APPRAISE_LIMIT);
  if (toAppraise.length === 0) {
    log('nothing to appraise; the window is fully sized');
  } else {
    step(`Appraising ${toAppraise.length} issue(s), ${CONFIG.appraiserConcurrency} at a time`);
    log(toAppraise.map((i) => `#${i.number}`).join(', '));
    await pool(
      toAppraise,
      CONFIG.appraiserConcurrency,
      async (issue) => {
        mark(issue.number, issue.title, 'appraising');
        let outcome: Awaited<ReturnType<typeof appraiseIssue>>;
        try {
          outcome = await appraiseIssue(ctx, issue, {
            ageDays: CONFIG.ageDays,
            seats: { appraiser: SEATS.appraiser, confirmer: SEATS.confirmer },
            confirmCloses: CONFIG.confirmCloses,
            skipLabels: CONFIG.skipLabels,
            callbacks: { dir: callbacksDir, seat: SEATS.callback },
          });
        } catch (error) {
          // The board must not be left saying "appraising" for a lane that threw.
          mark(issue.number, issue.title, 'failed', (error as Error).message.slice(0, 80));
          throw error;
        }
        // `retry` means nothing changed on the issue and the next run tries again; the board
        // says so rather than claiming a size or a hand-off that never landed.
        const stage = outcome.retry
          ? 'failed'
          : outcome.verdict === 'valid'
            ? 'sized'
            : outcome.close === 'confirmed' || outcome.close === 'skipped'
              ? 'closed'
              : 'handed-off';
        const note = outcome.retry
          ? outcome.reason
          : outcome.points
            ? `${outcome.verdict}, ${outcome.points} points${outcome.callback?.name ? `, ${outcome.callback.name}` : ''}`
            : outcome.close
              ? `${outcome.verdict}, close ${outcome.close}`
              : outcome.verdict;
        mark(issue.number, issue.title, stage, note);
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
  log(`appraiser ${seatLabel(SEATS.appraiser)} | confirmer ${seatLabel(SEATS.confirmer)} | worker ${seatLabel(SEATS.worker)} | reviewer ${seatLabel(SEATS.reviewer)}`);
  if (SEATS.worker.engine === SEATS.reviewer.engine) {
    log('WARNING: worker and reviewer share an engine, so the merge gate shares the author\'s blind spots');
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
  // The walker is a child that would otherwise keep this process alive after the run is done, so
  // main drains it (finish the floor, then exit) and every other exit path stops it outright.
  const walker: Walker =
    CONFIG.floor && !DRY_RUN
      ? startWalker(CONFIG.floor.cadenceMinutes, CONFIG.floor.drainMinutes ?? 60)
      : { stop: () => {}, stopAndWait: async () => {}, drain: async () => {} };
  const stopWalker = walker.stop;
  const stopPulse = startPulse(PULSE_MINUTES);
  if (!SILENT) log(`operator board: a line per issue on every change, the whole board every ${PULSE_MINUTES} minute(s); --silent turns it off`);
  process.on('exit', () => {
    stopPulse();
    stopWalker();
    releaseLock();
  });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      log(`received ${signal}; stopping agents and releasing the lock`);
      // Wait for the agents to actually die before the lock goes: a child that ignores SIGTERM
      // would otherwise keep working, approvals bypassed, under a replacement run's lock.
      const survivors = await shutdownAgents();
      if (survivors > 0) log(`${survivors} agent(s) survived SIGKILL; check ps before starting another run`);
      await walker.stopAndWait();
      releaseLock();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }

  ensureLabels(ctx);
  if (!DRY_RUN) {
    reconcile(ctx, new Set(openPullRequestIssueRefs()));

    // Half-written label transitions are repaired before anything reads them, so a crash mid-DLQ
    // or mid-count-swap costs one repair pass rather than a permanently wedged issue.
    repairDurableState(ctx, allIssues(), CONFIG.skipLabels, { reviews: CONFIG.maxReviewRounds });
    await reconcileMergedPullRequests(allIssues());

    // Resume before selecting anything new: a stranded pull request is finished work, and landing
    // it first also moves the base before fresh lanes cut their branches from it. Re-read the
    // issues rather than reusing the repair pass's snapshot; the repair may have moved labels.
    const stranded = findStranded(ctx, allIssues(), CONFIG.skipLabels);
    for (const entry of stranded) mark(entry.issue.number, entry.issue.title, 'working', `resumed PR #${entry.result.pr}`);
    await resumeStranded(
      ctx,
      stranded,
      CONFIG.concurrency,
      MAX_POINTS,
    );
  }

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
      if (!SKIP_APPRAISAL_THIS_RUN) await sizeTheWindow();
    } finally {
      releaseAppraisal();
    }
  }

  // Selection is re-read rather than reused
  // Selection is re-read rather than reused: the appraisal above has just changed the labels this
  // depends on, and a worker must see them.
  const candidates = selectCandidates().slice(0, LIMIT);
  if (candidates.length === 0) {
    log('no sized candidates in the window; widen CONFIG.ageDays or raise --max-points');
    step('done');
    pulse('final');
    stopPulse();
    await walker.drain();
    return;
  }

  step(`Working ${candidates.length} issue(s), ${Math.min(CONFIG.concurrency, candidates.length)} at a time`);
  log(candidates.map((i) => `#${i.number}`).join(', '));
  await pool(
    candidates,
    CONFIG.concurrency,
    async (issue) => {
      await waitForGo(`#${issue.number}`);
      mark(issue.number, issue.title, 'working');
      const result = await fixIssue(ctx, issue, { maxPoints: MAX_POINTS });
      const stage =
        result.outcome === 'merged' || result.outcome === 'parked' || result.outcome === 'dlq' || result.outcome === 'failed'
          ? result.outcome
          : result.outcome === 'closed'
            ? 'closed'
            : 'handed-off';
      mark(issue.number, issue.title, stage, result.reason.slice(0, 80));
    },
    (issue) => `#${issue.number}`,
  );

  step('done');
  pulse('final');
  stopPulse();
  await walker.drain();
}

await main();
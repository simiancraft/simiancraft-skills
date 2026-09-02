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

import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { children, killAgent, readResult, renderPrompt, runAgent } from '../fix-github-issue/lib/agent.ts';
import { invokeRootFrom, loadProjectConfig, repoRootFrom } from '../fix-github-issue/lib/config.ts';
import { APPRAISAL_FILE } from '../fix-github-issue/lib/control-files.ts';
import { createContext } from '../fix-github-issue/lib/context.ts';
import { parseSeat, seatLabel } from '../fix-github-issue/lib/engines.ts';
import { closeIssue, ensureLabels, repairDurableState, reviewCount } from '../fix-github-issue/lib/labels.ts';
import { claimLock } from '../fix-github-issue/lib/lane.ts';
import { fixIssue, type Issue } from '../fix-github-issue/lib/pipeline.ts';
import { pool } from '../fix-github-issue/lib/pool.ts';
import { findStranded, reconcile, resumeStranded } from '../fix-github-issue/lib/resume.ts';
import { log, mutate, sh, step } from '../fix-github-issue/lib/shell.ts';
import { importClosure } from '../fix-github-issue/lib/staleness.ts';

// ---------------------------------------------------------------------------
// Defaults. Every boundary the loop enforces is here or in the repository's config file; nothing
// below hard-codes one. Any of these knobs can be overridden by that config file.
// ---------------------------------------------------------------------------

type LoopKnobs = {
  ageDays: number;
  maxPoints: number;
  autoMerge: 'always' | 'code-only' | 'never';
  maxReviewRounds: number;
  limit: number;
  concurrency: number;
  appraiserConcurrency: number;
  appraiseLimit: number;
  skipLabels: string[];
  seats: { appraiser: string; worker: string; reviewer: string };
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
  seats: {
    appraiser: 'codex:gpt-5.6-sol',
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
const PROMPTS = join(HERE, 'prompts');
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
  ],
  help: [
    'This loop is shared across repositories; everything true of a repository lives in that file.',
    'Copy the template from references/adopting.md in the burn-down-github-issues skill and fill it in.',
  ],
});

const PROJECT = CONFIG.project;
const REMOTE = PROJECT.remote;
const BASE = PROJECT.baseBranch;

const RUN_DIR = resolve(REPO_ROOT, PROJECT.worktreeRoot, 'runs');

type AppraisalVerdict = 'valid' | 'already-fixed' | 'obsolete' | 'needs-decision' | 'needs-human' | 'failed';

type AppraisalResult = {
  issue: number;
  verdict: AppraisalVerdict;
  points?: number;
  reason: string;
  closeComment?: string;
  priorSize?: string | null;
  disagrees?: boolean;
};

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

/** Who actually sits in each seat this run: the flag when given, the configured default otherwise. */
const SEATS = (() => {
  try {
    return {
      appraiser: parseSeat(opt('appraiser') ?? CONFIG.seats.appraiser, '--appraiser'),
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
  knobs: { autoMerge: CONFIG.autoMerge, maxReviewRounds: CONFIG.maxReviewRounds },
  seats: { worker: SEATS.worker, reviewer: SEATS.reviewer },
  repoRoot: REPO_ROOT,
  invokeRoot: INVOKE_ROOT,
  runDir: RUN_DIR,
  promptsDirs: [PROMPTS, FIX_PROMPTS],
  dryRun: DRY_RUN,
});

/**
 * The largest size label the issue carries. Max rather than first match: a relabel is add-then-
 * remove, so an issue can briefly carry two, and the conservative reading is the bigger one.
 */
function pointsFromLabels(labels: Array<{ name: string }>): number | null {
  let points: number | null = null;
  for (const { name } of labels) {
    const match = /^size:\s*(\d+)$/.exec(name);
    if (match) points = Math.max(points ?? 0, Number(match[1]));
  }
  return points;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Issues waiting on an appraiser: recent, open, not already ruled out, and carrying no point size.
 *
 * This population is finite and drains. Once every issue in the window has been appraised there is
 * nothing for an appraiser to do, which is why its pool is sized separately from the workers'.
 */
function allIssues(): Issue[] {
  return JSON.parse(
    sh(ctx, ['gh', 'issue', 'list', '--state', 'open', '--limit', '500', '--json', 'number,title,createdAt,labels']),
  );
}

function selectForAppraisal(all: Issue[]): Issue[] {
  const cutoff = Date.now() - CONFIG.ageDays * 24 * 60 * 60 * 1000;
  return all
    .filter((issue) => Date.parse(issue.createdAt) >= cutoff)
    .filter((issue) => !issue.labels.some((l) => CONFIG.skipLabels.includes(l.name) || l.name === 'loop/dlq'))
    .filter((issue) => pointsFromLabels(issue.labels) === null)
    .sort((a, b) => b.number - a.number);
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
  const prs: Array<{ body: string; title: string; headRefName: string }> = JSON.parse(raw);
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

/**
 * Appraises one issue and acts on the answer.
 *
 * Runs in the loop's own directory rather than a worktree: appraisal is read-only, so it needs no
 * checkout of its own and paying for one would defeat the point of separating it from the worker.
 */
async function appraise(issue: Issue): Promise<AppraisalVerdict> {
  const say = (message: string) => log(`#${issue.number}  ${message}`);
  const cwd = join(RUN_DIR, `appraise-${issue.number}`);
  mkdirSync(cwd, { recursive: true });

  const prompt = renderPrompt(ctx, 'appraise.md', {
    ISSUE: String(issue.number),
    TITLE: issue.title,
    AGE_DAYS: String(CONFIG.ageDays),
  });
  const run = await runAgent(ctx, 'appraiser', issue.number, cwd, SEATS.appraiser, prompt);
  if (run.exitCode !== 0) {
    say(`appraiser exited ${run.exitCode}; its verdict is not trusted and the issue stays unsized`);
    rmSync(cwd, { recursive: true, force: true });
    return 'failed';
  }

  const result = readResult<AppraisalResult>(cwd, APPRAISAL_FILE);
  if (!result) {
    say('appraiser wrote no verdict; leaving the issue unsized');
    return 'failed';
  }
  say(`appraisal: ${result.verdict}${result.points ? ` at ${result.points} points` : ''}; ${result.reason}`);

  switch (result.verdict) {
    case 'already-fixed':
    case 'obsolete':
      closeIssue(ctx, issue.number, result.closeComment ?? result.reason);
      break;

    case 'needs-decision':
    case 'needs-human':
      mutate(ctx, `label #${issue.number} ${result.verdict}`, [
        'gh',
        'issue',
        'edit',
        String(issue.number),
        '--add-label',
        result.verdict,
      ]);
      mutate(ctx, `comment on #${issue.number}`, ['gh', 'issue', 'comment', String(issue.number), '--body', result.reason]);
      break;

    case 'valid':
      if (result.points) {
        mutate(ctx, `size #${issue.number} at ${result.points}`, [
          'gh',
          'issue',
          'edit',
          String(issue.number),
          '--add-label',
          `size: ${result.points}`,
        ]);
        if (result.disagrees && result.priorSize) {
          mutate(ctx, `note the sizing disagreement on #${issue.number}`, [
            'gh',
            'issue',
            'comment',
            String(issue.number),
            '--body',
            `Re-sized at ${result.points} points, previously \`${result.priorSize}\`. ${result.reason}`,
          ]);
        }
      } else {
        say('appraiser called it valid but gave no size; leaving it for the next pass');
      }
      break;
  }

  rmSync(cwd, { recursive: true, force: true });
  return result.verdict;
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

  step(`${PROJECT.name} burn-down-github-issues`);
  log(`base ${BASE} | last ${CONFIG.ageDays} days | up to ${MAX_POINTS} points | merge: ${CONFIG.autoMerge}`);
  log(`appraiser ${seatLabel(SEATS.appraiser)} | worker ${seatLabel(SEATS.worker)} | reviewer ${seatLabel(SEATS.reviewer)}`);
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
  process.on('exit', releaseLock);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      log(`received ${signal}; stopping agents and releasing the lock`);
      for (const child of children) killAgent(child);
      releaseLock();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }

  ensureLabels(ctx);
  if (!DRY_RUN) {
    reconcile(ctx, new Set(openPullRequestIssueRefs()));

    // Half-written label transitions are repaired before anything reads them, so a crash mid-DLQ
    // or mid-count-swap costs one repair pass rather than a permanently wedged issue.
    repairDurableState(ctx, allIssues(), CONFIG.skipLabels);

    // Resume before selecting anything new: a stranded pull request is finished work, and landing
    // it first also moves the base before fresh lanes cut their branches from it. Re-read the
    // issues rather than reusing the repair pass's snapshot; the repair may have moved labels.
    await resumeStranded(
      ctx,
      findStranded(ctx, allIssues(), CONFIG.skipLabels),
      CONFIG.concurrency,
      MAX_POINTS,
    );
  }

  // Appraisal first, and on its own timeline. Workers only ever pick up something already judged
  // real and sized, so the expensive population never pays for a worktree to discover an issue was
  // already fixed. This queue drains: once the window is appraised there is nothing here to do.
  if (!SKIP_APPRAISAL) {
    // Appraisers judge "already in the base" against the fetched base ref, not the main checkout's
    // working state, which may be stale, dirty, or on another branch; give them a fresh ref.
    if (!DRY_RUN) sh(ctx, ['git', 'fetch', REMOTE, BASE]);
    const toAppraise = selectForAppraisal(allIssues()).slice(0, APPRAISE_LIMIT);
    if (toAppraise.length === 0) {
      log('nothing to appraise; the window is fully sized');
    } else {
      step(`Appraising ${toAppraise.length} issue(s), ${CONFIG.appraiserConcurrency} at a time`);
      log(toAppraise.map((i) => `#${i.number}`).join(', '));
      await pool(
        toAppraise,
        CONFIG.appraiserConcurrency,
        async (issue) => {
          await appraise(issue);
        },
        (issue) => `#${issue.number}`,
      );
    }
  }

  // Selection is re-read rather than reused: the appraisal above has just changed the labels this
  // depends on, and a worker must see them.
  const candidates = selectCandidates().slice(0, LIMIT);
  if (candidates.length === 0) {
    log('no sized candidates in the window; widen CONFIG.ageDays or raise --max-points');
    step('done');
    return;
  }

  step(`Working ${candidates.length} issue(s), ${Math.min(CONFIG.concurrency, candidates.length)} at a time`);
  log(candidates.map((i) => `#${i.number}`).join(', '));
  await pool(
    candidates,
    CONFIG.concurrency,
    async (issue) => {
      await fixIssue(ctx, issue, { maxPoints: MAX_POINTS });
    },
    (issue) => `#${issue.number}`,
  );

  step('done');
}

await main();
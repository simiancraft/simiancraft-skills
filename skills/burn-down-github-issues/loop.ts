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
 *   bun run <skill-dir>/loop.ts --issue <n>
 *   bun run <skill-dir>/loop.ts --worker codex:gpt-5.6-sol --reviewer claude:claude-opus-5
 *
 * Hard dependency: the sibling `prove-work-on-github` skill, shipped alongside this one in
 * simiancraft-skills. Both prompts load it by name, and the staleness rule below implements its
 * references/freshness-and-reproof.md.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHECKS_TIMEOUT_MS,
  children,
  killAgent,
  logTail,
  parseJsonFile,
  readResult,
  renderPrompt,
  runAgent,
} from '../fix-github-issue/lib/agent.ts';
import { invokeRootFrom, loadProjectConfig, repoRootFrom } from '../fix-github-issue/lib/config.ts';
import { APPRAISAL_FILE, VERDICT_FILE } from '../fix-github-issue/lib/control-files.ts';
import { createContext } from '../fix-github-issue/lib/context.ts';
import { parseSeat, seatLabel } from '../fix-github-issue/lib/engines.ts';
import {
  claimLock,
  dirtyPaths,
  inFlight,
  removeWorktree,
  resetLane,
  updateFromBase,
  worktreeFor,
} from '../fix-github-issue/lib/lane.ts';
import { pool } from '../fix-github-issue/lib/pool.ts';
import { log, mutate, sh, step } from '../fix-github-issue/lib/shell.ts';

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

type Verdict =
  | 'already-fixed'
  | 'obsolete'
  | 'needs-decision'
  | 'needs-human'
  | 'out-of-band'
  | 'fixed'
  | 'failed';

type WorkerResult = {
  issue: number;
  verdict: Verdict;
  points?: number;
  reason: string;
  /** For already-fixed and obsolete: the comment to post before closing, receipt included. */
  closeComment?: string;
  pr?: number;
  branch?: string;
  /** What the change touches, which decides whether autoMerge: 'code-only' will merge it. */
  touches?: Array<'code' | 'data' | 'migration' | 'stored-string' | 'ci'>;
};

type ReviewResult = {
  pr: number;
  decision: 'merge' | 'gather-more' | 'block';
  adequacy: string;
  confidence: string;
  blocking: string[];
  /** The reviewer's own classification of the diff, unioned with the worker's before merging. */
  touches?: WorkerResult['touches'];
};

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

type Issue = { number: number; title: string; createdAt: string; labels: Array<{ name: string }> };

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
const ONLY_ISSUE = (() => {
  const raw = opt('issue');
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    // A mistyped issue number must not silently degrade into a full batch run.
    console.error(`--issue expects an issue number, got '${raw}'`);
    process.exit(1);
  }
  return parsed;
})();
// A single-issue run is a focused run; appraising the rest of the backlog alongside it would
// surprise, so --issue implies no appraisal unless an appraise limit was asked for explicitly.
const SKIP_APPRAISAL = flag('no-appraise') || (ONLY_ISSUE !== undefined && opt('appraise-limit') === undefined);
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
  promptsDirs: [PROMPTS],
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

  // --issue overrides the age and size filters, never the safety ones: a skipped, parked, DLQed,
  // budget-exhausted, or already-claimed issue stays out of reach even when named directly.
  if (ONLY_ISSUE) {
    return all
      .filter((i) => i.number === ONLY_ISSUE)
      .filter((issue) => !issue.labels.some((l) => CONFIG.skipLabels.includes(l.name) || l.name === 'loop/dlq'))
      .filter((issue) => reviewCount(issue.labels) < CONFIG.maxReviewRounds)
      .filter((issue) => !claimed.has(issue.number));
  }

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

function ensureLabels(): void {
  const existing = new Set(sh(ctx, ['gh', 'label', 'list', '--limit', '200', '--json', 'name', '--jq', '.[].name']).split('\n'));
  const wanted: Array<[string, string, string]> = [
    ['needs-decision', 'ededed', 'Blocked on a product decision, not on effort'],
    ['needs-human', 'ededed', 'Needs access or authority an agent does not have'],
    ['loop/skip', 'ededed', 'Permanently out of the issue loop'],
    ['loop/parked', 'fbca04', 'The loop worked it and a human needs to finish the call'],
    ['loop/dlq', 'b60205', 'Exhausted its reviews; retained with a reason, redrive by removing this label'],
  ];
  for (const [name, color, description] of wanted) {
    if (existing.has(name)) continue;
    mutate(ctx, `create label ${name}`, ['gh', 'label', 'create', name, '--color', color, '--description', description]);
  }
}

// ---------------------------------------------------------------------------
// Durable state
//
// Every fact the loop needs across runs lives on the issue, not in this process. A run that dies
// loses only the agents in flight; the next one reads the same labels and carries on. It also means
// the state is legible on GitHub rather than in a log nobody kept.
// ---------------------------------------------------------------------------

/**
 * How many review rounds this issue has already consumed, read from its `loop/reviews: N` label.
 * Max rather than first match: the increment is add-then-remove, so a crash between the two
 * leaves both labels, and the honest reading of that state is the higher count.
 */
function reviewCount(labels: Array<{ name: string }>): number {
  let count = 0;
  for (const { name } of labels) {
    const match = /^loop\/reviews:\s*(\d+)$/.exec(name);
    if (match) count = Math.max(count, Number(match[1]));
  }
  return count;
}

/**
 * Records a completed review round. Written by one role only, so the count cannot be lost.
 *
 * Label edits are not compare-and-swap, so two writers incrementing concurrently would drop an
 * increment and silently break the burndown guarantee. The pull master is the only writer.
 */
function recordReview(issue: number, previous: number): number {
  const next = previous + 1;
  const label = `loop/reviews: ${next}`;
  try {
    sh(ctx, ['gh', 'label', 'create', label, '--color', 'd4c5f9', '--description', 'Review rounds consumed']);
  } catch {
    // already exists
  }
  // Add the new count before removing the old one. A crash between the two leaves both labels,
  // and reviewCount reads the max; the other order would refund every spent round on a crash.
  mutate(ctx, `mark #${issue} at ${label}`, ['gh', 'issue', 'edit', String(issue), '--add-label', label]);
  if (previous > 0) {
    mutate(ctx, `clear loop/reviews: ${previous} on #${issue}`, [
      'gh',
      'issue',
      'edit',
      String(issue),
      '--remove-label',
      `loop/reviews: ${previous}`,
    ]);
  }
  return next;
}

/** Ejects an issue to the dead-letter queue, retained with the reason that put it there. */
function sendToDlq(issue: number, rounds: number, reason: string): void {
  // Reason first, label second: a crash between the two leaves an explained issue that is not yet
  // ejected, which the next run finishes; the other order hides an issue with no explanation.
  mutate(ctx, `comment on #${issue}`, [
    'gh',
    'issue',
    'comment',
    String(issue),
    '--body',
    `Moved to the dead-letter queue after ${rounds} review rounds without a merge.\n\n${reason}\n\nRemove the \`loop/dlq\` label to put it back in the queue with a fresh review budget.`,
  ]);
  mutate(ctx, `send #${issue} to the DLQ`, ['gh', 'issue', 'edit', String(issue), '--add-label', 'loop/dlq']);
  // Every count label comes off, or the redrive is a lie: with any `loop/reviews: N` surviving,
  // removing `loop/dlq` would put the issue somewhere selection still refuses to look, or hand it
  // back with a short budget. Read the labels live rather than trusting the caller's snapshot,
  // since an earlier add-before-remove crash can have left lower counts behind.
  const current = sh(ctx, ['gh', 'issue', 'view', String(issue), '--json', 'labels', '--jq', '.labels[].name'])
    .split('\n')
    .filter((name) => /^loop\/reviews:/.test(name));
  for (const label of current) {
    mutate(ctx, `clear ${label} on #${issue}`, ['gh', 'issue', 'edit', String(issue), '--remove-label', label]);
  }
}

/**
 * Repairs label states a crash can leave half-written, so every durable transition is
 * re-runnable rather than a one-shot. Two known wrecks: an issue at the review cap that never
 * received `loop/dlq` (its ejection half done, invisible to selection forever), and a DLQed issue
 * still carrying `loop/reviews:*` counts (its redrive would not actually requeue it). Runs under
 * the instance lock, before any lane starts.
 */
function repairDurableState(all: Issue[]): void {
  for (const issue of all) {
    const names = issue.labels.map((l) => l.name);
    const counts = names.filter((name) => /^loop\/reviews:/.test(name));
    const dlq = names.includes('loop/dlq');
    const shelved = names.some((name) => CONFIG.skipLabels.includes(name));

    if (dlq && counts.length > 0) {
      for (const label of counts) {
        mutate(ctx, `repair: clear ${label} on DLQed #${issue.number}`, [
          'gh',
          'issue',
          'edit',
          String(issue.number),
          '--remove-label',
          label,
        ]);
      }
      continue;
    }
    if (!dlq && !shelved && reviewCount(issue.labels) >= CONFIG.maxReviewRounds) {
      log(`repair: #${issue.number} sits at the review cap without loop/dlq; finishing the ejection`);
      sendToDlq(issue.number, reviewCount(issue.labels), 'Completing an ejection an earlier run started and did not finish.');
    }
  }
}

// ---------------------------------------------------------------------------
// Self repair
// ---------------------------------------------------------------------------

/**
 * Clears the wreckage of a run that died, so a crash costs the next run nothing.
 *
 * A loop process can die for reasons that are never established, so the answer is to make the
 * cause irrelevant rather than to guess at it. Everything durable lives on GitHub; what a dead run leaves
 * behind locally is a worktree with no owner and possibly a branch that never became a pull request.
 * Both are safe to reason about because no process holds them any more: this runs before any lane
 * starts, under the instance lock.
 */
function reconcile(): void {
  const managed = resolve(REPO_ROOT, PROJECT.worktreeRoot);
  const claimed = new Set(openPullRequestIssueRefs());
  let repaired = 0;

  for (const line of sh(ctx, ['git', 'worktree', 'list', '--porcelain']).split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const dir = resolve(line.slice('worktree '.length).trim());
    if (!dir.startsWith(`${managed}/`)) continue;

    // Agents make scratch siblings next to their own worktree (`issue-1234-evidence`) to capture a
    // before state or write to the evidence branch. A pattern anchored on the number alone could
    // not see them, so a crashed lane left them behind permanently: nothing else walks this root.
    // They belong to the parent issue, so the claimed and dirty rules below judge them by the
    // parent where it still exists, and a sibling's removal takes only the sibling: removing by
    // issue number would also take the parent worktree this same pass may have chosen to keep.
    const parts = /issue-(\d+)(-[^/]+)?$/.exec(dir);
    const issue = parts?.[1];
    if (!issue) continue;
    const parent = resolve(managed, `issue-${issue}`);
    const isSibling = Boolean(parts?.[2]);
    const judged = isSibling && existsSync(parent) ? parent : dir;

    // A pull request means the work reached GitHub and is not ours to throw away; selection already
    // treats the issue as claimed, so leave both alone and let a human or a later round finish it.
    if (claimed.has(Number(issue))) {
      log(`reconcile: #${issue} has an open pull request; leaving its worktree in place`);
      continue;
    }

    const dirty = (() => {
      try {
        return dirtyPaths(ctx, judged).length > 0;
      } catch {
        return false;
      }
    })();
    if (dirty) {
      log(`reconcile: #${issue} has uncommitted work and no pull request; leaving it for inspection`);
      continue;
    }

    if (isSibling) {
      log(`reconcile: removing abandoned scratch worktree ${dir}`);
      try {
        sh(ctx, ['git', 'worktree', 'remove', '--force', dir]);
      } catch {
        rmSync(dir, { recursive: true, force: true });
      }
    } else {
      log(`reconcile: removing abandoned worktree for #${issue}`);
      removeWorktree(ctx, Number(issue));
    }
    repaired++;
  }

  if (repaired > 0) log(`reconcile: cleared ${repaired} abandoned worktree(s) from an earlier run`);
}

/**
 * Paths whose change invalidates any proof in flight, whatever the pull request touched.
 *
 * Import scanning cannot reach these: a lockfile, an ORM schema, generated output, or a build
 * config is not imported by a module path, yet everything downstream depends on it.
 */
const ALWAYS_INVALIDATES: readonly string[] = PROJECT.alwaysInvalidates;
const RELEASE_ARTIFACTS: readonly string[] = PROJECT.releaseArtifacts ?? [];

/**
 * Path patterns for `alwaysInvalidates` and `touchPaths`: a pattern that starts with '.' and
 * carries no '/' matches as a filename suffix ('.schema.ts' catches every file so named
 * wherever it lives); anything else matches as a prefix from the repository root, so
 * '.github/workflows/' stays a prefix.
 */
function matchesPath(file: string, pattern: string): boolean {
  return pattern.startsWith('.') && !pattern.includes('/') ? file.endsWith(pattern) : file.startsWith(pattern);
}

/** Beyond this the closure is not worth computing; treat the proof as stale and re-review. */
const MAX_BASE_REFRESHES = 2;

const CLOSURE_CAP = 3000;

/** Resolves an import specifier to a repository-relative file, or null when it leaves the tree. */
function resolveSpecifier(cwd: string, fromFile: string, specifier: string): string | null {
  let base: string | undefined;
  // Longest prefix wins, so a project declaring both `~/` and `~/components/` resolves the more
  // specific one rather than whichever happens to be listed first.
  for (const alias of [...PROJECT.pathAliases].sort((a, b) => b.prefix.length - a.prefix.length)) {
    if (specifier.startsWith(alias.prefix)) {
      base = join(alias.dir, specifier.slice(alias.prefix.length));
      break;
    }
  }
  if (base === undefined && specifier.startsWith('.')) base = join(dirname(fromFile), specifier);
  if (base === undefined) return null; // a bare package; dependency changes are caught by the lockfile above

  const stem = base;
  for (const candidate of [
    stem,
    ...PROJECT.sourceExtensions.map((ext) => `${stem}${ext}`),
    ...PROJECT.sourceExtensions.map((ext) => join(stem, `index${ext}`)),
  ]) {
    const abs = join(cwd, candidate);
    if (existsSync(abs) && statSync(abs).isFile()) return candidate;
  }
  return null;
}

/**
 * Every module the given files reach by following imports, transitively, plus the files themselves.
 *
 * This is what an artifact actually covers. A check-command receipt or a rendered frame depends on the
 * whole graph beneath the component, not on the handful of files the diff happens to edit.
 */
function importClosure(cwd: string, entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];

  while (queue.length > 0 && seen.size <= CLOSURE_CAP) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) continue;

    const abs = join(cwd, file);
    if (!existsSync(abs)) continue;

    // `import\s*\(` before `import` in the alternation, so dynamic imports with a literal
    // specifier are followed too; string-built paths remain invisible, as documented.
    for (const match of readFileSync(abs, 'utf8').matchAll(/(?:from|import\s*\(|import|require\()\s*['"]([^'"]+)['"]/g)) {
      const resolved = resolveSpecifier(cwd, file, match[1]);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

/**
 * What the base has changed since `sinceSha` that this branch's proof actually depends on.
 *
 * Being behind the base is not by itself stale proof. Per the freshness rule in the sibling
 * prove-work-on-github skill's references/freshness-and-reproof.md, decay is a
 * function of distance from the base AND of how much of the incoming change intersects the paths
 * the proof covers. Covered paths are the import closure, not the edited files: a base change to a shared
 * chassis module, a generated type, or a lockfile invalidates a receipt while touching nothing the
 * diff touched, and comparing filenames alone would call that fresh and merge it.
 */
/**
 * Whether the base's package.json movement since `sinceSha` is nothing but a version bump.
 * Release automation that bumps the version on every landing produces noise that must not read as
 * a dependency change, which genuinely invalidates any proof in flight.
 */
function isVersionOnlyPackageJsonBump(cwd: string, sinceSha: string): boolean {
  const diff = sh(ctx, ['git', 'diff', '--unified=0', `${sinceSha}...${REMOTE}/${BASE}`, '--', 'package.json'], cwd);
  const changed = diff.split('\n').filter((line) => /^[+-](?![+-])/.test(line));
  return changed.length > 0 && changed.every((line) => /^[+-]\s*"version":/.test(line));
}

function staleAgainstBase(cwd: string, sinceSha: string): string[] {
  sh(ctx, ['git', 'fetch', REMOTE, BASE], cwd);
  const lines = (out: string) => out.split('\n').filter(Boolean);

  // Release machinery rewrites its artifacts on every landing; a queue where each merge
  // invalidates every approval behind it re-reviews the same code for noise. Filter that
  // movement out before anything judges freshness. The branch merges without catching up on
  // these files: it does not touch them, so git merges them cleanly, and if a branch ever does
  // touch one, the merge conflicts and fails closed rather than landing anything unreviewed.
  const machineNoise = (file: string) =>
    RELEASE_ARTIFACTS.some((pattern) => matchesPath(file, pattern)) ||
    (file === 'package.json' && isVersionOnlyPackageJsonBump(cwd, sinceSha));

  const incoming = lines(sh(ctx, ['git', 'diff', '--name-only', `${sinceSha}...${REMOTE}/${BASE}`], cwd)).filter(
    (file) => !machineNoise(file),
  );
  if (incoming.length === 0) return [];

  const global = incoming.filter((file) => ALWAYS_INVALIDATES.some((pattern) => matchesPath(file, pattern)));
  if (global.length > 0) return global;

  const mine = lines(sh(ctx, ['git', 'diff', '--name-only', `${REMOTE}/${BASE}...HEAD`], cwd));
  const closure = importClosure(cwd, mine);
  if (closure.size > CLOSURE_CAP) return incoming;

  return incoming.filter((file) => closure.has(file));
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
      closeIssue(issue.number, result.closeComment ?? result.reason);
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

async function runWorker(issue: Issue, cwd: string, feedback?: ReviewResult): Promise<WorkerResult> {
  const prompt = renderPrompt(ctx, 'triage-and-fix.md', {
    ISSUE: String(issue.number),
    TITLE: issue.title,
    MAX_POINTS: String(MAX_POINTS),
    FEEDBACK: feedback
      ? `A reviewer has already seen your pull request and asked for more. Address every blocking item, ` +
        `push to the same branch, and update the proof comment.\n\n${JSON.stringify(feedback, null, 2)}`
      : 'This is the first attempt at this issue.',
  });

  // A revision is the exception: its lane holds the branch and the pull request under review, so a
  // reset would throw away work the reviewer already read. Only a first attempt may be reset.
  const { logPath, exitCode } = await runAgent(ctx, 
    feedback ? 'worker-revise' : 'worker',
    issue.number,
    cwd,
    SEATS.worker,
    prompt,
    feedback ? undefined : () => resetLane(ctx, issue.number, cwd),
  );
  if (exitCode !== 0) {
    return {
      issue: issue.number,
      verdict: 'failed',
      reason: `worker exited ${exitCode}, so its verdict is not trusted; log ends: ${logTail(logPath)}`,
    };
  }

  const result = readResult<WorkerResult>(cwd, 'loop-verdict.json');
  const KNOWN: Verdict[] = ['already-fixed', 'obsolete', 'needs-decision', 'needs-human', 'out-of-band', 'fixed', 'failed'];
  if (!result || !KNOWN.includes(result.verdict)) {
    return {
      issue: issue.number,
      verdict: 'failed',
      reason: result
        ? `worker verdict '${result.verdict}' is not one the driver knows; log ends: ${logTail(logPath)}`
        : `no verdict from the worker; log ends: ${logTail(logPath)}`,
    };
  }
  return result;
}

async function runReviewer(issue: number, pr: number, cwd: string, round: number): Promise<ReviewResult | null> {
  const prompt = renderPrompt(ctx, 'review.md', {
    PR: String(pr),
    ISSUE: String(issue),
    ROUND: String(round),
    MAX_ROUNDS: String(CONFIG.maxReviewRounds),
  });
  const { exitCode } = await runAgent(ctx, 'reviewer', issue, cwd, SEATS.reviewer, prompt);
  // A verdict from a process that failed is not a verdict; treating it as one is how a crashed
  // reviewer's parting words could approve a merge.
  if (exitCode !== 0) return null;
  const result = readResult<ReviewResult>(cwd, 'loop-review.json');
  if (!result) return null;
  // A verdict the driver acts on is validated, not trusted: an unknown decision must read as no
  // verdict at all, because anything that is not an explicit rejection would otherwise fall
  // through land() to the merge path. The PR number must also be the one under review.
  if (!['merge', 'gather-more', 'block'].includes(result.decision) || Number(result.pr) !== pr) {
    return null;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Acting on a verdict
// ---------------------------------------------------------------------------

/**
 * What the diff mechanically touches, computed from its paths against `project.touchPaths`.
 *
 * A classification that gates a merge must not rest on the author's self-report; a worker that
 * writes `["code"]` over a migration would otherwise sail through `code-only` on its own word.
 * Only `migration` and `ci` are path-shaped; `data` and `stored-string` name runtime effects a
 * path cannot reveal, so those remain self-reported by worker and reviewer.
 */
function computedTouches(cwd: string): Array<'migration' | 'ci'> {
  const files = sh(ctx, ['git', 'diff', '--name-only', `${REMOTE}/${BASE}...HEAD`], cwd)
    .split('\n')
    .filter(Boolean);
  const found: Array<'migration' | 'ci'> = [];
  for (const [kind, patterns] of Object.entries(PROJECT.touchPaths) as Array<['migration' | 'ci', string[]]>) {
    if (files.some((file) => patterns.some((pattern) => matchesPath(file, pattern)))) found.push(kind);
  }
  return found;
}

/**
 * The classification the merge decision actually uses: worker report, reviewer report, and the
 * computed paths, unioned, so an omission on any side can never widen what the loop may merge.
 *
 * Null when either agent did not classify at all, which fails closed downstream. An absent field
 * is not evidence of a code-only change (treating it as `[]` would let a migration through), and
 * the requirement is symmetric: for `data` and `stored-string` the path scan sees nothing, so the
 * reviewer's classification is the only independent check on the worker's, and a merge without it
 * would rest on one self-report.
 */
function effectiveTouches(
  reported: WorkerResult['touches'],
  reviewed: WorkerResult['touches'],
  cwd: string,
): WorkerResult['touches'] | null {
  if (!reported || reported.length === 0) return null;
  if (!reviewed || reviewed.length === 0) return null;
  return [...new Set([...reported, ...reviewed, ...computedTouches(cwd)])];
}

/** Whether the loop may merge this itself. Fails closed on a missing classification. */
function mergeAllowed(touches: WorkerResult['touches'] | null): boolean {
  if (CONFIG.autoMerge === 'never') return false;
  if (CONFIG.autoMerge === 'always') return true;
  if (!touches || touches.length === 0) return false;
  const risky = ['data', 'migration', 'stored-string', 'ci'];
  return !touches.some((t) => risky.includes(t));
}

/**
 * Confirms the pull request the driver is about to merge is the one that was reviewed.
 *
 * The worker reports its own PR number, and `gh pr merge` acts on whatever that PR's head is at the
 * moment it runs. Without this, a number pointing at an unrelated pull request, or a push landing
 * after the review, merges something no reviewer ever read.
 */
function pullRequestMatchesReview(pr: number, issue: number, cwd: string, reviewedSha: string): string | null {
  const raw = sh(ctx, ['gh', 'pr', 'view', String(pr), '--json', 'headRefOid,baseRefName,headRefName,state']);
  const view: { headRefOid: string; baseRefName: string; headRefName: string; state: string } = JSON.parse(raw);
  const localHead = sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);

  if (view.state !== 'OPEN') return `pull request is ${view.state}`;
  if (view.baseRefName !== BASE) return `targets ${view.baseRefName}, not ${BASE}`;
  if (!new RegExp(`(?:^|[^0-9])${issue}(?:[^0-9]|$)`).test(view.headRefName)) {
    return `branch ${view.headRefName} does not name issue ${issue}`;
  }
  if (view.headRefOid !== reviewedSha) return `head ${view.headRefOid.slice(0, 9)} is not the reviewed commit`;
  if (view.headRefOid !== localHead) return 'remote head and worktree head disagree';
  if (dirtyPaths(ctx, cwd).length > 0) return 'worktree has uncommitted changes';
  return null;
}

/** Whether a pull request is still a draft, which is the worker saying the work is unfinished. */
function isDraft(pr: number): boolean {
  return sh(ctx, ['gh', 'pr', 'view', String(pr), '--json', 'isDraft', '--jq', '.isDraft']) === 'true';
}

/**
 * The build gate: block until the pull request's checks are green, or say why they never will be.
 * Returns null when every check passed (or the repository runs none), otherwise a refusal reason.
 * Unknown states fail closed; a merge with a failing or unfinished build is never allowed.
 */
async function awaitGreenChecks(pr: number, say: (message: string) => void): Promise<string | null> {
  type CheckNode = { name?: string; context?: string; status?: string; conclusion?: string; state?: string };
  const GREEN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
  const RUNNING = new Set(['PENDING', 'EXPECTED', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'REQUESTED']);
  // GitHub renders an unfinished CheckRun with conclusion "" (empty string, not null), so a
  // nullish coalesce would read "" as a verdict and fail-close a merely-running check.
  const classify = (c: CheckNode): 'green' | 'pending' | 'failed' => {
    const verdict = c.conclusion || c.state || c.status || null;
    if (verdict === null || RUNNING.has(verdict)) return 'pending';
    return GREEN.has(verdict) ? 'green' : 'failed';
  };
  const nameOf = (c: CheckNode) => c.name ?? c.context ?? 'unnamed check';

  const deadline = Date.now() + CHECKS_TIMEOUT_MS;
  for (;;) {
    const raw = sh(ctx, ['gh', 'pr', 'view', String(pr), '--json', 'statusCheckRollup', '--jq', '.statusCheckRollup']);
    const rollup: CheckNode[] = raw ? JSON.parse(raw) : [];

    const failed = rollup.filter((c) => classify(c) === 'failed');
    if (failed.length > 0) {
      return `checks failed: ${failed.map((c) => `${nameOf(c)} (${c.conclusion || c.state || c.status})`).join(', ')}`;
    }

    const pending = rollup.filter((c) => classify(c) === 'pending');
    if (pending.length === 0) return null;
    if (Date.now() >= deadline) {
      return `checks still unfinished after ${Math.round(CHECKS_TIMEOUT_MS / 60000)} minutes: ${pending.map(nameOf).join(', ')}`;
    }
    say(`waiting on ${pending.length} unfinished check(s) before merging`);
    await Bun.sleep(30_000);
  }
}

function closeIssue(issue: number, comment: string): void {
  mutate(ctx, `comment on #${issue}`, ['gh', 'issue', 'comment', String(issue), '--body', comment]);
  mutate(ctx, `close #${issue}`, ['gh', 'issue', 'close', String(issue)]);
}

/**
 * The integration queue: the pull master.
 *
 * Coding is the concurrent part of this loop. Everything downstream of "I think this is done" is
 * sequential, one branch at a time, because the base branch is shared and a review is only good for
 * the commit it read. Bringing a branch up to date, reviewing it, and merging it all happen inside
 * this queue, so nothing can move the branch or the base between the read and the merge.
 */
let integrationQueue: Promise<unknown> = Promise.resolve();

function serializePullMaster<T>(action: () => Promise<T>): Promise<T> {
  const next = integrationQueue.then(action, action);
  integrationQueue = next.catch(() => undefined);
  return next;
}

type Reviewed = { review: ReviewResult; reviewedSha: string };
type Landing = 'merged' | 'park' | 'revise' | 'stale';

/**
 * Judge one branch. Runs outside the queue, so reviews overlap.
 *
 * This performs no git writes and no merge. It reads the tree as it stands, records the commit it
 * read, and returns the verdict; whether that verdict still applies at merge time is the pull
 * master's question, not this one's. Keeping review out of the serial section is what stops one
 * long review from holding up every other lane behind it.
 */
async function review(
  issue: Issue,
  pr: number,
  cwd: string,
  say: (message: string) => void,
  round: number,
): Promise<Reviewed | null> {
  // A draft is the worker's own statement that the work is not finished. Reviewing one wastes the
  // review and, worse, can approve a branch the worker still intends to push to.
  if (isDraft(pr)) {
    say('worker left the pull request in draft; treating it as incomplete');
    return null;
  }

  // A dirty tree means checks run against files that are not in the pull request: a worker's
  // uncommitted edit could make the reviewer's re-run pass while the clean remote commit fails.
  if (dirtyPaths(ctx, cwd).length > 0) {
    say('worktree has uncommitted changes; a review here would judge code that is not in the pull request');
    return null;
  }

  const reviewedSha = sh(ctx, ['git', 'rev-parse', 'HEAD'], cwd);
  const verdict = await runReviewer(issue.number, pr, cwd, round);
  if (!verdict) {
    say('reviewer wrote no verdict');
    return null;
  }
  say(`review: ${verdict.decision}; ${verdict.adequacy}`);
  return { review: verdict, reviewedSha };
}

/**
 * The pull master's turn: decide whether a finished review still applies, and if it does, merge.
 *
 * Exactly one of these runs at a time, because the base branch is shared. It holds no agent and
 * spawns none, so the serial section is short by construction.
 *
 * Freshness is judged against the reviewed commit rather than the current head. A branch that is
 * merely behind is left alone; per the freshness rule a receipt is true as of the commit it was
 * captured at, so upstream movement that does not reach this work leaves it standing. Movement that
 * does reach it invalidates the proof, so the branch catches up and is judged again.
 */
async function land(
  issue: Issue,
  pr: number,
  touches: WorkerResult['touches'],
  reviewed: Reviewed,
  cwd: string,
  say: (message: string) => void,
): Promise<Landing> {
  const { review: verdict, reviewedSha } = reviewed;

  // Rejections are judged before freshness, because staleness invalidates an approval and not a
  // rejection. A proof is pinned to the commit it was captured at, so movement into that commit can
  // make an approval describe something other than what would land; a rejection names a gap in the
  // work, and the base moving does not fill it. Re-reviewing one just re-derives it: the branch blocks,
  // catches up, and blocks again for the same reason.
  //
  // `gather-more` says the evidence is short; `block` says the change is. Both spend a round, both
  // go back to the author, and the per-issue budget bounds the retries with the DLQ underneath.
  if (verdict.decision === 'block' || verdict.decision === 'gather-more') {
    // Back to draft before anything is pushed: the catch-up below and the revision pushes that
    // follow must not each spend a CI run on a pull request still marked ready.
    mutate(ctx, `return PR #${pr} to draft for revision`, ['gh', 'pr', 'ready', String(pr), '--undo']);
    // Catch up anyway, so the revision happens against current code rather than against the base as
    // it stood when this branch started. Cheap here, and it saves the next review a refresh.
    const behind = staleAgainstBase(cwd, reviewedSha);
    if (behind.length > 0) {
      say(`catching up before the revision (${behind.join(', ')})`);
      if (!updateFromBase(ctx, cwd)) {
        // A parked pull request must not sit in draft: the human reading loop/parked would find a
        // branch the CI guard is configured to skip, and nothing else would ever flip it back.
        mutate(ctx, `mark PR #${pr} ready again before parking`, ['gh', 'pr', 'ready', String(pr)]);
        say(`conflicts with ${BASE}; a human has to resolve it`);
        return 'park';
      }
    }
    return 'revise';
  }

  // From here the verdict is `merge`, and only now does freshness decide anything.
  const overlap = staleAgainstBase(cwd, reviewedSha);
  if (overlap.length > 0) {
    say(`base moved into this work (${overlap.join(', ')}); the approval no longer describes what would land`);
    if (!updateFromBase(ctx, cwd)) {
      say(`conflicts with ${BASE}; a human has to resolve it`);
      return 'park';
    }
    return 'stale';
  }

  const effective = effectiveTouches(touches, verdict.touches, cwd);
  if (!mergeAllowed(effective)) {
    mutate(ctx, `park PR #${pr} (autoMerge: ${CONFIG.autoMerge}, touches ${effective?.join(', ') ?? 'unstated'})`, [
      'gh',
      'pr',
      'edit',
      String(pr),
      '--add-label',
      'loop/parked',
    ]);
    return 'park';
  }

  const mismatch = pullRequestMatchesReview(pr, issue.number, cwd, reviewedSha);
  if (mismatch) {
    say(`refusing to merge PR #${pr}: ${mismatch}`);
    return 'park';
  }

  // A failing or unfinished build never merges, whatever the review said. The reviewer watched
  // checks too, but its answer ages: any catch-up since the verdict pushed a head whose CI run
  // started fresh, and this is the last moment anything looks. Waiting here blocks the serial
  // queue, which is honest; a merge may not outrun its own build.
  const notGreen = await awaitGreenChecks(pr, say);
  if (notGreen) {
    say(`refusing to merge PR #${pr}: ${notGreen}`);
    return 'park';
  }

  // `--match-head-commit` makes the merge itself refuse if the head moved between this check and
  // the call, so the commit that lands is the commit that was read.
  mutate(ctx, `merge PR #${pr}`, ['gh', 'pr', 'merge', String(pr), '--merge', '--match-head-commit', reviewedSha]);

  // Confirm it actually landed before closing anything. On a repository with a merge queue or
  // auto-merge, `gh pr merge` can enqueue rather than merge; a queued pull request would land
  // later while this driver has already parked it, so cancel whatever was scheduled first.
  const merged = sh(ctx, ['gh', 'pr', 'view', String(pr), '--json', 'mergedAt', '--jq', '.mergedAt']);
  if (!merged || merged === 'null') {
    try {
      sh(ctx, ['gh', 'pr', 'merge', String(pr), '--disable-auto']);
    } catch {
      // nothing was scheduled
    }
    say(`PR #${pr} did not report a merge; cancelled any queued merge and left the worktree and issue alone`);
    return 'park';
  }

  // Read the branch name while the worktree still exists, then drop it.
  const branch = sh(ctx, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  removeWorktree(ctx, issue.number);
  try {
    sh(ctx, ['git', 'push', REMOTE, '--delete', branch]);
  } catch {
    say(`merged branch ${branch} was already deleted`);
  }
  closeIssue(issue.number, `Closed by #${pr}.`);
  return 'merged';
}

async function handleIssue(issue: Issue): Promise<void> {
  // Lanes interleave, so every line an issue emits names the issue. Without this the console is a
  // shuffled deck of verdicts with no way to tell which belongs to which.
  const say = (message: string) => log(`#${issue.number}  ${message}`);
  step(`#${issue.number} ${issue.title}`);

  // Even in a dry run the path is the worktree's, never the main checkout, so nothing downstream
  // learns to treat REPO_ROOT as a valid agent working directory.
  const cwd = DRY_RUN ? resolve(REPO_ROOT, PROJECT.worktreeRoot, `issue-${issue.number}`) : worktreeFor(ctx, issue.number);
  inFlight.set(issue.number, { dir: cwd, busy: false });
  try {
    await workIssue(issue, cwd, say);
  } finally {
    inFlight.delete(issue.number);

    // Whatever the outcome, this lane is finished with the directory, so it goes here rather than
    // at each of the eight exits that used to leak one. Nothing in-process reads it again, and
    // `findStranded` resumes only a `fixed` verdict whose pull request is open at the same head on
    // an unlabelled issue; every outcome that reaches this line (failed, parked, DLQed, budget
    // exhausted, terminal verdict, merged) is one it already refuses. Removing the worktree also
    // sweeps the `issue-N-<scratch>` siblings agents make for evidence capture, which nothing else
    // reclaims. A crash never runs this block, which is exactly when resume should get its chance,
    // so `reconcile` still owns that case on the next start.
    if (!DRY_RUN) removeWorktree(ctx, issue.number);
  }
}

/**
 * Acts on a worker verdict that ends an issue without a merge. Returns true when it was terminal.
 *
 * Runs after the first attempt and again after every revision: the base moving mid-issue can make
 * a revising worker's honest answer `already-fixed`, and that verdict earns its close whenever it
 * arrives. An earlier version only consulted the first verdict, so a terminal answer from a
 * revision fell through to `loop/parked` and the close it earned never happened. When a pull
 * request already exists it is closed too, so a terminal verdict does not strand an open draft.
 */
function settleTerminalVerdict(issue: Issue, result: WorkerResult, pr?: number): boolean {
  const closePullRequest = () => {
    if (pr) mutate(ctx, `close PR #${pr}`, ['gh', 'pr', 'close', String(pr), '--comment', 'Superseded; see the issue.']);
  };

  switch (result.verdict) {
    case 'already-fixed':
    case 'obsolete':
      closeIssue(issue.number, result.closeComment ?? result.reason);
      closePullRequest();
      removeWorktree(ctx, issue.number);
      return true;

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
      closePullRequest();
      removeWorktree(ctx, issue.number);
      return true;

    case 'out-of-band': {
      if (result.points) {
        mutate(ctx, `size #${issue.number} at ${result.points}`, [
          'gh',
          'issue',
          'edit',
          String(issue.number),
          '--add-label',
          `size: ${result.points}`,
        ]);
        // Two size labels would leave selection reading whichever it finds; add-then-remove plus
        // pointsFromLabels reading the max keeps the issue out of the band during the swap.
        const prior = issue.labels.find((l) => /^size:\s*\d+$/.test(l.name) && l.name !== `size: ${result.points}`);
        if (prior) {
          mutate(ctx, `clear ${prior.name} on #${issue.number}`, [
            'gh',
            'issue',
            'edit',
            String(issue.number),
            '--remove-label',
            prior.name,
          ]);
        }
      }
      closePullRequest();
      removeWorktree(ctx, issue.number);
      return true;
    }

    default:
      return false;
  }
}

async function workIssue(issue: Issue, cwd: string, say: (message: string) => void): Promise<void> {
  const result = await runWorker(issue, cwd);
  say(`verdict: ${result.verdict}; ${result.reason}`);

  if (result.verdict === 'failed') {
    say('worker failed; leaving it untouched');
    return;
  }
  if (settleTerminalVerdict(issue, result)) return;

  await reviewAndLand(issue, cwd, result, say);
}

/**
 * The review pipeline for a pull request that exists: review, land, revise, until it merges,
 * parks, or exhausts its budget. Split from workIssue so a restart can re-enter it: a dead run's
 * worktree still holds the worker's verdict file, and resuming from that file is what un-strands
 * a pull request the crash left behind (see findStranded).
 *
 * From here the work is sequential. Coding is the concurrent part; integration is a pull master
 * working a queue, one branch at a time. The queue keeps this loop's own lanes from moving the
 * branch or the base between the read and the merge; GitHub itself still can, which is why the
 * merge pins the head with --match-head-commit and confirms mergedAt afterwards.
 *
 * The budget is a per-issue high-water mark, not a per-run allowance. An issue that spent two
 * rounds in an earlier run starts this one with one left, because the count lives on the issue
 * and the process does not. That is the whole point: it is what stops an issue cycling between
 * worker and reviewer forever, one restart at a time, with nothing accumulating against it.
 */
async function reviewAndLand(
  issue: Issue,
  cwd: string,
  first: WorkerResult,
  say: (message: string) => void,
): Promise<void> {
  let result = first;
  let consumed = reviewCount(issue.labels);
  let refreshes = 0;
  while (consumed < CONFIG.maxReviewRounds) {
    if (!result.pr) break;
    const pr = result.pr;
    const touches = result.touches;

    if (DRY_RUN) break;

    // Reviewing happens here, outside the queue, so lanes review at the same time.
    const reviewed = await review(issue, pr, cwd, say, consumed + 1);
    if (!reviewed) break;

    // Merging happens there, one branch at a time, because the base branch is shared.
    const outcome = await serializePullMaster(async () => land(issue, pr, touches, reviewed, cwd, say));
    if (outcome === 'merged') return;

    // The base reached this work while the review was running. That is upstream churn, not a defect
    // in the change, so it costs a fresh review but not a round of the issue's budget. Bounded:
    // a base that keeps landing into these files would otherwise re-review forever.
    if (outcome === 'stale') {
      refreshes += 1;
      if (refreshes > MAX_BASE_REFRESHES) {
        say(`base moved into this work ${refreshes} times; a human should land it`);
        break;
      }
      continue;
    }

    const { review: verdict } = reviewed;

    // A verdict was reached and the work goes back or stops, so the round is spent whether the
    // outcome is a revision or a park. Recorded before the revision starts rather than after it
    // finishes, so a run killed mid-revision still leaves the budget honest; the alternative
    // silently refunds a round every time a run dies. A merge ends the accounting instead: the
    // issue is closing, and label churn on a closed issue records nothing anyone reads.
    consumed = recordReview(issue.number, consumed);
    say(`review round ${consumed} of ${CONFIG.maxReviewRounds}`);

    if (outcome === 'park') break;

    if (consumed >= CONFIG.maxReviewRounds) {
      sendToDlq(issue.number, consumed, verdict.blocking.length > 0 ? verdict.blocking.join('\n') : verdict.adequacy);
      say(`ejected to the DLQ after ${consumed} review rounds`);
      return;
    }

    // Revision is programming, so it happens outside the queue; the branch rejoins it afterwards.
    // The pull request is already back in draft: land() flips it before any catch-up push.
    result = await runWorker(issue, cwd, verdict);
    say(`verdict: ${result.verdict}; ${result.reason}`);
    if (result.verdict === 'failed') break; // an open pull request now needs a human
    if (settleTerminalVerdict(issue, result, pr)) return;
  }

  mutate(ctx, `park #${issue.number}`, ['gh', 'issue', 'edit', String(issue.number), '--add-label', 'loop/parked']);
  say('parked for a human');
}

/**
 * Pull requests a dead run left behind, paired with the worktree and verdict to resume them from.
 *
 * Selection refuses an issue an open pull request claims, and reconcile deliberately leaves that
 * worktree standing, so without a resume path a crash after PR creation stranded finished work
 * until a human noticed. The worker's verdict file survives in the worktree and carries everything
 * reviewAndLand needs. A stranded worktree without a usable verdict is only reported: that crash
 * window (after the PR, before the verdict) leaves nothing safe to resume from.
 */
function findStranded(all: Issue[]): Array<{ issue: Issue; cwd: string; result: WorkerResult }> {
  const managed = resolve(REPO_ROOT, PROJECT.worktreeRoot);
  const found: Array<{ issue: Issue; cwd: string; result: WorkerResult }> = [];

  for (const line of sh(ctx, ['git', 'worktree', 'list', '--porcelain']).split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const dir = resolve(line.slice('worktree '.length).trim());
    if (!dir.startsWith(`${managed}/`)) continue;
    const num = /issue-(\d+)$/.exec(dir)?.[1];
    if (!num) continue;
    if (inFlight.has(Number(num))) continue;

    const issue = all.find((candidate) => candidate.number === Number(num));
    if (!issue) continue; // closed or outside the window; reconcile owns the cleanup question

    // The safety labels that gate selection gate resumption too: a parked, skipped, DLQed, or
    // budget-exhausted issue belongs to a human even when a worktree still remembers it.
    if (issue.labels.some((l) => CONFIG.skipLabels.includes(l.name) || l.name === 'loop/dlq')) continue;
    if (reviewCount(issue.labels) >= CONFIG.maxReviewRounds) continue;

    const verdict = parseJsonFile<WorkerResult>(join(dir, VERDICT_FILE));
    if (!verdict || verdict.verdict !== 'fixed' || !verdict.pr) {
      log(`#${num}  stranded worktree has no usable verdict; leaving it for a human`);
      continue;
    }
    // The verdict is trusted only as far as it can be corroborated: it must name this issue, and
    // the worktree must sit at the pull request's remote head, or the resume would review a tree
    // that is not what would merge.
    if (Number(verdict.issue) !== issue.number) {
      log(`#${num}  stranded verdict names issue ${verdict.issue}; leaving it for a human`);
      continue;
    }
    const view: { state: string; headRefOid: string } = JSON.parse(
      sh(ctx, ['gh', 'pr', 'view', String(verdict.pr), '--json', 'state,headRefOid']),
    );
    if (view.state !== 'OPEN') continue;
    if (view.headRefOid !== sh(ctx, ['git', 'rev-parse', 'HEAD'], dir)) {
      log(`#${num}  stranded worktree head is not the pull request head; leaving it for a human`);
      continue;
    }
    found.push({ issue, cwd: dir, result: verdict });
  }
  return found;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // A read-only probe of the import-closure walk, for verifying a port's `pathAliases` before any
  // agent runs. A closure of one module (only the entry) means aliases resolve nothing, which is
  // the silent failure that degrades staleness to filename comparison.
  if (CLOSURE_PROBE) {
    // Scan the invoking checkout, not the main one: from a linked worktree the two can hold
    // different branches, and the probe must inspect the tree the config under test describes.
    const closure = importClosure(INVOKE_ROOT, [CLOSURE_PROBE]);
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

  ensureLabels();
  if (!DRY_RUN) {
    reconcile();

    // Half-written label transitions are repaired before anything reads them, so a crash mid-DLQ
    // or mid-count-swap costs one repair pass rather than a permanently wedged issue.
    repairDurableState(allIssues());

    // Resume before selecting anything new: a stranded pull request is finished work, and landing
    // it first also moves the base before fresh lanes cut their branches from it. Re-read the
    // issues rather than reusing the repair pass's snapshot; the repair may have moved labels.
    const stranded = findStranded(allIssues());
    if (stranded.length > 0) {
      step(`Resuming ${stranded.length} stranded pull request(s) from an earlier run`);
      log(stranded.map((s) => `#${s.issue.number} (PR #${s.result.pr})`).join(', '));
      await pool(
        stranded.map((s) => s.issue),
        CONFIG.concurrency,
        async (issue) => {
          const entry = stranded.find((s) => s.issue.number === issue.number);
          if (!entry) return;
          const say = (message: string) => log(`#${issue.number}  ${message}`);
          inFlight.set(issue.number, { dir: entry.cwd, busy: false });
          try {
            await reviewAndLand(issue, entry.cwd, entry.result, say);
          } finally {
            inFlight.delete(issue.number);
          }
        },
        (issue) => `#${issue.number}`,
      );
    }
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
  await pool(candidates, CONFIG.concurrency, handleIssue, (issue) => `#${issue.number}`);

  step('done');
}

await main();
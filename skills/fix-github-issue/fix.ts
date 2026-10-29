/**
 * fix-github-issue: fix one known issue end to end, headless.
 *
 * A worker in its own git worktree opens a draft pull request with its proof, a reviewer with no
 * shared context judges it, and a pull master merges it or hands it to a human. This file is the
 * command; the pipeline it drives is in `lib/`, and another driver can call `fixIssue` directly.
 *
 * This file is shared: it ships with the skill and is not copied into a repository. Everything
 * true of a repository lives in a config file at that repository's root. Run it from inside the
 * target repository:
 *
 *   bun run <skill-dir>/fix.ts --issue <n>
 *   bun run <skill-dir>/fix.ts --issue <n> --dry-run
 *   bun run <skill-dir>/fix.ts --issue <n> --worker codex:gpt-5.6-sol --reviewer claude:claude-opus-5
 *   bun run <skill-dir>/fix.ts --issue <n> --redrive          # lift a park or dead letter and continue its pull request
 *   bun run <skill-dir>/fix.ts --issue <n> --land             # land an approved pull request the merge boundary parked
 *   bun run <skill-dir>/fix.ts --issue <n> --resume-pr <pr>   # continue that pull request rather than open another
 *
 * With a board (the burndown's board.ts has run for this repository) every move the pipeline makes
 * is written to the issue's card, and the card is placed by the issue's facts before anything runs.
 *
 * Hard dependency: the sibling `prove-work-on-github` skill. Both prompts load it by name, and the
 * staleness rule in lib/staleness.ts implements its references/freshness-and-reproof.md.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enrichBlockers } from './lib/blockers.ts';
import {
  invokeRootFrom,
  loadProjectConfig,
  PIPELINE_DEFAULTS,
  type PipelineKnobs,
  repoRootFrom,
} from './lib/config.ts';
import { createContext } from './lib/context.ts';
import { parseSeat, seatLabel } from './lib/engines.ts';
import { createBoardWriter, placeByFacts, readBoardPointer } from '../burn-down-github-issues/lib/board-writer.ts';
import { clearCount, ensureLabels, isDlqLabel, liftDlq, recordRedrive, redriveCount } from './lib/labels.ts';
import { landBlocker } from './lib/land.ts';
import { fixIssue, type Issue, redriveIssue } from './lib/pipeline.ts';
import { guardCli } from './lib/cli.ts';
import { log, mutate, sh, step } from './lib/shell.ts';
import { installStopHandler } from './lib/stop.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPTS = join(HERE, 'prompts');

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Every flag this command reads is named here; fix.usage.test.ts holds the two lists together. */
export const USAGE = `fix-github-issue: fix one known issue end to end, headless. Run it from inside the target repository.

  bun run <skill-dir>/fix.ts --issue <n> [flags]

  --issue <n>        the issue to fix (required)
  --dry-run          rehearse: no agent is run and nothing is written; say what would happen
  --max-points <n>   the largest size the worker may take on (default: the config's)
  --worker <seat>    engine[:model] for the worker seat, for example codex:gpt-5.6-sol
  --reviewer <seat>  engine[:model] for the reviewer seat; a different engine from the worker
  --confirmer <seat> engine[:model] for the seat that re-checks a close the worker proposes; without it the
                     config's confirmer, else the config's reviewer (--reviewer does not change this),
                     and it must be a different engine from the worker
  --redrive          lift a park or a dead letter and continue the issue's pull request
  --land             a person's go-ahead past the merge boundary for a pull request it parked: lift only
                     that park, re-prove and re-review the pull request, and land it with every other
                     gate in force; refuses a dead letter or any other park (use --redrive)
  --resume-pr <pr>   continue that pull request rather than open another
  --help, -h         print this and exit

Ctrl+C stops the run: its agent is killed, nothing is settled from it, and its claim is released.`;

/** Every flag this command reads, for the guard: an argument it does not know must never fall through to a real run. */
export const CLI = { flags: ['dry-run', 'redrive', 'land'], options: ['issue', 'max-points', 'worker', 'reviewer', 'confirmer', 'resume-pr'] } as const;
guardCli(args, CLI, USAGE);

const DRY_RUN = flag('dry-run');
/** `--land` is a redrive the person has also cleared past the merge boundary, for this issue only. */
const LAND = flag('land');
const REDRIVE = flag('redrive');
if (LAND && REDRIVE) {
  console.error('--land and --redrive are different acts; give one');
  process.exit(1);
}

const ISSUE_NUMBER = (() => {
  const raw = opt('issue');
  const parsed = Number(raw);
  if (raw === undefined || !Number.isInteger(parsed) || parsed <= 0) {
    console.error(`--issue expects an issue number, got '${raw ?? 'nothing'}'`);
    process.exit(1);
  }
  return parsed;
})();

const REPO_ROOT = repoRootFrom(process.cwd());
const INVOKE_ROOT = invokeRootFrom(process.cwd(), REPO_ROOT);

/**
 * Its own config when the repository has one, the burndown's otherwise, reading only the fields it
 * needs. An adopter of the burndown gets this command without writing a second file.
 */
const CONFIG_FILE = ['fix-github-issue.config.ts', 'burn-down-github-issues.config.ts'].find((name) =>
  existsSync(join(INVOKE_ROOT, name)),
);

type FixKnobs = PipelineKnobs & { maxPoints: number };

/** What the worker prompt asks for when neither the config nor the command states a ceiling. */
const FIX_DEFAULTS: FixKnobs = { ...PIPELINE_DEFAULTS, maxPoints: 2 };

const CONFIG = await loadProjectConfig<FixKnobs>({
  invokeRoot: INVOKE_ROOT,
  repoRoot: REPO_ROOT,
  fileName: CONFIG_FILE ?? 'fix-github-issue.config.ts',
  defaults: FIX_DEFAULTS,
  positiveIntegers: ['maxReviewRounds', 'maxPoints', 'checksTimeoutMinutes', 'smokeTimeoutMinutes', 'maxWorkerAttempts'],
  help: [
    'This pipeline is shared across repositories; everything true of a repository lives in that file.',
    'Copy the template from references/adopting.md in the burn-down-github-issues skill and fill it in.',
  ],
});

const SEATS = (() => {
  try {
    return {
      worker: parseSeat(opt('worker') ?? CONFIG.seats.worker, '--worker'),
      reviewer: parseSeat(opt('reviewer') ?? CONFIG.seats.reviewer, '--reviewer'),
      confirmer: parseSeat(opt('confirmer') ?? CONFIG.seats.confirmer ?? CONFIG.seats.reviewer, '--confirmer'),
    };
  } catch (error) {
    // A mistyped engine deserves the composed message, not a raw stack trace.
    console.error((error as Error).message);
    process.exit(1);
  }
})();

const BOARD = (() => {
  const pointer = readBoardPointer(REPO_ROOT, CONFIG.project.worktreeRoot);
  return pointer ? createBoardWriter(pointer, CONFIG.project.repo, log) : undefined;
})();

const ctx = createContext({
  project: CONFIG.project,
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
  seats: SEATS,
  repoRoot: REPO_ROOT,
  invokeRoot: INVOKE_ROOT,
  // The appraiser's prompts too: a worker's close is confirmed with the appraiser's confirmer prompt.
  promptsDirs: [PROMPTS, join(HERE, '..', 'appraise-github-issues', 'prompts')],
  dryRun: DRY_RUN,
  landPastBoundary: LAND ? ISSUE_NUMBER : undefined,
  onLane: BOARD && !DRY_RUN ? BOARD.onLane : undefined,
});

// Agents run under their own process group, so a signal to this driver does not reach them on its
// own: without a handler, Ctrl+C would leave the agent running with its approvals bypassed.
installStopHandler(log);

step(`${ctx.project.name} fix-github-issue`);
log(`base ${ctx.project.baseBranch} | merge: ${ctx.knobs.autoMerge} | config ${CONFIG_FILE}`);
log(`worker ${seatLabel(SEATS.worker)} | reviewer ${seatLabel(SEATS.reviewer)} | confirmer ${seatLabel(SEATS.confirmer)}`);
if (SEATS.worker.engine === SEATS.reviewer.engine) {
  log("WARNING: worker and reviewer share an engine, so the merge gate shares the author's blind spots");
}
if (DRY_RUN) log('DRY RUN: no GitHub mutation and no agent will run');
log(BOARD ? `board #${BOARD.board.number} ${BOARD.board.url}` : 'no board pointer; cards will not move');

const issue: Issue & { state: 'OPEN' | 'CLOSED' } = JSON.parse(
  sh(ctx, ['gh', 'issue', 'view', String(ISSUE_NUMBER), '--json', 'number,title,createdAt,labels,parent,subIssuesSummary,blockedBy,state']),
);

enrichBlockers(ctx, [issue]);

/** The pull requests that reference this issue, newest first; the head branch is what a redrive checks out. */
const PULLS: Array<{ number: number; isDraft: boolean; merged: boolean; headRefName: string; state: string }> = (() => {
  const raw = sh(ctx, ['gh', 'pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,isDraft,mergedAt,headRefName,body,title,state']);
  const all = JSON.parse(raw) as Array<{ number: number; isDraft: boolean; mergedAt: string | null; headRefName: string; body: string; title: string; state: string }>;
  // A pull request is this issue's when the loop's branch convention names it or its body
  // references it with a keyword; a passing mention in another change's body is not a claim.
  const refers = new RegExp(`\\b(fixes|closes|resolves|refs?)\\s+#${ISSUE_NUMBER}(?![0-9])`, 'i');
  return all
    .filter((pr) => pr.headRefName.endsWith(`-${ISSUE_NUMBER}`) || refers.test(pr.body ?? ''))
    .map((pr) => ({ number: pr.number, isDraft: pr.isDraft, merged: pr.mergedAt !== null, headRefName: pr.headRefName, state: pr.state }));
})();

// An open pull request to continue: named, or the newest open one that references the issue.
const RESUME_PR = (() => {
  const raw = opt('resume-pr');
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      console.error(`--resume-pr expects a pull request number, got '${raw}'`);
      process.exit(1);
    }
    const found = PULLS.find((pr) => pr.number === n);
    if (!found || found.state !== 'OPEN') {
      console.error(`--resume-pr ${n}: not an open pull request that references #${ISSUE_NUMBER}`);
      process.exit(1);
    }
    return found;
  }
  return REDRIVE || LAND ? PULLS.find((pr) => pr.state === 'OPEN' && !pr.merged) : undefined;
})();

// `--land` waives the merge boundary and nothing else, so everything it needs is checked before
// anything is written, labels and board included: the one pull request it will land, and a park the
// boundary wrote. Then only the park comes off, on the issue and that pull request.
if (LAND) {
  if (!RESUME_PR) {
    console.error(`--land needs an open pull request that references #${ISSUE_NUMBER}; there is none`);
    process.exit(1);
  }
  const comments = JSON.parse(sh(ctx, ['gh', 'issue', 'view', String(ISSUE_NUMBER), '--json', 'comments', '--jq', '[.comments[] | { body, createdAt }]'])) as Array<{ body: string; createdAt: string }>;
  const parkedAt = sh(ctx, ['gh', 'api', `repos/${ctx.project.repo}/issues/${ISSUE_NUMBER}/events`, '--paginate', '--jq', '.[] | select(.event == "labeled" and .label.name == "loop/parked") | .created_at'])
    .split('\n')
    .filter(Boolean)
    .at(-1) ?? null;
  const blocker = landBlocker(issue.labels.map((l) => l.name), comments, parkedAt);
  if (blocker) {
    console.error(`--land refuses #${ISSUE_NUMBER}: ${blocker}`);
    process.exit(1);
  }
  mutate(ctx, `lift loop/parked on #${ISSUE_NUMBER} (land)`, ['gh', 'issue', 'edit', String(ISSUE_NUMBER), '--remove-label', 'loop/parked']);
  mutate(ctx, `lift loop/parked on PR #${RESUME_PR.number} (land)`, ['gh', 'pr', 'edit', String(RESUME_PR.number), '--remove-label', 'loop/parked']);
  issue.labels = issue.labels.filter((l) => l.name !== 'loop/parked');
}

// The labels the pipeline writes have to exist before it writes one; creating them is idempotent.
ensureLabels(ctx);

// A person driving one issue may raise the ceiling for that issue alone: a sized-over pull
// request that already exists still has to be caught up, re-reviewed, and landed by someone.
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

// Where the facts put the card before anything runs; the pipeline moves it from here.
const placed = placeByFacts({
  state: issue.state,
  labels: issue.labels.map((l) => l.name),
  pulls: PULLS.filter((pr) => pr.state !== 'CLOSED' || pr.merged),
  points: (() => {
    const size = issue.labels.map((l) => /^size:\s*(\d+)$/.exec(l.name)?.[1]).find(Boolean);
    return size ? Number(size) : undefined;
  })(),
  ceiling: MAX_POINTS,
});
log(`facts place #${ISSUE_NUMBER} in ${placed.lane} (${placed.why})`);
if (BOARD && !DRY_RUN) BOARD.onLane({ issue: issue.number, title: issue.title, lane: placed.lane, note: placed.why });

// A redrive is a person's act: lifting the hold is what makes the live gate let the issue through,
// and the count labels come off with it so the fresh budget is real. The redrive itself is
// counted, so a thread that keeps coming back shows how many times on its labels.
if (REDRIVE) {
  const lifted = liftDlq(ctx, ISSUE_NUMBER, issue.labels);
  if (issue.labels.some((l) => l.name === 'loop/parked')) {
    mutate(ctx, `lift loop/parked on #${ISSUE_NUMBER} (redrive)`, ['gh', 'issue', 'edit', String(ISSUE_NUMBER), '--remove-label', 'loop/parked']);
    lifted.push('loop/parked');
  }
  if (lifted.length > 0) recordRedrive(ctx, ISSUE_NUMBER, redriveCount(issue.labels));
  clearCount(ctx, 'reviews', ISSUE_NUMBER);
  clearCount(ctx, 'attempts', ISSUE_NUMBER);
  issue.labels = issue.labels.filter((l) => !isDlqLabel(l.name) && l.name !== 'loop/parked' && !/^loop\/(reviews|attempts):/.test(l.name));
}

// The pull request carries the same hold its issue did; a redrive lifts both, or a merged pull
// request keeps saying parked.
if (REDRIVE && RESUME_PR && !DRY_RUN) {
  const held = sh(ctx, ['gh', 'pr', 'view', String(RESUME_PR.number), '--json', 'labels', '--jq', '.labels[].name'])
    .split('\n')
    .filter((name) => name === 'loop/parked' || isDlqLabel(name));
  for (const name of held) mutate(ctx, `lift ${name} on PR #${RESUME_PR.number} (redrive)`, ['gh', 'pr', 'edit', String(RESUME_PR.number), '--remove-label', name]);
}

/** The objection that stopped the work last time: the newest dead-letter or park comment on the thread. */
const OBJECTION = (() => {
  const raw = sh(ctx, ['gh', 'issue', 'view', String(ISSUE_NUMBER), '--json', 'comments', '--jq', '[.comments[] | select(.body | test("dead-letter queue|parked|Parked"))] | last | .body // ""']);
  return raw.trim() || 'The pull request was stopped before it could land; finish it and re-prove it.';
})();

// A landing has no objection to answer: the work was approved and only the boundary stopped it,
// so the pull request goes to Proving and review, not back to a coder.
const result = RESUME_PR
  ? await redriveIssue(ctx, issue, { number: RESUME_PR.number, branch: RESUME_PR.headRefName }, LAND ? null : OBJECTION, { maxPoints: MAX_POINTS, landing: LAND })
  : await fixIssue(ctx, issue, { maxPoints: MAX_POINTS });
step(`${result.outcome}`);
log(result.reason);
if (result.outcome === 'failed') process.exitCode = 1;

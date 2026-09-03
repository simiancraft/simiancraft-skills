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
 *
 * Hard dependency: the sibling `prove-work-on-github` skill. Both prompts load it by name, and the
 * staleness rule in lib/staleness.ts implements its references/freshness-and-reproof.md.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  invokeRootFrom,
  loadProjectConfig,
  PIPELINE_DEFAULTS,
  type PipelineKnobs,
  repoRootFrom,
} from './lib/config.ts';
import { createContext } from './lib/context.ts';
import { parseSeat, seatLabel } from './lib/engines.ts';
import { ensureLabels } from './lib/labels.ts';
import { fixIssue, type Issue } from './lib/pipeline.ts';
import { log, sh, step } from './lib/shell.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPTS = join(HERE, 'prompts');

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const DRY_RUN = flag('dry-run');

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
  positiveIntegers: ['maxReviewRounds', 'maxPoints', 'checksTimeoutMinutes', 'smokeTimeoutMinutes'],
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

const ctx = createContext({
  project: CONFIG.project,
  knobs: {
    autoMerge: CONFIG.autoMerge,
    maxReviewRounds: CONFIG.maxReviewRounds,
    checksTimeoutMinutes: CONFIG.checksTimeoutMinutes,
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
});

step(`${ctx.project.name} fix-github-issue`);
log(`base ${ctx.project.baseBranch} | merge: ${ctx.knobs.autoMerge} | config ${CONFIG_FILE}`);
log(`worker ${seatLabel(SEATS.worker)} | reviewer ${seatLabel(SEATS.reviewer)} | confirmer ${seatLabel(SEATS.confirmer)}`);
if (SEATS.worker.engine === SEATS.reviewer.engine) {
  log("WARNING: worker and reviewer share an engine, so the merge gate shares the author's blind spots");
}
if (DRY_RUN) log('DRY RUN: no GitHub mutation and no agent will run');

const issue: Issue = JSON.parse(
  sh(ctx, ['gh', 'issue', 'view', String(ISSUE_NUMBER), '--json', 'number,title,createdAt,labels,parent,subIssuesSummary,blockedBy']),
);

// The labels the pipeline writes have to exist before it writes one; creating them is idempotent.
ensureLabels(ctx);

const result = await fixIssue(ctx, issue, { maxPoints: CONFIG.maxPoints });
step(`${result.outcome}`);
log(result.reason);
if (result.outcome === 'failed') process.exitCode = 1;

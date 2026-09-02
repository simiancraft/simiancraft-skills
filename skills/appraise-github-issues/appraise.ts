/**
 * appraise-github-issues: size the backlog, close what is done, hand off what needs a person.
 *
 * One read-only agent turn per issue answers two questions, is it still real and how big is it,
 * and the answer lands on the issue as a `size: N` label, a `needs-decision` or `needs-human`
 * label with the question stated, or a close with a re-checkable receipt. A close is confirmed by
 * a second engine before it is made. This file is the command; the library it drives is in `lib/`,
 * and another driver (the issue burndown) calls `appraiseIssue` directly.
 *
 * This file is shared: it ships with the skill and is not copied into a repository. Everything
 * true of a repository lives in a config file at that repository's root. Run it from inside the
 * target repository:
 *
 *   bun run <skill-dir>/appraise.ts --dry-run             # select and print; no agent, no mutation
 *   bun run <skill-dir>/appraise.ts --limit 12            # appraise up to 12 unsized issues in the window
 *   bun run <skill-dir>/appraise.ts --issue <n>           # one issue, whatever its age or size
 *   bun run <skill-dir>/appraise.ts --all                 # the whole open backlog, not only the window
 *   bun run <skill-dir>/appraise.ts --include-sized       # re-judge issues that already carry a size
 *   bun run <skill-dir>/appraise.ts --every 60            # a heartbeat: appraise whatever is new, hourly
 *   bun run <skill-dir>/appraise.ts --no-confirm          # close on the appraiser's word alone
 *   bun run <skill-dir>/appraise.ts --appraiser codex:gpt-5.6-sol --confirmer claude:claude-opus-5
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeRootFrom, loadProjectConfig, PIPELINE_DEFAULTS, type PipelineKnobs, repoRootFrom } from '../fix-github-issue/lib/config.ts';
import { createContext } from '../fix-github-issue/lib/context.ts';
import { parseSeat, seatLabel } from '../fix-github-issue/lib/engines.ts';
import { claimLock } from '../fix-github-issue/lib/lane.ts';
import { ensureLabels } from '../fix-github-issue/lib/labels.ts';
import type { Issue } from '../fix-github-issue/lib/pipeline.ts';
import { pool } from '../fix-github-issue/lib/pool.ts';
import { shutdownAgents } from '../fix-github-issue/lib/agent.ts';
import { log, sh, step, teeConsole } from '../fix-github-issue/lib/shell.ts';
import { allOpenIssues, APPRAISE_DEFAULTS, type AppraiseKnobs, appraiseIssue, assertConfirmCloses, isHeld, selectForAppraisal } from './lib/appraise.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPTS = join(HERE, 'prompts');

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
/** The value after `--name`; a present flag with no value (end of argv, or another flag) is an error, not an absence. */
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`--${name} needs a value`);
    process.exit(1);
  }
  return value;
};
const positive = (name: string, fallback: number): number => {
  const raw = opt(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`--${name} expects a positive integer, got '${raw}'`);
    process.exit(1);
  }
  return parsed;
};

const DRY_RUN = flag('dry-run');
const ALL_AGES = flag('all');
const INCLUDE_SIZED = flag('include-sized');
const NO_CONFIRM = flag('no-confirm');
const ISSUE_NUMBER = opt('issue') !== undefined ? positive('issue', 0) : null;
const EVERY = opt('every') !== undefined ? positive('every', 0) : null;

const REPO_ROOT = repoRootFrom(process.cwd());
const INVOKE_ROOT = invokeRootFrom(process.cwd(), REPO_ROOT);

/**
 * Its own config when the repository has one, the burndown's otherwise, reading only the fields it
 * needs. An adopter of the burndown gets this command without writing a second file.
 */
const CONFIG_FILE = ['appraise-github-issues.config.ts', 'burn-down-github-issues.config.ts'].find((name) =>
  existsSync(join(INVOKE_ROOT, name)),
);

const CONFIG = await loadProjectConfig<PipelineKnobs & AppraiseKnobs & { seats: AppraiseKnobs['seats'] & PipelineKnobs['seats'] }>({
  invokeRoot: INVOKE_ROOT,
  repoRoot: REPO_ROOT,
  fileName: CONFIG_FILE ?? 'appraise-github-issues.config.ts',
  // The loader validates the pipeline's own knobs whatever the caller, so they ride along with defaults.
  defaults: { ...PIPELINE_DEFAULTS, ...APPRAISE_DEFAULTS, seats: { ...PIPELINE_DEFAULTS.seats, ...APPRAISE_DEFAULTS.seats } },
  positiveIntegers: ['ageDays', 'appraiseLimit', 'appraiserConcurrency', 'maxReviewRounds'],
  help: [
    'Appraisal is shared across repositories; everything true of a repository lives in that file.',
    'Copy the template from references/adopting.md in this skill (or adopt burn-down-github-issues, whose config this command also reads).',
  ],
});

assertConfirmCloses(CONFIG.confirmCloses, CONFIG_FILE ?? 'appraise-github-issues.config.ts');
const LIMIT = positive('limit', CONFIG.appraiseLimit);
const AGE_DAYS = positive('age-days', CONFIG.ageDays);

const SEATS = (() => {
  try {
    return {
      appraiser: parseSeat(opt('appraiser') ?? CONFIG.seats.appraiser, '--appraiser'),
      confirmer: parseSeat(opt('confirmer') ?? CONFIG.seats.confirmer, '--confirmer'),
    };
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
})();

const ctx = createContext({
  project: CONFIG.project,
  knobs: { autoMerge: 'never', maxReviewRounds: 1 },
  seats: {
    worker: parseSeat(CONFIG.seats.worker, 'seats.worker'),
    reviewer: parseSeat(CONFIG.seats.reviewer, 'seats.reviewer'),
  },
  repoRoot: REPO_ROOT,
  invokeRoot: INVOKE_ROOT,
  promptsDirs: [PROMPTS],
  dryRun: DRY_RUN,
});

teeConsole(join(ctx.runDir, 'appraise.log'));
step(`${ctx.project.name} appraise-github-issues`);
log(`run pid ${process.pid} started ${new Date().toISOString()}`);
log(`base ${ctx.project.baseBranch} | ${ALL_AGES ? 'all ages' : `last ${AGE_DAYS} days`} | ${INCLUDE_SIZED ? 'sized and unsized' : 'unsized only'} | config ${CONFIG_FILE}`);
log(`appraiser ${seatLabel(SEATS.appraiser)} | confirmer ${seatLabel(SEATS.confirmer)} | closes ${NO_CONFIRM || CONFIG.confirmCloses === false ? 'on the appraiser alone' : 'confirmed by the second engine'}`);
if (SEATS.appraiser.engine === SEATS.confirmer.engine) {
  log("WARNING: appraiser and confirmer share an engine, so the close check shares the appraiser's blind spots");
}
if (DRY_RUN) log('DRY RUN: selection only; no lock, no agent, no GitHub mutation; only this log is written');

/** A dry run stops at selection: it prints what a real run would appraise and touches nothing else. */
if (DRY_RUN) {
  const selected = ISSUE_NUMBER
    ? [JSON.parse(sh(ctx, ['gh', 'issue', 'view', String(ISSUE_NUMBER), '--json', 'number,title,createdAt,labels'])) as Issue]
    : selectForAppraisal(allOpenIssues(ctx), { ageDays: AGE_DAYS, skipLabels: CONFIG.skipLabels }, { allAges: ALL_AGES, includeSized: INCLUDE_SIZED }).slice(0, LIMIT);
  const held = selected.filter((issue) => isHeld(issue.labels, CONFIG.skipLabels));
  for (const issue of held) log(`#${issue.number} carries a hold label; a person holds it, so it would not be appraised`);
  const would = selected.filter((issue) => !isHeld(issue.labels, CONFIG.skipLabels));
  log(would.length === 0 ? 'would appraise nothing' : `would appraise ${would.map((i) => `#${i.number}`).join(', ')}`);
  step('done');
  process.exit(0);
}

const releaseLock = (() => {
  try {
    return claimLock(ctx, 'appraise.lock');
  } catch (error) {
    log((error as Error).message);
    process.exit(1);
  }
})();
process.on('exit', releaseLock);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, async () => {
    log(`received ${signal}; stopping agents and releasing the lock`);
    const survivors = await shutdownAgents();
    if (survivors > 0) log(`${survivors} agent(s) survived SIGKILL; check ps before starting another run`);
    releaseLock();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

ensureLabels(ctx);

async function once(): Promise<void> {
  // Appraisers judge "already in the base" against the fetched base ref, not the main checkout's
  // working state, which may be stale, dirty, or on another branch.
  sh(ctx, ['git', 'fetch', ctx.project.remote, ctx.project.baseBranch]);

  let issues: Issue[];
  if (ISSUE_NUMBER) {
    // Bypasses the window and the size filter, never the labels a person set to hold an issue.
    const one: Issue = JSON.parse(sh(ctx, ['gh', 'issue', 'view', String(ISSUE_NUMBER), '--json', 'number,title,createdAt,labels']));
    if (isHeld(one.labels, CONFIG.skipLabels)) {
      log(`#${one.number} carries a hold label; a person holds it, so it is not appraised. Remove the label to put it back in reach.`);
      return;
    }
    issues = [one];
  } else {
    issues = selectForAppraisal(allOpenIssues(ctx), { ageDays: AGE_DAYS, skipLabels: CONFIG.skipLabels }, {
      allAges: ALL_AGES,
      includeSized: INCLUDE_SIZED,
    }).slice(0, LIMIT);
  }
  if (issues.length === 0) {
    log('nothing to appraise; the population is fully sized');
    return;
  }
  step(`Appraising ${issues.length} issue(s), ${CONFIG.appraiserConcurrency} at a time`);
  log(issues.map((i) => `#${i.number}`).join(', '));
  const tally = new Map<string, number>();
  await pool(
    issues,
    CONFIG.appraiserConcurrency,
    async (issue) => {
      const outcome = await appraiseIssue(ctx, issue, {
        ageDays: AGE_DAYS,
        seats: SEATS,
        confirmCloses: !(NO_CONFIRM || CONFIG.confirmCloses === false),
        skipLabels: CONFIG.skipLabels,
      });
      const key = outcome.close ? `${outcome.verdict} (${outcome.close})` : outcome.verdict;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    },
    (issue) => `#${issue.number}`,
  );
  log([...tally.entries()].map(([k, n]) => `${n} ${k}`).join(', '));
}

if (EVERY === null) {
  await once();
  step('done');
} else {
  for (;;) {
    await once();
    log(`sleeping ${EVERY} minute(s)`);
    await Bun.sleep(EVERY * 60 * 1000);
  }
}

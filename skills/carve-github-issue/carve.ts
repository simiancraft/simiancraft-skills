/**
 * carve-github-issue: express one oversized issue as sub-issues, or re-check a carving.
 *
 * The knife. Given an issue sized over the ceiling, a carver names the parts along the highest
 * natural seam, matches each against the backlog so nothing is authored twice, and a second engine
 * confirms the cut covers the parent before anything is created. Given a trunk that was carved
 * already, it asks whether the carving is still good. Everything it decides lands on the tracker:
 * sub-issues, edges, labels, and a carving record on the trunk's thread. This file is the command;
 * the library it drives is in `lib/`, and the burndown calls `carveIssue` directly.
 *
 * This file is shared: it ships with the skill and is not copied into a repository. Everything
 * true of a repository lives in a config file at that repository's root. Run it from inside the
 * target repository:
 *
 *   bun run <skill-dir>/carve.ts --issue <n>                 # carve, or revisit, one issue
 *   bun run <skill-dir>/carve.ts --issue <n> --dry-run       # with fixture seats: log every write, land nothing
 *   bun run <skill-dir>/carve.ts --issue <n> --ceiling 3     # a one-off ceiling
 *   bun run <skill-dir>/carve.ts --issue <n> --carver codex:gpt-5.6-sol --confirmer claude:claude-opus-5
 *
 * Exit codes: 0 for every confirmed verdict, a resumed generation, or an issue left alone; 1 when
 * the knife failed; 3 when another run holds the issue.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCallbacksDir } from '../appraise-github-issues/lib/appraise.ts';
import { shutdownAgents } from '../fix-github-issue/lib/agent.ts';
import { invokeRootFrom, loadProjectConfig, PIPELINE_DEFAULTS, type PipelineKnobs, repoRootFrom } from '../fix-github-issue/lib/config.ts';
import { createContext } from '../fix-github-issue/lib/context.ts';
import { assertDistinctEngines, isFixture, parseSeat, seatLabel } from '../fix-github-issue/lib/engines.ts';
import { ensureLabels } from '../fix-github-issue/lib/labels.ts';
import type { Issue } from '../fix-github-issue/lib/pipeline.ts';
import { log, sh, step, teeConsole } from '../fix-github-issue/lib/shell.ts';
import { ISSUE_LIST_FIELDS } from '../appraise-github-issues/lib/appraise.ts';
import { CARVE_DEFAULTS, type CarveKnobs, JOURNAL_STEPS, type JournalStep } from './lib/carve.ts';
import { carveIssue } from './lib/knife.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPTS = join(HERE, 'prompts');

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
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
const positive = (name: string): number | undefined => {
  const raw = opt(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`--${name} expects a positive integer, got '${raw}'`);
    process.exit(1);
  }
  return parsed;
};

const DRY_RUN = flag('dry-run');
const ISSUE_NUMBER = positive('issue');
if (ISSUE_NUMBER === undefined) {
  console.error('usage: bun run carve.ts --issue <n> [--dry-run] [--ceiling <n>] [--carver <seat>] [--confirmer <seat>]');
  process.exit(2);
}
const FAIL_AFTER = (() => {
  const raw = opt('fail-after');
  if (raw === undefined) return undefined;
  if (process.env.CARVE_DEV !== '1') {
    console.error('--fail-after is a development flag; set CARVE_DEV=1 to use it');
    process.exit(1);
  }
  if (!JOURNAL_STEPS.includes(raw as JournalStep)) {
    console.error(`--fail-after expects one of ${JOURNAL_STEPS.join(', ')}, got '${raw}'`);
    process.exit(1);
  }
  return raw as JournalStep;
})();

const REPO_ROOT = repoRootFrom(process.cwd());
const INVOKE_ROOT = invokeRootFrom(process.cwd(), REPO_ROOT);

/** Its own config when the repository has one, the burndown's otherwise. */
const CONFIG_FILE = ['carve-github-issue.config.ts', 'burn-down-github-issues.config.ts'].find((name) => existsSync(join(INVOKE_ROOT, name)));

type Knobs = PipelineKnobs & { maxPoints: number; callbacksDir: string; carve: typeof CARVE_DEFAULTS };

const CONFIG = await loadProjectConfig<Knobs>({
  invokeRoot: INVOKE_ROOT,
  repoRoot: REPO_ROOT,
  fileName: CONFIG_FILE ?? 'carve-github-issue.config.ts',
  defaults: { ...PIPELINE_DEFAULTS, maxPoints: 2, callbacksDir: '<worktreeRoot>/appraisal-callbacks', carve: CARVE_DEFAULTS },
  positiveIntegers: ['maxPoints', 'maxReviewRounds', 'checksTimeoutMinutes', 'smokeTimeoutMinutes', 'maxWorkerAttempts', 'carve.maxDepth', 'carve.maxChildren', 'carve.maxCarveRounds', 'carve.maxCarveAttempts', 'carve.maxGenerations', 'carve.maxRevisitsPerGeneration'],
  blocks: ['carve'],
  help: [
    'The knife is shared across repositories; everything true of a repository lives in that file.',
    'Copy the template from references/adopting.md in this skill (or adopt burn-down-github-issues, whose config this command also reads).',
  ],
});

const SEATS = (() => {
  try {
    const carverSpec = opt('carver') ?? process.env.LOOP_CARVER ?? CONFIG.seats.carver ?? CONFIG.seats.worker;
    const confirmerSpec = opt('confirmer') ?? process.env.LOOP_CARVE_CONFIRMER ?? CONFIG.seats.carveConfirmer ?? CONFIG.seats.confirmer ?? CONFIG.seats.reviewer;
    const seats = {
      carver: parseSeat(carverSpec, '--carver'),
      confirmer: parseSeat(confirmerSpec, '--confirmer'),
      worker: parseSeat(CONFIG.seats.worker, 'seats.worker'),
      reviewer: parseSeat(CONFIG.seats.reviewer, 'seats.reviewer'),
    };
    assertDistinctEngines(seats.carver, seats.confirmer, 'carver and confirmer');
    return seats;
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
})();

const ctx = createContext({
  project: CONFIG.project,
  knobs: {
    autoMerge: 'never',
    maxReviewRounds: CONFIG.maxReviewRounds,
    checksTimeoutMinutes: CONFIG.checksTimeoutMinutes,
    smokeTimeoutMinutes: CONFIG.smokeTimeoutMinutes,
    pointScale: CONFIG.pointScale,
    maxWorkerAttempts: CONFIG.maxWorkerAttempts,
  },
  seats: { worker: SEATS.worker, reviewer: SEATS.reviewer },
  repoRoot: REPO_ROOT,
  invokeRoot: INVOKE_ROOT,
  promptsDirs: [PROMPTS, join(HERE, '..', 'appraise-github-issues', 'prompts')],
  dryRun: DRY_RUN,
});

const KNOBS: CarveKnobs = {
  ceiling: positive('ceiling') ?? CONFIG.maxPoints,
  ...CONFIG.carve,
  callbacksDir: resolveCallbacksDir(ctx, CONFIG.callbacksDir),
  seats: { carver: SEATS.carver, confirmer: SEATS.confirmer },
  failAfter: FAIL_AFTER,
};

teeConsole(join(ctx.runDir, 'carve.log'));
step(`${ctx.project.name} carve-github-issue`);
log(`run pid ${process.pid} started ${new Date().toISOString()}`);
log(`issue #${ISSUE_NUMBER} | ceiling ${KNOBS.ceiling} | scale ${ctx.knobs.pointScale.join(', ')} | depth up to ${KNOBS.maxDepth} | up to ${KNOBS.maxChildren} children | ${KNOBS.maxCarveRounds} rounds | config ${CONFIG_FILE}`);
log(`carver ${seatLabel(SEATS.carver)} | confirmer ${seatLabel(SEATS.confirmer)} | callbacks ${KNOBS.callbacksDir}`);
if (DRY_RUN) log('DRY RUN: no lock, no claim, no journal file; only fixture seats run; only this log is written');

if (DRY_RUN && !(isFixture(SEATS.carver) && isFixture(SEATS.confirmer))) {
  log('left-alone: dry run needs fixture seats (--carver fixture:<answer.json> --confirmer fixture2:<answer.json>)');
  step('left-alone');
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, async () => {
    log(`received ${signal}; stopping agents`);
    const survivors = await shutdownAgents();
    if (survivors > 0) log(`${survivors} agent(s) survived SIGKILL; check ps before starting another run`);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

if (!DRY_RUN) ensureLabels(ctx);

const issue: Issue = JSON.parse(sh(ctx, ['gh', 'issue', 'view', String(ISSUE_NUMBER), '--json', ISSUE_LIST_FIELDS]));
const result = await carveIssue(ctx, issue, KNOBS);
log(`${result.outcome}: ${result.reason}${result.generation !== undefined ? ` (generation ${result.generation})` : ''}${result.children?.length ? ` children ${result.children.map((n) => `#${n}`).join(', ')}` : ''}`);
step(result.outcome);
process.exit(result.outcome === 'failed' ? 1 : result.outcome === 'busy' ? 3 : 0);

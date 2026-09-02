/**
 * walk-the-floor: a list checker and fixer for a running environment.
 *
 * Wakes once or on a cadence, probes the environment, reads the list on the floor, classifies each
 * item against the deployed revision, walks the rest with one agent turn to the standard "would a
 * user notice", writes the ledger, runs the on-pass and on-fail callbacks, and when the environment
 * is wrong files an incident and hands it to fix-github-issue. Knows nothing about who wrote the
 * list. Run it from inside the target repository:
 *
 *   bun run <skill-dir>/walk.ts --dir <floor> --liveness-only --once
 *   bun run <skill-dir>/walk.ts --dir <floor> --once
 *   bun run <skill-dir>/walk.ts --dir <floor> --every 10
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { children, killAgent, readResult, runAgent } from '../fix-github-issue/lib/agent.ts';
import { invokeRootFrom, repoRootFrom } from '../fix-github-issue/lib/config.ts';
import { createContext } from '../fix-github-issue/lib/context.ts';
import { parseSeat, seatLabel } from '../fix-github-issue/lib/engines.ts';
import { log, sh, step, teeConsole } from '../fix-github-issue/lib/shell.ts';
import { matchesPath } from '../fix-github-issue/lib/staleness.ts';
import { runCallback } from './lib/callbacks.ts';
import { DRIVER_SKILLS, inQuietWindow, loadWalkConfig, type Walk } from './lib/config.ts';
import {
  AGENT_RUNGS,
  AGENT_VERDICTS,
  appendEntry,
  claimFloorLock,
  evidenceDir,
  LIVENESS_ITEM,
  type LedgerEntry,
  type ListItem,
  pending,
  readLedger,
  readList,
  REPAIR,
} from './lib/floor.ts';
import { appendFromForge, newestForgeItem } from './lib/forge.ts';
import { handleIncident } from './lib/incident.ts';
import { describe, probe } from './lib/liveness.ts';
import { renderWalkerPrompt } from './lib/prompts.ts';
import { classify, deployedRevision } from './lib/revision.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX_PROMPTS = join(HERE, '..', 'fix-github-issue', 'prompts');
const VERDICT_FILE = 'walk-verdict.json';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const DIR_ARG = opt('dir');
if (!DIR_ARG) {
  console.error('walk.ts needs --dir <floor>: the directory holding list.jsonl, ledger.jsonl, and the callbacks');
  process.exit(2);
}
const DIR = resolve(DIR_ARG);
// Every wake appends to <floor>/walk.log, which `watch.ts --floor <dir>` follows.
teeConsole(join(DIR, 'walk.log'));
const DRY_RUN = flag('dry-run');
const LIVENESS_ONLY = flag('liveness-only');
const NO_FORGE = flag('no-forge');
const EVERY = opt('every') !== undefined ? Number(opt('every')) : null;
const ONCE = flag('once') || EVERY === null;
if (EVERY !== null && (!Number.isInteger(EVERY) || EVERY <= 0)) {
  console.error(`--every expects minutes as a positive integer, got '${opt('every')}'`);
  process.exit(2);
}
const MAX_POINTS = Number(opt('max-points') ?? 5);
if (!Number.isInteger(MAX_POINTS) || MAX_POINTS <= 0) {
  console.error(`--max-points expects a positive integer, got '${opt('max-points')}'`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Config and context
// ---------------------------------------------------------------------------

const REPO_ROOT = repoRootFrom(process.cwd());
const INVOKE_ROOT = invokeRootFrom(process.cwd(), REPO_ROOT);
const CONFIG = await loadWalkConfig(INVOKE_ROOT, REPO_ROOT);
const PROJECT = CONFIG.project;
/** `--base-url` overrides the configured instance for one run: a preview deploy, or a dead port to prove the down path. */
const ENV = { ...CONFIG.environment, ...(opt('base-url') ? { baseUrl: opt('base-url') } : {}) };

const WALKER = parseSeat(opt('walker') ?? CONFIG.seats.walker, '--walker');
const ctx = createContext({
  project: PROJECT,
  knobs: { autoMerge: CONFIG.autoMerge, maxReviewRounds: CONFIG.maxReviewRounds },
  seats: { worker: parseSeat(CONFIG.seats.worker, 'seats.worker'), reviewer: parseSeat(CONFIG.seats.reviewer, 'seats.reviewer') },
  repoRoot: REPO_ROOT,
  invokeRoot: INVOKE_ROOT,
  promptsDirs: [FIX_PROMPTS],
  dryRun: DRY_RUN,
});

const CHECKOUT = resolve(REPO_ROOT, PROJECT.worktreeRoot, 'floor-checkout');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walksFor(item: ListItem): Walk[] {
  const paths = item.ref?.paths ?? [];
  return CONFIG.walks.filter((walk) => paths.some((file) => walk.paths.some((pattern) => matchesPath(file, pattern))));
}

/** A read-only checkout at the revision the environment runs, so the agent can read the diffs. */
function makeCheckout(revision: string): string {
  if (existsSync(CHECKOUT)) {
    try {
      sh(ctx, ['git', 'worktree', 'remove', '--force', CHECKOUT]);
    } catch {
      // a stale registration; prune below
    }
    sh(ctx, ['git', 'worktree', 'prune']);
  }
  sh(ctx, ['git', 'worktree', 'add', '--detach', CHECKOUT, revision]);
  return CHECKOUT;
}

function removeCheckout(): void {
  if (!existsSync(CHECKOUT)) return;
  try {
    sh(ctx, ['git', 'worktree', 'remove', '--force', CHECKOUT]);
  } catch (error) {
    log(`could not remove ${CHECKOUT}: ${(error as Error).message}`);
  }
}

function notify(entry: LedgerEntry): void {
  if (!CONFIG.notifyCommand) return;
  const proc = Bun.spawnSync(['sh', '-c', CONFIG.notifyCommand], {
    cwd: DIR,
    stdin: Buffer.from(`${JSON.stringify(entry)}\n`),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  });
  log(`notify command exited ${proc.exitCode}`);
}

let lastNotified = 0;
async function onFail(entry: LedgerEntry): Promise<void> {
  await runCallback(DIR, 'on-fail', entry, log);
  // While the environment stays down across wakes, one notification an hour is enough.
  if (Date.now() - lastNotified > 60 * 60 * 1000) {
    notify(entry);
    lastNotified = Date.now();
  }
}

function loginText(): string {
  if (!ENV.login) return 'no login is configured; walk what is reachable without one';
  const l = ENV.login;
  const restricted = l.restrictedUserEnv
    ? ` A restricted account is in \`$${l.restrictedUserEnv}\` / \`$${l.restrictedPasswordEnv}\`, for checks that something is refused.`
    : '';
  return `sign in at ${l.url} with the user in \`$${l.userEnv}\` and the password in \`$${l.passwordEnv}\` (environment variables; never write their values anywhere).${restricted}`;
}

function renderItems(items: ListItem[]): string {
  return items
    .map((item) => {
      const ref = item.ref;
      const refText = ref?.pullRequest
        ? `pull request #${ref.pullRequest}, merge ${ref.sha?.slice(0, 12) ?? '?'}, merged ${ref.mergedAt ?? '?'}; paths: ${(ref.paths ?? []).slice(0, 15).join(', ') || 'none listed'}`
        : 'no reference; treat the text as the instruction';
      const walks = walksFor(item)
        .map((w) => w.name)
        .join(', ');
      return `- **\`${item.id}\`**: ${item.text}\n  ${refText}${walks ? `\n  standing walks: ${walks}` : ''}`;
    })
    .join('\n');
}

function renderWalks(): string {
  if (CONFIG.walks.length === 0) return '(none configured)';
  return CONFIG.walks.map((w) => `- **${w.name}** (paths: ${w.paths.join(', ')}): ${w.steps}`).join('\n');
}

function callbackPrompts(): string {
  const parts: string[] = [];
  for (const name of ['on-pass', 'on-fail'] as const) {
    const path = join(DIR, `${name}.md`);
    if (existsSync(path)) parts.push(`## Also, for every item that ${name === 'on-pass' ? 'passes' : 'fails'}\n\n${readFileSync(path, 'utf8')}`);
  }
  return parts.join('\n\n');
}

type AgentVerdictFile = { entries: Array<{ itemId: string; rung: string; verdict: string; reason: string; evidence?: string }> };

// ---------------------------------------------------------------------------
// One wake
// ---------------------------------------------------------------------------

async function wake(): Promise<boolean> {
  const now = new Date().toISOString();
  let wrong = false;

  // The environment can move on its own, so read the deployed revision fresh every wake.
  if (!DRY_RUN) {
    try {
      sh(ctx, ['git', 'fetch', PROJECT.remote, PROJECT.baseBranch]);
    } catch (error) {
      log(`fetch failed: ${(error as Error).message}`);
    }
  }
  const deployed = deployedRevision(ENV.revisionCommand, INVOKE_ROOT);
  log(`deployed revision: ${deployed ?? 'unknown (no revisionCommand or it printed no SHA)'}`);

  // 1. Liveness, in-process. A wake that finds the environment down walks nothing else.
  if (ENV.baseUrl) {
    const result = await probe(ENV.baseUrl, ENV.healthPaths);
    const entry: LedgerEntry = {
      itemId: LIVENESS_ITEM,
      checkedAt: now,
      deployedRevision: deployed ?? undefined,
      rung: 'liveness',
      verdict: result.up ? 'intact' : 'down',
      reason: describe(result),
    };
    appendEntry(DIR, entry);
    log(`liveness: ${entry.verdict}; ${entry.reason}`);
    if (!result.up) {
      if (inQuietWindow(ENV.quietWindows)) {
        log('inside a quiet window; recorded, no callback, no incident');
        return false;
      }
      wrong = true;
      await onFail(entry);
      if (!LIVENESS_ONLY) await repair(entry, deployed);
      return wrong;
    }
    if (!inQuietWindow(ENV.quietWindows)) await runCallback(DIR, 'on-pass', entry, log);
  } else {
    log('no environment.baseUrl; skipping liveness');
  }
  if (LIVENESS_ONLY) return wrong;

  // 2. Produce items from the forge for merges nobody else put on the floor.
  if (!NO_FORGE) {
    const list = readList(DIR);
    // Since the newest merge already on the floor; on a fresh floor, since the first time the
    // walker looked, so nothing merged after the floor opened is missed.
    const ledger = readLedger(DIR);
    const since =
      newestForgeItem(list) ?? ledger[0]?.checkedAt ?? new Date(Date.now() - CONFIG.cadenceMinutes * 60_000).toISOString();
    try {
      const added = appendFromForge(DIR, PROJECT.repo, PROJECT.baseBranch, since, REPO_ROOT);
      if (added > 0) log(`forge: ${added} merged pull request(s) since ${since} put on the floor`);
    } catch (error) {
      log(`forge producer failed: ${(error as Error).message}`);
    }
  }

  // 3. Classify. Pending verdicts need no agent and are walked again next wake.
  const items = pending(readList(DIR), readLedger(DIR));
  const walkable: ListItem[] = [];
  for (const item of items) {
    const state = classify({
      deployed,
      sha: item.ref?.sha,
      mergedAt: item.ref?.mergedAt,
      graceMinutes: ENV.graceMinutes,
      repoRoot: REPO_ROOT,
    });
    if (state) {
      appendEntry(DIR, {
        itemId: item.id,
        checkedAt: now,
        deployedRevision: deployed ?? undefined,
        rung: 'classify',
        verdict: state,
        reason: state === 'not-yet-deployed' ? `merge ${item.ref?.sha?.slice(0, 12)} is not an ancestor of the deployed revision` : `no revision signal and inside the ${ENV.graceMinutes}-minute grace window`,
      });
      log(`${item.id}: ${state}`);
    } else {
      walkable.push(item);
    }
  }
  if (walkable.length === 0) {
    log(items.length === 0 ? 'nothing on the floor to walk' : 'every item is pending; nothing to walk yet');
    return wrong;
  }
  if (inQuietWindow(ENV.quietWindows)) {
    log('inside a quiet window; the walk waits for the next wake');
    return wrong;
  }
  if (!ENV.baseUrl) {
    log(`${walkable.length} item(s) are walkable but there is no environment.baseUrl to walk`);
    return wrong;
  }

  // 4. Walk, one agent turn for every walkable item.
  step(`Walking ${walkable.length} item(s) with ${seatLabel(WALKER)}`);
  const checkout = makeCheckout(deployed ?? `${PROJECT.remote}/${PROJECT.baseBranch}`);
  const repairs: LedgerEntry[] = [];
  try {
    const prompt = renderWalkerPrompt(ctx, 'walk.md', {
      KIND: ENV.kind,
      DRIVER_SKILL: DRIVER_SKILLS[ENV.kind],
      BASE_URL: ENV.baseUrl,
      DEPLOYED_REVISION: deployed ?? 'unknown',
      LOGIN: loginText(),
      SAFE_ENDPOINTS: ENV.safeEndpoints.length > 0 ? ENV.safeEndpoints.map((p) => `\`${p}\``).join(', ') : 'none',
      CHECKOUT: checkout,
      EVIDENCE_DIR: evidenceDir(DIR),
      WALKS: renderWalks(),
      ITEMS: renderItems(walkable),
      VERDICT_FILE: join(checkout, VERDICT_FILE),
      CALLBACK_PROMPT: callbackPrompts(),
    });
    const run = await runAgent(ctx, 'walker', 0, checkout, WALKER, prompt);
    const file = run.exitCode === 0 ? readResult<AgentVerdictFile>(checkout, VERDICT_FILE) : null;
    if (!file || !Array.isArray(file.entries)) {
      log(run.exitCode === 0 ? 'the walker wrote no verdict file; every item is walked again next wake' : `the walker exited ${run.exitCode}; nothing recorded`);
    } else {
      const wanted = new Set(walkable.map((i) => i.id));
      for (const raw of file.entries) {
        if (!wanted.has(raw.itemId)) {
          log(`ignoring a verdict for ${raw.itemId}, which was not on this walk`);
          continue;
        }
        if (!AGENT_RUNGS.has(raw.rung as never) || !AGENT_VERDICTS.has(raw.verdict as never) || typeof raw.reason !== 'string') {
          log(`ignoring a malformed verdict for ${raw.itemId}: rung '${raw.rung}', verdict '${raw.verdict}'`);
          continue;
        }
        const entry: LedgerEntry = {
          itemId: raw.itemId,
          checkedAt: new Date().toISOString(),
          deployedRevision: deployed ?? undefined,
          rung: raw.rung as LedgerEntry['rung'],
          verdict: raw.verdict as LedgerEntry['verdict'],
          reason: raw.reason,
          evidence: raw.evidence,
        };
        appendEntry(DIR, entry);
        log(`${entry.itemId}: ${entry.verdict} by ${entry.rung}; ${entry.reason}`);
        wanted.delete(raw.itemId);
        if (REPAIR.has(entry.verdict)) {
          wrong = true;
          await onFail(entry);
          repairs.push(entry);
        } else {
          await runCallback(DIR, 'on-pass', entry, log);
        }
      }
      for (const missing of wanted) log(`${missing}: no verdict this wake; walked again next wake`);
    }

    // 5. Repair, one incident per wrong item, through the fix pipeline.
    for (const entry of repairs) await repair(entry, deployed, checkout);
  } finally {
    removeCheckout();
  }
  return wrong;
}

async function repair(entry: LedgerEntry, deployed: string | null, checkout?: string): Promise<void> {
  const cwd = checkout ?? makeCheckout(deployed ?? `${PROJECT.remote}/${PROJECT.baseBranch}`);
  try {
    const result = await handleIncident(ctx, {
      dir: DIR,
      entry,
      checkout: cwd,
      walker: WALKER,
      logsCommand: ENV.logsCommand,
      maxPoints: MAX_POINTS,
    });
    if (entry.itemId === LIVENESS_ITEM && ENV.baseUrl && result.fix?.outcome === 'merged') {
      // The fix landed; say whether the environment came back, once it has had a moment.
      await Bun.sleep(60_000);
      const again = await probe(ENV.baseUrl, ENV.healthPaths);
      appendEntry(DIR, {
        itemId: LIVENESS_ITEM,
        checkedAt: new Date().toISOString(),
        deployedRevision: deployedRevision(ENV.revisionCommand, INVOKE_ROOT) ?? undefined,
        rung: 'liveness',
        verdict: again.up ? 'intact' : 'down',
        reason: `after incident #${result.issue}: ${describe(again)}`,
        incident: result.issue,
      });
      log(`after incident #${result.issue}: ${again.up ? 'up' : 'still down'}`);
    }
  } finally {
    if (!checkout) removeCheckout();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  step(`${PROJECT.name} walk-the-floor`);
  log(`floor ${DIR} | ${ENV.kind} at ${ENV.baseUrl ?? 'no base URL'} | walker ${seatLabel(WALKER)} | ${ONCE ? 'once' : `every ${EVERY} minutes`}`);
  if (DRY_RUN) log('DRY RUN: no agent will run and nothing is filed');

  let release: () => void;
  try {
    release = claimFloorLock(DIR);
  } catch (error) {
    log((error as Error).message);
    process.exitCode = 1;
    return;
  }
  process.on('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      log(`received ${signal}; stopping agents and releasing the lock`);
      for (const child of children) killAgent(child);
      removeCheckout();
      release();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }

  if (ONCE) {
    const wrong = await wake();
    step('done');
    process.exitCode = wrong ? 1 : 0;
    return;
  }
  for (;;) {
    try {
      await wake();
    } catch (error) {
      log(`wake threw: ${(error as Error).message}`);
    }
    log(`sleeping ${EVERY} minute(s)`);
    await Bun.sleep((EVERY as number) * 60_000);
  }
}

await main();

/**
 * The floor, as the loop runs it: every merge goes up onto a list, and on a cadence the loop walks
 * the deployed base to the standard "would a user notice", writes what it found to the ledger,
 * prints an emoji readout, and runs the producer's callbacks. A walk that finds the environment
 * wrong pauses the line, files an incident, and hands it to the fix pipeline; the line is released
 * when nothing on the floor is wrong any more. When the run's own work is done the floor drains:
 * it keeps walking until its merges are verified, or the drain window closes.
 *
 * The parts, each replaceable on its own:
 *   cadence       `floor.every`, minutes or a function of the floor state
 *   merge-up      `put`, called from the pipeline's afterMerge hook
 *   readout       `renderReadout` from the emoji-readout skill, printed after a walk with news
 *   on-walk       a callback slot run after a walk with news (executable and/or prompt)
 *   on-walk-fail  a callback slot run when an item turns wrong, before the incident
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readResult, renderPrompt, runAgent } from '../../../fix-github-issue/lib/agent.ts';
import { runCallback, runCallbackPrompt } from '../../../fix-github-issue/lib/callbacks.ts';
import type { Context } from '../../../fix-github-issue/lib/context.ts';
import type { Seat } from '../../../fix-github-issue/lib/engines.ts';
import { isStopping, RunStopping, sh, stoppableSleep } from '../../../fix-github-issue/lib/shell.ts';
import { matchesPath } from '../../../fix-github-issue/lib/staleness.ts';
import { type Line, renderReadout } from '../../../emoji-readout/lib/readout.ts';
import { DRIVER_SKILLS, type FloorConfig, type FloorState, inQuietWindow, nextWalkMinutes, type Walk } from './config.ts';
import { handleIncident, mergedSince, openIncidentFor } from './incident.ts';
import {
  AGENT_RUNGS,
  AGENT_VERDICTS,
  appendEntry,
  appendItem,
  evidenceDir,
  latestByItem,
  LIVENESS_ITEM,
  type LedgerEntry,
  type ListItem,
  pending,
  readLedger,
  readList,
  REPAIR,
  TERMINAL,
} from './ledger.ts';
import { classify, deployedRevision, describe, probe } from './probe.ts';

const VERDICT_FILE = 'walk-verdict.json';

/** A merge, as the pipeline's afterMerge hook reports it. */
export type MergeEvent = { issue: number; title: string; pr: number; sha: string; mergedAt: string; paths: string[]; unseenBase?: string };

export type WalkResult = {
  at: string;
  entries: LedgerEntry[];
  wrong: boolean;
  pending: number;
  incidents: Array<{ itemId: string; issue: number; outcome: string }>;
  readout: string;
};

export type FloorOptions = {
  /** The context incidents are fixed under. Its merge must not wait on the line the floor paused. */
  ctx: Context;
  config: FloorConfig;
  dir: string;
  switchFile: string;
  callbacksDir: string;
  seats: { walker: Seat; callback: Seat };
  maxPoints: number;
  log: (message: string) => void;
  /**
   * Told when a walk settles an item that names an issue (from the walk itself, no incident), or
   * finds one wrong (after its incident, with that incident's number), so the card can move.
   */
  onWalked?: (item: ListItem, entry: LedgerEntry, incident?: number) => void;
  /**
   * `--base-url` for one run: a preview deploy, or a dead port to prove the down path. Another URL
   * is not the environment the ledger and the line describe, so such a walk is a rehearsal.
   */
  baseUrl?: string;
  /** Where a walk's readout goes; the log, one line at a time, by default. */
  print?: (readout: string) => void;
};

type AgentVerdictFile = { entries: Array<{ itemId: string; rung: string; verdict: string; reason: string; evidence?: string }> };

/** The reason the floor writes when it pauses the line; a pause without this prefix is a person's. */
export const FLOOR_PAUSE = 'floor:';

export class Floor {
  private readonly o: FloorOptions;
  private readonly env: FloorConfig['environment'];
  private readonly checkout: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: Promise<WalkResult | null> | null = null;
  private stopped = false;
  private draining = false;
  private lastWrong = false;
  /** Items whose incident a person now owns: walked every time, but a drain does not wait on them. */
  private readonly withAPerson = new Set<string>();
  private readonly openedAt = new Date().toISOString();
  /** Open incidents by item, for the readout. */
  private readonly incidentOf = new Map<string, number>();
  /** Items whose incident's fix merged, by that incident: the fix has to deploy before another try. */
  private readonly fixedBy = new Map<string, number>();
  /** Ids this run put on the floor; the drain waits on these, not on everything ever listed. */
  private readonly mine = new Set<string>();
  /** Probe, classify, and report only: no ledger, line, callback, checkout, agent, or incident. */
  private readonly rehearsal: boolean;

  constructor(options: FloorOptions) {
    this.o = options;
    this.env = { ...options.config.environment, ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}) };
    this.rehearsal = options.ctx.dryRun || options.baseUrl !== undefined;
    this.checkout = resolve(options.ctx.repoRoot, options.ctx.project.worktreeRoot, 'floor-checkout');
  }

  /** Merge-up: one list item per merge, so the next walk checks what landed. */
  put(event: MergeEvent): void {
    this.mine.add(`pull-request:${event.pr}`);
    appendItem(this.o.dir, {
      id: `pull-request:${event.pr}`,
      addedAt: new Date().toISOString(),
      source: 'burndown',
      // A merge that landed across a commit nobody checked it against is the first suspect.
      text: event.unseenBase ? `${event.title} (landed on unseen base ${event.unseenBase.slice(0, 10)})` : event.title,
      ref: { issue: event.issue, pullRequest: event.pr, sha: event.sha, mergedAt: event.mergedAt, paths: event.paths, unseenBase: event.unseenBase },
    });
  }

  /** Walks now, then on the cadence until `drain` or `stop`. */
  start(): void {
    this.o.log(`floor: walking ${this.env.baseUrl} now, then on its cadence`);
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Items still owed a terminal verdict, less those a person owns: this run's, or every one. */
  owed(scope: 'run' | 'all' = 'all'): ListItem[] {
    return pending(readList(this.o.dir), readLedger(this.o.dir)).filter((item) => !this.withAPerson.has(item.id) && (scope === 'all' || this.mine.has(item.id)));
  }

  /**
   * Walk until every item in scope has a terminal verdict or is with a person: at the end of a run,
   * the merges this run made (`run`); from `--floor drain`, everything on the floor (`all`).
   * Bounded by `drainMinutes`: no walk starts after the window closes, but one under way (an
   * incident fix among its steps) finishes first, so the lock can outlive the window by one walk.
   */
  async drain(scope: 'run' | 'all'): Promise<void> {
    const deadline = Date.now() + this.o.config.drainMinutes * 60_000;
    this.draining = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.current;
    for (;;) {
      if (this.halted() || this.owed(scope).length === 0) break;
      if (Date.now() >= deadline) {
        this.o.log(`floor: ${this.owed(scope).length} item(s) still pending after ${this.o.config.drainMinutes} minute(s); stopping. Finish them with loop.ts --floor drain`);
        return;
      }
      await this.walkOnce();
      if (this.halted() || this.owed(scope).length === 0) break;
      const wait = Math.min(deadline - Date.now(), this.nextMinutes() * 60_000);
      this.o.log(`floor: draining; ${this.owed(scope).length} item(s) pending, next walk in ${Math.max(1, Math.ceil(wait / 60_000))} minute(s)`);
      try {
        if (wait > 0) await stoppableSleep(wait);
      } catch {
        return;
      }
    }
    if (this.owed(scope).length > 0) return;
    if (this.withAPerson.size > 0) this.o.log(`floor: clear but for ${[...this.withAPerson].join(', ')}, which a person owns`);
    else this.o.log('floor: clear; every merge is verified');
  }

  /** One walk, unless one is already running, in which case its result. */
  walkOnce(options: { livenessOnly?: boolean } = {}): Promise<WalkResult | null> {
    if (!this.current) {
      this.current = this.walk(options)
        .catch((error) => {
          if (!(error instanceof RunStopping)) this.o.log(`floor: walk threw: ${(error as Error).message}`);
          return null;
        })
        .finally(() => {
          this.current = null;
        });
    }
    return this.current;
  }

  /** The floor was stopped, or the whole run is stopping: nothing new is written or started. */
  private halted(): boolean {
    return this.stopped || isStopping();
  }

  private checkpoint(): void {
    if (this.halted()) throw new RunStopping('the floor is stopping');
  }

  private nextMinutes(): number {
    const state: FloorState = { pending: this.owed().length, wrong: this.lastWrong, paused: this.paused(), draining: this.draining };
    return nextWalkMinutes(this.o.config.every, state);
  }

  private async tick(): Promise<void> {
    if (this.halted() || this.draining) return;
    await this.walkOnce();
    if (this.halted() || this.draining) return;
    const minutes = this.nextMinutes();
    this.timer = setTimeout(() => void this.tick(), minutes * 60_000);
    this.timer.unref?.();
  }

  // -------------------------------------------------------------------------
  // The line
  // -------------------------------------------------------------------------

  private switchLines(): string[] {
    return existsSync(this.o.switchFile) ? readFileSync(this.o.switchFile, 'utf8').split('\n') : [];
  }

  private paused(): boolean {
    const first = this.switchLines()[0]?.trim();
    return first !== undefined && first !== '' && first !== 'go';
  }

  private ownPause(): boolean {
    return this.paused() && (this.switchLines()[1]?.startsWith(FLOOR_PAUSE) ?? false);
  }

  /** Items whose newest entry says the environment is wrong, liveness included; quiet-window ones aside. */
  private wrongNow(): LedgerEntry[] {
    return [...latestByItem(readLedger(this.o.dir)).values()].filter((entry) => REPAIR.has(entry.verdict) && !entry.quiet);
  }

  /** Pauses for the floor, unless a person already paused the line: their reason stands. */
  private pauseLine(): void {
    if (this.rehearsal) return;
    const lines = this.switchLines();
    if (this.paused() && !lines[1]?.startsWith(FLOOR_PAUSE)) return;
    const reason = this.wrongNow().map((e) => `${e.itemId} is ${e.verdict}`).join('; ');
    writeFileSync(this.o.switchFile, `pause\n${FLOOR_PAUSE} ${reason}; see the ledger on the floor\n`);
    this.o.log(`floor: line paused (${reason})`);
  }

  /** Releases a pause the floor wrote once nothing is wrong; never one a person wrote. */
  private releaseLine(): void {
    if (this.rehearsal || !this.ownPause()) return;
    if (this.wrongNow().length > 0) return;
    writeFileSync(this.o.switchFile, 'go\n');
    this.o.log('floor: nothing on the floor is wrong; line released');
  }

  // -------------------------------------------------------------------------
  // One walk
  // -------------------------------------------------------------------------

  private record(entry: LedgerEntry, entries: LedgerEntry[]): void {
    entries.push(entry);
    if (this.rehearsal) {
      this.o.log(`floor: rehearsal  would record ${entry.itemId}: ${entry.verdict} by ${entry.rung}`);
      return;
    }
    appendEntry(this.o.dir, entry);
  }

  private async walk(options: { livenessOnly?: boolean }): Promise<WalkResult> {
    const { ctx, log } = this.o;
    const at = new Date().toISOString();
    const entries: LedgerEntry[] = [];
    const before = latestByItem(readLedger(this.o.dir));
    const items = new Map(readList(this.o.dir).map((item) => [item.id, item]));
    const quiet = inQuietWindow(this.env.quietWindows);
    const notes: string[] = [];

    // The environment can move on its own, so read the deployed revision fresh every walk.
    if (!this.rehearsal) {
      try {
        sh(ctx, ['git', 'fetch', ctx.project.remote, ctx.project.baseBranch]);
      } catch (error) {
        log(`floor: fetch failed: ${(error as Error).message}`);
      }
    }
    const deployed = deployedRevision(this.env.revisionCommand, ctx.invokeRoot);

    // 1. Liveness, in-process. A walk that finds the environment down walks nothing else.
    const result = await probe(this.env.baseUrl, this.env.healthPaths, this.env.probeTimeoutMs);
    this.checkpoint();
    const live: LedgerEntry = {
      itemId: LIVENESS_ITEM,
      checkedAt: at,
      deployedRevision: deployed ?? undefined,
      rung: 'liveness',
      verdict: result.up ? 'intact' : 'down',
      reason: describe(result),
      // Expected only when it began inside the window: an outage already paused stays a handled one.
      ...(quiet && !result.up && !(before.get(LIVENESS_ITEM)?.verdict === 'down' && !before.get(LIVENESS_ITEM)?.quiet) ? { quiet: true as const } : {}),
    };
    this.record(live, entries);
    const health = `${result.up ? 'up' : 'down'}: ${live.reason}; deployed ${deployed?.slice(0, 10) ?? 'revision unknown'}${quiet ? '; inside a quiet window' : ''}`;
    log(`floor: liveness ${live.verdict}; ${live.reason}`);

    let walkable: ListItem[] = [];
    if (result.up && !options.livenessOnly) {
      if (this.o.config.forge && !this.rehearsal) this.fromForge(items);
      // 2. Classify. Pending verdicts need no agent; one is recorded only when it changes.
      for (const item of pending([...items.values()], readLedger(this.o.dir))) {
        const state = classify({ deployed, sha: item.ref?.sha, mergedAt: item.ref?.mergedAt, graceMinutes: this.env.graceMinutes, repoRoot: ctx.repoRoot });
        if (!state) {
          walkable.push(item);
          continue;
        }
        if (before.get(item.id)?.verdict === state) continue;
        this.record(
          {
            itemId: item.id,
            checkedAt: at,
            deployedRevision: deployed ?? undefined,
            rung: 'classify',
            verdict: state,
            reason: state === 'not-yet-deployed' ? `merge ${item.ref?.sha?.slice(0, 12)} is not an ancestor of the deployed revision` : `no revision signal and inside the ${this.env.graceMinutes}-minute grace window`,
          },
          entries,
        );
      }
      if (walkable.length > 0 && quiet) {
        notes.push(`${walkable.length} item(s) wait out the quiet window`);
        walkable = [];
      }
      if (walkable.length > 0 && this.rehearsal) {
        notes.push(`rehearsal: would walk ${walkable.map((item) => item.id).join(', ')}`);
        walkable = [];
      }
    }

    // 3. Walk, one agent turn for every walkable item.
    if (walkable.length > 0) await this.walkItems(walkable, deployed, entries, notes);
    this.checkpoint();

    // 4. What turned wrong pauses the line and runs on-walk-fail; then each wrong item is repaired.
    // "Turned" counts from the last handled failure, so an outage that began in a quiet window
    // still pauses the line on the first walk after it.
    const incidents: WalkResult['incidents'] = [];
    const wrong = entries.filter((entry) => REPAIR.has(entry.verdict));
    if (wrong.length > 0 && !quiet) {
      const turned = wrong.filter((entry) => {
        const prior = before.get(entry.itemId);
        return prior?.verdict !== entry.verdict || prior.quiet === true;
      });
      if (turned.length > 0) {
        this.pauseLine();
        for (const entry of turned) await this.onWalkFail(entry, items.get(entry.itemId));
      }
      if (!options.livenessOnly && !this.rehearsal) {
        for (const entry of wrong) {
          this.checkpoint();
          // An item still wrong with its incident open is that incident's business: the pipeline
          // or a person has it. Only a new failure, or one whose incident closed, is worked again.
          if (!turned.includes(entry) && this.incidentOpen(entry.itemId)) continue;
          // A fix that merged but has not deployed yet is not a failed fix: wait for its walk.
          const fix = this.fixedBy.get(entry.itemId);
          if (fix !== undefined && pending([...items.values()], readLedger(this.o.dir)).some((item) => item.ref?.issue === fix)) {
            notes.push(`${entry.itemId}: waiting for incident #${fix}'s fix to deploy`);
            continue;
          }
          const incident = await this.repair(entry, deployed, items.get(entry.itemId)?.ref?.mergedAt);
          if (incident?.outcome === 'merged') this.fixedBy.set(entry.itemId, incident.issue);
          if (incident) incidents.push({ itemId: entry.itemId, ...incident });
          const item = items.get(entry.itemId);
          if (item) this.o.onWalked?.(item, entry, incident?.issue);
        }
      }
    } else if (wrong.length > 0) {
      notes.push('down inside a quiet window: recorded, nothing paused or filed');
    }
    // A quiet walk releases nothing either: an outage carried into the window is still one.
    if (!quiet) this.releaseLine();
    // Wrong is what the ledger says now, not only what this walk wrote: an earlier absent that no
    // walk has cleared is still wrong. A rehearsal writes no ledger, so it answers for itself.
    this.lastWrong = this.rehearsal ? wrong.length > 0 : this.wrongNow().length > 0;

    const stillPending = pending([...items.values()], readLedger(this.o.dir)).length;
    const readout = this.readout(entries, items, incidents, health, notes, stillPending);
    const news = entries.some((e) => e.itemId !== LIVENESS_ITEM) || before.get(LIVENESS_ITEM)?.verdict !== live.verdict || notes.length > 0;
    const walked: WalkResult = { at, entries, wrong: this.lastWrong, pending: stillPending, incidents, readout };
    if (news) {
      if (this.o.print) this.o.print(readout);
      else for (const line of readout.split('\n')) log(line);
      this.checkpoint();
      if (!quiet) await this.onWalk(walked);
    }
    return walked;
  }

  /**
   * Merges nobody put on the floor (a person's, another tool's). The cursor is the newest merge the
   * forge itself listed, never one the loop put: a person's merge just before the loop's would
   * otherwise fall behind it and never be read.
   */
  private fromForge(items: Map<string, ListItem>): void {
    const newest = [...items.values()].filter((item) => item.source === 'forge').map((item) => item.ref?.mergedAt).filter((at): at is string => !!at).sort().at(-1);
    try {
      for (const pr of mergedSince(this.o.ctx, newest ?? this.openedAt).reverse()) {
        const id = `pull-request:${pr.number}`;
        if (items.has(id) || !pr.mergeCommit) continue;
        const item: ListItem = { id, addedAt: new Date().toISOString(), source: 'forge', text: pr.title, ref: { pullRequest: pr.number, sha: pr.mergeCommit, mergedAt: pr.mergedAt, paths: pr.paths } };
        appendItem(this.o.dir, item);
        items.set(id, item);
      }
    } catch (error) {
      this.o.log(`floor: could not read merges from the forge: ${(error as Error).message}`);
    }
  }

  private walksFor(item: ListItem): Walk[] {
    const paths = item.ref?.paths ?? [];
    return this.o.config.walks.filter((walk) => paths.some((file) => walk.paths.some((pattern) => matchesPath(file, pattern))));
  }

  private makeCheckout(revision: string): void {
    this.removeCheckout();
    sh(this.o.ctx, ['git', 'worktree', 'prune']);
    sh(this.o.ctx, ['git', 'worktree', 'add', '--detach', this.checkout, revision]);
  }

  private removeCheckout(): void {
    if (!existsSync(this.checkout)) return;
    try {
      sh(this.o.ctx, ['git', 'worktree', 'remove', '--force', this.checkout]);
    } catch (error) {
      this.o.log(`floor: could not remove ${this.checkout}: ${(error as Error).message}`);
    }
  }

  private async walkItems(walkable: ListItem[], deployed: string | null, entries: LedgerEntry[], notes: string[]): Promise<void> {
    const { ctx, log } = this.o;
    const env = this.env;
    this.makeCheckout(deployed ?? `${ctx.project.remote}/${ctx.project.baseBranch}`);
    try {
      const login = env.login
        ? `sign in at ${env.login.url} with the user in \`$${env.login.userEnv}\` and the password in \`$${env.login.passwordEnv}\` (environment variables; never write their values anywhere).${
            env.login.restrictedUserEnv ? ` A restricted account is in \`$${env.login.restrictedUserEnv}\` / \`$${env.login.restrictedPasswordEnv}\`, for checks that something is refused.` : ''
          }`
        : 'no login is configured; walk what is reachable without one';
      const prompt = renderPrompt(ctx, 'walk.md', {
        KIND: env.kind,
        DRIVER_SKILL: env.driverSkill ?? DRIVER_SKILLS[env.kind],
        BASE_URL: env.baseUrl,
        DEPLOYED_REVISION: deployed ?? 'unknown',
        LOGIN: login,
        SAFE_ENDPOINTS: env.safeEndpoints.length > 0 ? env.safeEndpoints.map((p) => `\`${p}\``).join(', ') : 'none',
        CHECKOUT: this.checkout,
        EVIDENCE_DIR: evidenceDir(this.o.dir),
        WALKS: this.o.config.walks.length === 0 ? '(none configured)' : this.o.config.walks.map((w) => `- **${w.name}** (paths: ${w.paths.join(', ')}): ${w.steps}`).join('\n'),
        ITEMS: walkable
          .map((item) => {
            const ref = item.ref;
            const refText = ref?.pullRequest
              ? `pull request #${ref.pullRequest}, merge ${ref.sha?.slice(0, 12) ?? '?'}, merged ${ref.mergedAt ?? '?'}; paths: ${(ref.paths ?? []).slice(0, 15).join(', ') || 'none listed'}`
              : 'no reference; treat the text as the instruction';
            const walks = this.walksFor(item).map((w) => w.name).join(', ');
            return `- **\`${item.id}\`**: ${item.text}\n  ${refText}${walks ? `\n  standing walks: ${walks}` : ''}`;
          })
          .join('\n'),
        VERDICT_FILE: join(this.checkout, VERDICT_FILE),
      });
      log(`floor: walking ${walkable.length} item(s)`);
      const run = await runAgent(ctx, 'walker', 0, this.checkout, this.o.seats.walker, prompt);
      const file = run.exitCode === 0 ? readResult<AgentVerdictFile>(this.checkout, VERDICT_FILE) : null;
      if (!file || !Array.isArray(file.entries)) {
        notes.push(run.exitCode === 0 ? 'the walker wrote no verdicts; every item is walked again next time' : `the walker exited ${run.exitCode}; nothing recorded`);
        return;
      }
      const wanted = new Map(walkable.map((item) => [item.id, item]));
      for (const raw of file.entries) {
        const item = wanted.get(raw.itemId);
        if (!item) continue;
        if (!AGENT_RUNGS.has(raw.rung as never) || !AGENT_VERDICTS.has(raw.verdict as never) || typeof raw.reason !== 'string') {
          log(`floor: ignoring a malformed verdict for ${raw.itemId}: rung '${raw.rung}', verdict '${raw.verdict}'`);
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
        this.record(entry, entries);
        wanted.delete(raw.itemId);
        if (TERMINAL.has(entry.verdict)) this.o.onWalked?.(item, entry);
      }
      if (wanted.size > 0) notes.push(`no verdict for ${[...wanted.keys()].join(', ')}; walked again next time`);
    } finally {
      this.removeCheckout();
    }
  }

  private incidentOpen(itemId: string): boolean {
    try {
      const open = openIncidentFor(this.o.ctx, itemId);
      if (open?.withAPerson) this.withAPerson.add(itemId);
      if (open) this.incidentOf.set(itemId, open.number);
      return open !== null;
    } catch {
      return false;
    }
  }

  private async repair(entry: LedgerEntry, deployed: string | null, mergedAt?: string): Promise<{ issue: number; outcome: string } | null> {
    const { ctx } = this.o;
    this.makeCheckout(deployed ?? `${ctx.project.remote}/${ctx.project.baseBranch}`);
    try {
      const result = await handleIncident(ctx, {
        dir: this.o.dir,
        entry,
        checkout: this.checkout,
        walker: this.o.seats.walker,
        logsCommand: this.env.logsCommand,
        maxPoints: this.o.maxPoints,
        mergedAt,
      });
      if (result.withAPerson) this.withAPerson.add(entry.itemId);
      else this.withAPerson.delete(entry.itemId);
      this.incidentOf.set(entry.itemId, result.issue);
      return { issue: result.issue, outcome: result.fix?.outcome ?? (result.withAPerson ? 'with a person' : 'filed') };
    } catch (error) {
      if (error instanceof RunStopping) throw error;
      this.o.log(`floor: incident for ${entry.itemId} failed: ${(error as Error).message}`);
      return null;
    } finally {
      this.removeCheckout();
    }
  }

  // -------------------------------------------------------------------------
  // The readout and the callbacks
  // -------------------------------------------------------------------------

  private readout(entries: LedgerEntry[], items: Map<string, ListItem>, incidents: WalkResult['incidents'], health: string, notes: string[], stillPending: number): string {
    const label = (id: string) => {
      const item = items.get(id);
      const title = item ? (item.text.length > 60 ? `${item.text.slice(0, 57)}...` : item.text) : '';
      return item?.ref?.pullRequest ? `PR #${item.ref.pullRequest} ${title}` : id;
    };
    const verified: Line[] = [];
    const pendingLines: Line[] = [];
    const headsUp: Line[] = [...notes];
    const waiting: Line[] = [];
    for (const entry of entries) {
      if (entry.itemId === LIVENESS_ITEM) continue;
      if (entry.verdict === 'present' || entry.verdict === 'intact') verified.push(`${label(entry.itemId)}: ${entry.verdict} (${entry.rung})`);
      else if (entry.verdict === 'not-checkable') headsUp.push(`${label(entry.itemId)}: not checkable; ${entry.reason}`);
      else if (!REPAIR.has(entry.verdict)) pendingLines.push(`${label(entry.itemId)}: ${entry.verdict.replaceAll('-', ' ')}`);
    }
    // Only what a person must act on is waiting on them; a failure the floor is repairing is in flight.
    for (const entry of entries.filter((e) => REPAIR.has(e.verdict))) {
      const incident = incidents.find((i) => i.itemId === entry.itemId);
      const text = `${label(entry.itemId)} is ${entry.verdict}: ${entry.reason}`;
      if (this.withAPerson.has(entry.itemId)) waiting.push(`${text}; incident #${incident?.issue ?? this.incidentOf.get(entry.itemId) ?? '?'} needs a person`);
      else if (incident) pendingLines.push(`${text}; incident #${incident.issue}: ${incident.outcome}, walked again next time`);
      else headsUp.push(text);
    }
    if (this.ownPause()) headsUp.push('the merge line is paused until a walk finds the floor right again');
    if (stillPending > 0) pendingLines.push(`${stillPending} item(s) on the floor still owed a verdict`);
    return renderReadout({
      title: 'floor walk',
      labels: { landed: 'Verified', inFlight: 'Pending' },
      sections: { landed: verified, inFlight: pendingLines, health: [health], headsUp, waiting },
    });
  }

  private payloadBase() {
    const { project, repoRoot } = this.o.ctx;
    return { repo: project.repo, baseBranch: project.baseBranch, repoRoot, floorDir: this.o.dir };
  }

  private async slot(name: string, payload: unknown, vars: Record<string, string>): Promise<void> {
    const { ctx, callbacksDir, log } = this.o;
    if (this.rehearsal) return;
    const say = (message: string) => log(`floor: ${message}`);
    try {
      const slot = await runCallback(callbacksDir, name, payload, say);
      this.checkpoint();
      if (slot.prompt !== undefined) await runCallbackPrompt(ctx, this.o.seats.callback, name, slot.prompt, vars, 0, say);
    } catch (error) {
      // A callback is the producer's; it can never stop the walk, only a stop can.
      if (error instanceof RunStopping) throw error;
      say(`${name} failed: ${(error as Error).message}`);
    }
  }

  private onWalk(walk: WalkResult): Promise<void> {
    return this.slot('on-walk', { ...walk, ...this.payloadBase() }, { READOUT: walk.readout, WALK: JSON.stringify(walk, null, 2), FLOOR_DIR: this.o.dir });
  }

  private onWalkFail(entry: LedgerEntry, item: ListItem | undefined): Promise<void> {
    return this.slot('on-walk-fail', { entry, item: item ?? null, ...this.payloadBase() }, {
      ITEM: entry.itemId,
      VERDICT: entry.verdict,
      REASON: entry.reason,
      ENTRY: JSON.stringify(entry, null, 2),
      FLOOR_DIR: this.o.dir,
    });
  }
}

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
import { readLandBlocker } from '../../../fix-github-issue/lib/land.ts';
import { type Diagnosis, diagnose, handleIncident, mergedSince, openIncidentFor } from './incident.ts';
import { combineCauses, type FloorCause, floorReason, isOutage, type Pause, standingPause } from './line.ts';
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
import { ghLineage, type Lineage, type LineageOf, owedTo, renderLineage } from './lineage.ts';
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
  /** Reads where an issue sits in a carved trunk; the forge by default. */
  lineageOf?: LineageOf;
  /** How many pull requests wait at the merge, for the readout of an outage; unknown when absent. */
  waitingAtMerge?: () => number;
  /** How a wrong item's incident is diagnosed, filed, and worked; `handleIncident`, unless a test supplies its own. */
  handleIncident?: typeof handleIncident;
};

/** An open incident as the tracker reports it now; undefined when the tracker could not be read. */
type IncidentState = { number: number; withAPerson: boolean } | null | undefined;

/**
 * Who still needs a person, judged at render time rather than when the incident was filed: an item
 * stays only while its newest ledger verdict is still wrong and its incident is still open with a
 * person. An item that walked right, or whose incident closed or went back to the pipeline, drops
 * out. A tracker that cannot be read keeps the item: an unconfirmed resolution is not one.
 */
export function stillWithAPerson(
  owned: Iterable<string>,
  latest: Map<string, LedgerEntry>,
  readIncident: (itemId: string) => IncidentState,
): Array<{ itemId: string; entry: LedgerEntry; incident: number | null }> {
  const kept: Array<{ itemId: string; entry: LedgerEntry; incident: number | null }> = [];
  for (const itemId of owned) {
    const entry = latest.get(itemId);
    if (!entry || !REPAIR.has(entry.verdict)) continue;
    const incident = readIncident(itemId);
    if (incident === null || incident?.withAPerson === false) continue;
    kept.push({ itemId, entry, incident: incident?.number ?? null });
  }
  return kept;
}

type AgentVerdictFile = { entries: Array<{ itemId: string; rung: string; verdict: string; reason: string; evidence?: string; sibling?: unknown }> };

export { FLOOR_PAUSE } from './line.ts';

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
  /** Items whose incident is parked at the merge boundary with an approved fix: a person lands it, not lifts it. */
  private readonly landable = new Set<string>();
  /** Open incidents by item, for the readout. */
  private readonly incidentOf = new Map<string, number>();
  /** Items whose incident's fix merged, by that incident: the fix has to deploy before another try. */
  private readonly fixedBy = new Map<string, number>();
  /** Ids this run put on the floor; the drain waits on these, not on everything ever listed. */
  private readonly mine = new Set<string>();
  /** Probe, classify, and report only: no ledger, line, callback, checkout, agent, or incident. */
  private readonly rehearsal: boolean;
  private readonly lineageOf: LineageOf;
  /** Lineages read during the current walk, by issue; the tracker can change between walks. */
  private lineages = new Map<number, Lineage | null>();
  /** What each wrong item's diagnosis said about where its remedy lies; the line's cause is read from these. */
  private readonly causes = new Map<string, FloorCause>();
  /** Items that turned wrong and that no diagnosis has answered for yet. */
  private readonly diagnosing = new Set<string>();
  /**
   * The cause on a floor pause an earlier run left, for wrong items this run has no diagnosis of:
   * an incident a person already owns is not diagnosed again, and its cause should not be lost.
   */
  private inherited: FloorCause | null = null;

  constructor(options: FloorOptions) {
    this.o = options;
    this.env = { ...options.config.environment, ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}) };
    this.rehearsal = options.ctx.dryRun || options.baseUrl !== undefined;
    this.checkout = resolve(options.ctx.repoRoot, options.ctx.project.worktreeRoot, 'floor-checkout');
    this.lineageOf = options.lineageOf ?? ghLineage(options.ctx);
    const pause = this.pause();
    if (pause?.by === 'floor') this.inherited = pause.cause;
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

  /**
   * Items still owed a terminal verdict, less those a person owns and those whose missing effect an
   * open sibling owns (that sibling's own merge is what settles them): this run's, or every one.
   */
  owed(scope: 'run' | 'all' = 'all'): ListItem[] {
    const ledger = readLedger(this.o.dir);
    const latest = latestByItem(ledger);
    return pending(readList(this.o.dir), ledger).filter(
      (item) => !this.withAPerson.has(item.id) && latest.get(item.id)?.verdict !== 'owed-by-sibling' && (scope === 'all' || this.mine.has(item.id)),
    );
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

  /** The pause on the switch as the loop reads it, or null for go. */
  private pause(): Pause | null {
    return standingPause(this.o.switchFile);
  }

  private paused(): boolean {
    return this.pause() !== null;
  }

  private ownPause(): boolean {
    return this.pause()?.by === 'floor';
  }

  /** A person's pause or a host pause stands: the floor neither replaces nor releases it. */
  private pausedByOther(): boolean {
    const pause = this.pause();
    return pause !== null && pause.by !== 'floor';
  }

  /** Items whose newest entry says the environment is wrong, liveness included; quiet-window ones aside. */
  private wrongNow(): LedgerEntry[] {
    return [...latestByItem(readLedger(this.o.dir)).values()].filter((entry) => REPAIR.has(entry.verdict) && !entry.quiet);
  }

  /** The cause the line carries now: what every wrong item's diagnosis said, or that none has yet. */
  private lineCause(wrong: LedgerEntry[]): FloorCause {
    if (wrong.length === 0) return 'undiagnosed';
    return combineCauses(wrong.map((e) => (this.diagnosing.has(e.itemId) ? 'undiagnosed' : (this.causes.get(e.itemId) ?? this.inherited ?? 'undiagnosed'))));
  }

  private writePause(): void {
    const wrong = this.wrongNow();
    const cause = this.lineCause(wrong);
    const reason = wrong.map((e) => `${e.itemId} is ${e.verdict}`).join('; ');
    const text = `pause\n${floorReason(cause, reason)}; see the ledger on the floor\n`;
    if (existsSync(this.o.switchFile) && readFileSync(this.o.switchFile, 'utf8') === text) return;
    writeFileSync(this.o.switchFile, text);
    this.o.log(`floor: line paused, ${cause} (${reason})`);
  }

  /**
   * Pauses for the floor at once, before any diagnosis, unless a person or the host already paused
   * the line: that reason stands. The items that turned are undiagnosed until their diagnosis answers.
   */
  private pauseLine(turned: LedgerEntry[]): void {
    for (const entry of turned) this.diagnosing.add(entry.itemId);
    if (this.rehearsal) return;
    if (this.pausedByOther()) return;
    this.writePause();
  }

  /**
   * A diagnosis answered for an item: record where its remedy lies and restate the floor's own
   * pause with it. `null` is no new answer (an incident a person already owns), so what was known stands.
   */
  private diagnosed(itemId: string, cause: FloorCause | null): void {
    this.diagnosing.delete(itemId);
    if (cause !== null) this.causes.set(itemId, cause);
    if (this.rehearsal || !this.ownPause()) return;
    if (this.wrongNow().length > 0) this.writePause();
  }

  /**
   * Settles the line after a walk: while anything is wrong the floor's pause stands, restated with its
   * cause, and is written again over a go (a person's go releases a host pause, not a wrong floor);
   * once nothing is wrong the floor releases its own pause. A person's pause or a host pause is never
   * touched.
   */
  private releaseLine(): void {
    if (this.rehearsal || this.pausedByOther()) return;
    const wrong = this.wrongNow();
    const stillWrong = new Set(wrong.map((e) => e.itemId));
    for (const id of [...this.causes.keys()]) if (!stillWrong.has(id)) this.causes.delete(id);
    for (const id of [...this.diagnosing]) if (!stillWrong.has(id)) this.diagnosing.delete(id);
    if (wrong.length > 0) {
      this.writePause();
      return;
    }
    if (!this.ownPause()) return;
    this.inherited = null;
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
    this.lineages = new Map();

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
      const unsettled = pending([...items.values()], readLedger(this.o.dir));
      // An issue whose merge is on the floor and not verified yet has not landed where a walk looks.
      const landing = new Set(unsettled.map((item) => item.ref?.issue).filter((n): n is number => n !== undefined));
      for (const item of unsettled) {
        // Owed to a sibling still open, or merged and not yet verified: nothing to look at until it lands.
        const prior = before.get(item.id);
        if (prior?.verdict === 'owed-by-sibling' && prior.sibling !== undefined && (landing.has(prior.sibling) || owedTo(this.lineage(item), prior.sibling))) continue;
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
    let wrong = entries.filter((entry) => REPAIR.has(entry.verdict));
    // A carved child that just turned absent, with open siblings under its trunk, is diagnosed
    // before anything pauses: when an open sibling owns the missing effect, it is owed, not wrong.
    const diagnoses = new Map<string, Diagnosis | null>();
    if (wrong.length > 0 && !quiet && !options.livenessOnly && !this.rehearsal) {
      for (const entry of wrong) {
        if (entry.verdict !== 'absent' || before.get(entry.itemId)?.verdict === 'absent') continue;
        const item = items.get(entry.itemId);
        const lineage = item ? this.lineage(item) : null;
        if (!lineage || lineage.openSiblings.length === 0) continue;
        this.checkpoint();
        const diagnosis = await this.diagnoseAt(entry, deployed, item?.ref?.mergedAt, lineage);
        const owner = diagnosis?.remedy === 'owed-by-sibling' ? owedTo(lineage, diagnosis.sibling) : null;
        if (!owner) {
          diagnoses.set(entry.itemId, diagnosis);
          continue;
        }
        const owed: LedgerEntry = { ...entry, checkedAt: new Date().toISOString(), verdict: 'owed-by-sibling', sibling: owner.number, reason: `${entry.reason} Diagnosis: ${diagnosis?.summary ?? ''}`.trim() };
        this.record(owed, entries);
        entries.splice(entries.indexOf(entry), 1);
      }
      wrong = entries.filter((entry) => REPAIR.has(entry.verdict));
    }
    if (wrong.length > 0 && !quiet) {
      const turned = wrong.filter((entry) => {
        const prior = before.get(entry.itemId);
        return prior?.verdict !== entry.verdict || prior.quiet === true;
      });
      if (turned.length > 0) {
        this.pauseLine(turned);
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
          const item = items.get(entry.itemId);
          const repaired = await this.repair(entry, deployed, item?.ref?.mergedAt, item ? this.lineage(item) : null, diagnoses.get(entry.itemId));
          // A repair that threw is a diagnosis that could not answer.
          this.diagnosed(entry.itemId, repaired ? repaired.cause : 'cause-unknown');
          const incident = repaired && { issue: repaired.issue, outcome: repaired.outcome };
          if (incident?.outcome === 'merged') this.fixedBy.set(entry.itemId, incident.issue);
          if (incident) incidents.push({ itemId: entry.itemId, ...incident });
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

    if (!this.rehearsal) this.refreshOwnership();
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
            const lineage = this.lineage(item);
            return `- **\`${item.id}\`**: ${item.text}\n  ${refText}${walks ? `\n  standing walks: ${walks}` : ''}${lineage ? `\n${renderLineage(lineage, '  ')}` : ''}`;
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
        if (entry.verdict === 'owed-by-sibling') {
          // Owed only to a sibling that is open under this item's trunk; naming anything else leaves
          // the effect missing with nobody coming to supply it.
          const owner = owedTo(this.lineage(item), raw.sibling);
          if (owner) entry.sibling = owner.number;
          else {
            entry.verdict = 'absent';
            entry.reason = `${raw.reason} (it named ${typeof raw.sibling === 'number' ? `#${raw.sibling}` : 'no sibling'}, which is not an open sibling under this item's trunk)`;
          }
        }
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
      if (open?.withAPerson) this.noteLandable(itemId, open.number);
      return open !== null;
    } catch {
      return false;
    }
  }

  /**
   * Re-reads who owns each item a person was last seen owning, from the ledger and the tracker as
   * they stand now, so the readout and the drain never act on an incident state cached when it was
   * filed.
   */
  private refreshOwnership(): void {
    const latest = latestByItem(readLedger(this.o.dir));
    const read = (itemId: string): IncidentState => {
      try {
        return openIncidentFor(this.o.ctx, itemId);
      } catch {
        return undefined;
      }
    };
    const kept = stillWithAPerson(this.withAPerson, latest, read);
    const keep = new Set(kept.map((k) => k.itemId));
    for (const itemId of [...this.withAPerson]) {
      if (keep.has(itemId)) continue;
      this.withAPerson.delete(itemId);
      this.incidentOf.delete(itemId);
      this.landable.delete(itemId);
    }
    for (const { itemId, incident } of kept) if (incident !== null) this.incidentOf.set(itemId, incident);
  }

  /** Where an item's issue sits in a carved trunk, read once per walk; null without an issue or a readable one. */
  private lineage(item: ListItem): Lineage | null {
    const issue = item.ref?.issue;
    if (issue === undefined) return null;
    if (!this.lineages.has(issue)) {
      try {
        this.lineages.set(issue, this.lineageOf(issue));
      } catch (error) {
        this.o.log(`floor: could not read issue #${issue}'s trunk: ${(error as Error).message}`);
        this.lineages.set(issue, null);
      }
    }
    return this.lineages.get(issue) ?? null;
  }

  private async diagnoseAt(entry: LedgerEntry, deployed: string | null, mergedAt: string | undefined, lineage: Lineage): Promise<Diagnosis | null> {
    const { ctx } = this.o;
    this.makeCheckout(deployed ?? `${ctx.project.remote}/${ctx.project.baseBranch}`);
    try {
      return await diagnose(ctx, { dir: this.o.dir, entry, checkout: this.checkout, walker: this.o.seats.walker, logsCommand: this.env.logsCommand, mergedAt, lineage });
    } finally {
      this.removeCheckout();
    }
  }

  /** Whether a person lands this incident's fix (`fix.ts --land`) rather than lifting its label; unknown reads as no. */
  private noteLandable(itemId: string, issue: number): void {
    this.landable.delete(itemId);
    if (!issue || this.o.ctx.dryRun) return;
    try {
      if (readLandBlocker(this.o.ctx, issue) === null) this.landable.add(itemId);
    } catch (error) {
      if (error instanceof RunStopping || isStopping()) throw error;
    }
  }

  private async repair(entry: LedgerEntry, deployed: string | null, mergedAt: string | undefined, lineage: Lineage | null, diagnosis: Diagnosis | null | undefined): Promise<{ issue: number; outcome: string; cause: FloorCause | null } | null> {
    const { ctx } = this.o;
    this.makeCheckout(deployed ?? `${ctx.project.remote}/${ctx.project.baseBranch}`);
    try {
      const result = await (this.o.handleIncident ?? handleIncident)(ctx, {
        dir: this.o.dir,
        entry,
        checkout: this.checkout,
        walker: this.o.seats.walker,
        logsCommand: this.env.logsCommand,
        maxPoints: this.o.maxPoints,
        mergedAt,
        lineage,
        diagnosis,
        onDiagnosed: (cause) => this.diagnosed(entry.itemId, cause),
      });
      if (result.withAPerson) this.withAPerson.add(entry.itemId);
      else this.withAPerson.delete(entry.itemId);
      this.incidentOf.set(entry.itemId, result.issue);
      if (result.withAPerson) this.noteLandable(entry.itemId, result.issue);
      else this.landable.delete(entry.itemId);
      return { issue: result.issue, outcome: result.fix?.outcome ?? (result.withAPerson ? 'with a person' : 'filed'), cause: result.cause };
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
      else if (entry.verdict === 'owed-by-sibling') pendingLines.push(`${label(entry.itemId)}: owed by sibling #${entry.sibling}, walked again once it closes`);
      else if (!REPAIR.has(entry.verdict)) pendingLines.push(`${label(entry.itemId)}: ${entry.verdict.replaceAll('-', ' ')}`);
    }
    // Only what a person must act on is waiting on them, and it stays there every walk until they
    // do, walked this time or not; a failure the floor is still repairing is in flight.
    for (const entry of entries.filter((e) => REPAIR.has(e.verdict) && !this.withAPerson.has(e.itemId))) {
      const incident = incidents.find((i) => i.itemId === entry.itemId);
      const text = `${label(entry.itemId)} is ${entry.verdict}: ${entry.reason}`;
      if (incident) pendingLines.push(`${text}; incident #${incident.issue}: ${incident.outcome}, walked again next time`);
      else headsUp.push(text);
    }
    // Already re-read against the ledger and the tracker this walk (refreshOwnership).
    const latest = latestByItem(readLedger(this.o.dir));
    for (const itemId of this.withAPerson) {
      const issue = this.incidentOf.get(itemId);
      waiting.push(incidentWaiting(label(itemId), issue, this.landable.has(itemId), latest.get(itemId)?.verdict));
    }
    if (this.ownPause()) headsUp.push(this.pauseReadout());
    if (stillPending > 0) pendingLines.push(`${stillPending} item(s) on the floor still owed a verdict`);
    return renderReadout({
      since: new Date(this.openedAt),
      title: 'floor walk',
      sections: [
        { emoji: '✅', label: 'Verified', lines: verified },
        { emoji: '🔄', label: 'Pending', lines: pendingLines },
        { emoji: '🩺', lines: [health] },
        { emoji: '⚠️', lines: headsUp },
      ],
      needsYou: waiting,
    });
  }

  /** What the floor's own pause holds, for the readout: an outage holds only the merge, and says how many wait there. */
  private pauseReadout(): string {
    const pause = this.pause() ?? { by: 'person' };
    if (!isOutage(pause)) {
      const cause = pause.by === 'floor' ? pause.cause : 'undiagnosed';
      return `the line is paused (${cause}): merges wait and no new lane starts until a walk finds the floor right again`;
    }
    const waiting = this.o.waitingAtMerge?.();
    const stacked = waiting === undefined ? '' : `; ${waiting} pull request(s) waiting at the merge`;
    return `outage outside the repository: only merges are held, other work goes on, and they land one at a time when a walk finds it up${stacked}`;
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

/**
 * The readout's line for an incident a person owns. A fix the merge boundary parked is approved and
 * waits only on a person's go-ahead: lifting its label would hand it to a run that parks it again,
 * so the line names the landing instead.
 */
export function incidentWaiting(label: string, issue: number | undefined, landable: boolean, verdict = 'wrong'): string {
  if (issue && landable) {
    return `${label} is still ${verdict} and incident #${issue}'s fix is approved and parked at the merge boundary: review its pull request and land it with \`fix.ts --land ${issue}\`, or close it`;
  }
  return `${label} is still ${verdict} and incident ${issue ? `#${issue}` : '(see floor/incident)'} is parked for you: fix it, close it, or lift its label to hand it back`;
}

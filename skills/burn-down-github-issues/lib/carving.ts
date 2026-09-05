/**
 * The burndown's side of carving: the close hook that rolls a leaf's close up to its trunk and
 * revisits it, the release appraisal that finishes an exhausted trunk under the loop's own claim,
 * and the sweep that runs at the start of every run so closes, edits, holds, and crashes made
 * outside the loop are seen. The knife itself is the sibling skill; this file only decides when
 * to call it and what to do with the answer.
 */

import { appraiseIssue, type AppraiseKnobs, isHeld } from '../../appraise-github-issues/lib/appraise.ts';
import type { Seat } from '../../fix-github-issue/lib/engines.ts';
import type { CarveKnobs } from '../../carve-github-issue/lib/carve.ts';
import { claim, keepClaimed, trackerIo } from '../../carve-github-issue/lib/claims.ts';
import { carveIssue } from '../../carve-github-issue/lib/knife.ts';
import { descendants, liveClaim, needsRevisit, parseMarker, pointsOf, readTree, type Tree } from '../../carve-github-issue/lib/tree.ts';
import type { CloseEvent, Context } from '../../fix-github-issue/lib/context.ts';
import { HOLD_LABELS } from '../../fix-github-issue/lib/labels.ts';
import type { Issue } from '../../fix-github-issue/lib/pipeline.ts';
import { mutate } from '../../fix-github-issue/lib/shell.ts';
import type { Stage } from '../status.ts';

export type CarvingDeps = {
  ctx: Context;
  knobs: CarveKnobs;
  appraisal: {
    seats: { appraiser: Seat; confirmer: Seat };
    confirmCloses: boolean;
    skipLabels: string[];
    maxAppraiseAttempts: number;
    sizeCallbackTimeoutMinutes: number;
  };
  /** `--only`, when given: the sweep restricts itself to these numbers. */
  only: Set<number> | null;
  ageDays: number;
  mark: (issue: number, title: string, stage: Stage, note?: string) => void;
  log: (message: string) => void;
};

const SWEEP_LABELS = ['loop/carved', 'loop/released', 'loop/handed-off', 'loop/carving', 'loop/working', 'loop/paused'];

function stageOf(outcome: string): Stage {
  if (outcome === 'carve' || outcome === 'amend' || outcome === 'resumed') return 'carved';
  if (outcome === 'exhausted') return 'released';
  if (outcome === 'still-good') return 'revisited';
  if (outcome === 'failed') return 'failed';
  if (outcome === 'busy' || outcome === 'left-alone') return 'revisited';
  return 'handed-off';
}

function issueOf(tree: Tree): Issue {
  return { number: tree.issue.number, title: tree.issue.title, createdAt: tree.issue.createdAt, labels: tree.issue.labels, parent: tree.issue.parent, subIssuesSummary: tree.issue.subIssuesSummary, blockedBy: tree.issue.blockedBy };
}

/** One revisit per trunk per run; later closes in the same run are seen by the next sweep. */
export class Carving {
  private readonly revisited = new Set<number>();
  constructor(private readonly deps: CarvingDeps) {}

  /** `ctx.onClosed`: roll the close up to the parent, then revisit the parent once this run. */
  async onClosed(event: CloseEvent): Promise<void> {
    const { ctx, log } = this.deps;
    const io = trackerIo(ctx);
    const closed = io.view(event.issue);
    const parent = closed?.parent?.number ?? null;
    if (parent === null) return;
    const trunk = io.view(parent);
    if (!trunk || trunk.state !== 'OPEN') {
      log(`#${event.issue} closed under #${parent}, which is not open; nothing to roll up`);
      return;
    }
    const marker = `<!-- carve-rollup child=${event.issue} event=${event.kind} at=${event.closedAt} -->`;
    if (!trunk.comments.some((c) => c.author === ctx.botLogin && c.body.startsWith(marker))) {
      const how = event.kind === 'merged' ? `merged in #${event.pr}` : event.kind === 'answered' ? 'answered on its thread' : `closed: ${event.reason}`;
      mutate(ctx, `roll up #${event.issue} on #${parent}`, ['gh', 'issue', 'comment', String(parent), '--body', `${marker}\nLeaf #${event.issue} (${closed?.title ?? ''}) ${how} at ${event.closedAt}.`]);
    }
    await this.revisit(parent, `#${event.issue} closed`);
  }

  /** Hands a trunk to the knife once per run, and finishes a release when the knife exhausts it. */
  async revisit(number: number, why: string): Promise<void> {
    const { ctx, knobs, mark, log } = this.deps;
    if (this.revisited.has(number)) {
      log(`#${number} already revisited this run (${why}); the next sweep sees the rest`);
      return;
    }
    this.revisited.add(number);
    const io = trackerIo(ctx);
    const tree = readTree(ctx, number, io);
    const issue = issueOf(tree);
    mark(number, issue.title, 'revisited', why);
    let outcome: Awaited<ReturnType<typeof carveIssue>>;
    try {
      outcome = await carveIssue(ctx, issue, knobs, io);
    } catch (error) {
      mark(number, issue.title, 'failed', (error as Error).message.slice(0, 80));
      throw error;
    }
    mark(number, issue.title, stageOf(outcome.outcome), outcome.reason.slice(0, 80));
    if (outcome.outcome === 'exhausted') await this.releaseAppraisal(number);
  }

  /**
   * The release appraisal, re-run from the tracker's state until `loop/released` is gone: with no
   * size label, appraise the remainder (no size callback); a size at or under the ceiling takes
   * the label off; a size over it carves the next generation in process, then takes it off.
   */
  async releaseAppraisal(number: number): Promise<void> {
    const { ctx, knobs, appraisal, mark, log } = this.deps;
    if (ctx.dryRun) {
      log(`DRY RUN  would run the release appraisal on #${number}`);
      return;
    }
    const io = trackerIo(ctx);
    let handle = claim(ctx, io, number, 'carving');
    if (handle === 'busy') {
      log(`#${number} release appraisal: another run holds it`);
      return;
    }
    let stop = keepClaimed(handle);
    try {
      for (let step = 0; step < 4; step++) {
        const tree = readTree(ctx, number, io);
        const labels = tree.issue.labels.map((l) => l.name);
        if (!labels.includes('loop/released') || tree.issue.state !== 'OPEN') return;
        if (labels.some((l) => HOLD_LABELS.includes(l) && l !== 'loop/paused')) return;
        const issue = issueOf(tree);
        const points = pointsOf(tree.issue.labels);
        if (points === null) {
          const outcome = await appraiseIssue(ctx, issue, { ...appraisal, ageDays: null, release: true, ownClaim: ctx.runId, onVerdict: undefined });
          mark(number, issue.title, outcome.retry ? 'failed' : outcome.verdict === 'valid' ? 'sized' : 'handed-off', `release appraisal: ${outcome.reason}`.slice(0, 80));
          if (outcome.verdict !== 'valid') return;
          continue;
        }
        const newerRecord = tree.record && tree.record.state !== 'released';
        if (points > knobs.ceiling && !newerRecord) {
          // The knife claims for itself; this claim steps aside for it and is retaken after.
          stop();
          handle.release();
          const outcome = await carveIssue(ctx, issue, knobs, io);
          mark(number, issue.title, stageOf(outcome.outcome), outcome.reason.slice(0, 80));
          if (outcome.outcome !== 'carve' && outcome.outcome !== 'resumed') return;
          handle = claim(ctx, io, number, 'carving');
          if (handle === 'busy') return;
          stop = keepClaimed(handle);
          continue;
        }
        mutate(ctx, `unlabel #${number} loop/released`, ['gh', 'issue', 'edit', String(number), '--remove-label', 'loop/released']);
        mark(number, issue.title, points > knobs.ceiling ? 'carved' : 'sized', `released at ${points}`);
        return;
      }
    } finally {
      stop();
      if (handle !== 'busy') handle.release();
    }
  }

  /**
   * The sweep: three passes over the open backlog. First, every labelled trunk, claim, or pause:
   * finish, repair, redrive, or revisit. Second, every unlabelled, unheld, unclaimed issue that is
   * oversized inside the window or has an open child at any age. Third, every leaf whose blocker
   * is closed not planned, deleted, or cyclic, and every pause a closed trunk left behind.
   */
  async sweep(all: Issue[]): Promise<void> {
    const { ctx, knobs, only, ageDays, log } = this.deps;
    const io = trackerIo(ctx);
    const inScope = (issue: Issue) => only === null || only.has(issue.number);
    const cutoff = Date.now() - ageDays * 24 * 60 * 60 * 1000;
    const first = new Set<number>();

    for (const issue of all) {
      if (!inScope(issue)) continue;
      const labels = issue.labels.map((l) => l.name);
      if (!labels.some((l) => SWEEP_LABELS.includes(l) || l.startsWith('loop/carve-gen'))) continue;
      first.add(issue.number);
      const tree = readTree(ctx, issue.number, io);
      const now = new Date().toISOString();

      // Torn or expired claims: a label with no live claim behind it comes off, once nothing is pending.
      for (const kind of ['carving', 'working'] as const) {
        const label = kind === 'carving' ? 'loop/carving' : 'loop/working';
        if (!labels.includes(label)) continue;
        const live = tree.claims.some((c) => c.kind === kind && !c.released && Date.parse(c.expires) > Date.parse(now));
        const pending = tree.intents.some((i) => !i.finished && (i.kind === 'applying' || i.kind === 'released' || i.kind === 'carve-handoff'));
        if (live || pending) continue;
        if (ctx.dryRun) {
          log(`DRY RUN  would clear the stale ${label} on #${issue.number}`);
          continue;
        }
        mutate(ctx, `clear stale ${label} on #${issue.number}`, ['gh', 'issue', 'comment', String(issue.number), '--body', `The ${label} label had no live claim behind it (the run died, or was killed); cleared by the sweep.`]);
        mutate(ctx, `unlabel #${issue.number} ${label}`, ['gh', 'issue', 'edit', String(issue.number), '--remove-label', label]);
      }
      // A torn loop/paused: no unreleased marker from any trunk.
      if (labels.includes('loop/paused')) {
        const byTrunk = new Map<number, boolean>();
        for (const c of tree.issue.comments) {
          if (c.author !== ctx.botLogin) continue;
          const m = parseMarker(c.body);
          if (m?.name === 'carve-pause') byTrunk.set(Number(m.fields.by), true);
          if (m?.name === 'carve-unpause') byTrunk.set(Number(m.fields.by), false);
        }
        const anyLive = [...byTrunk.values()].some(Boolean);
        if (!anyLive) {
          if (ctx.dryRun) log(`DRY RUN  would remove the torn loop/paused on #${issue.number}`);
          else {
            mutate(ctx, `comment on #${issue.number}`, ['gh', 'issue', 'comment', String(issue.number), '--body', 'loop/paused with no trunk pausing it; removed by the sweep. A person who wants this held uses loop/skip or a needs-* label.']);
            mutate(ctx, `unlabel #${issue.number} loop/paused`, ['gh', 'issue', 'edit', String(issue.number), '--remove-label', 'loop/paused']);
          }
        }
      }
      const isTrunkish = labels.includes('loop/carved') || labels.includes('loop/released') || labels.includes('loop/handed-off') || labels.some((l) => l.startsWith('loop/carve-gen')) || tree.record !== null || tree.children.length > 0;
      if (!isTrunkish) continue;
      const held = labels.some((l) => HOLD_LABELS.includes(l) && l !== 'loop/paused');
      const pending = tree.intents.some((i) => !i.finished && (i.kind === 'applying' || i.kind === 'released' || i.kind === 'carve-handoff'));
      if (pending) {
        await this.revisit(issue.number, 'an unfinished announcement');
        continue;
      }
      if (labels.includes('loop/released')) {
        if (!held) await this.releaseAppraisal(issue.number);
        continue;
      }
      const redrive = Boolean(tree.record && tree.record.seen.holds.some((h) => !labels.includes(h)));
      if (held) {
        // The knife snapshots a hold it has not recorded, then leaves the trunk to its person.
        if (tree.record && !tree.record.seen.holds.some((h) => labels.includes(h))) await this.revisit(issue.number, 'a hold to snapshot');
        continue;
      }
      if (redrive) {
        await this.revisit(issue.number, 'a hold was removed');
        continue;
      }
      const why = needsRevisit(tree.record, tree, ctx.botLogin);
      if (why) await this.revisit(issue.number, why === 'no-record' ? 'no record' : `${why} changed`);
    }

    // Second pass: oversized in the window, or an open child at any age.
    for (const issue of all) {
      if (!inScope(issue) || first.has(issue.number)) continue;
      const labels = issue.labels.map((l) => l.name);
      if (labels.some((l) => HOLD_LABELS.includes(l) || l === 'loop/dlq')) continue;
      const points = pointsOf(issue.labels);
      const summary = issue.subIssuesSummary;
      const openChild = summary !== undefined && summary.total > summary.completed;
      const oversized = points !== null && points > knobs.ceiling && (only !== null || issue.parent || Date.parse(issue.createdAt) >= cutoff);
      if (!openChild && !oversized) continue;
      const tree = readTree(ctx, issue.number, io);
      if (liveClaim(tree, new Date().toISOString(), ctx.runId)) continue;
      await this.revisit(issue.number, openChild ? 'an open child with no record' : `sized ${points}, over the ceiling`);
    }

    // Third pass: invalid blockers, and pauses left by closed trunks.
    for (const issue of all) {
      if (!inScope(issue)) continue;
      const blockers = issue.blockedBy?.nodes ?? [];
      const invalid = blockers.find((b) => b.state === 'DELETED' || (b.state === 'CLOSED' && b.stateReason !== 'COMPLETED'));
      if (invalid) {
        const parent = issue.parent?.number ?? null;
        const parentNode = parent === null ? null : io.view(parent);
        if (parent !== null && parentNode && parentNode.state === 'OPEN') {
          await this.revisit(parent, `#${issue.number} has an invalid blocker #${invalid.number}`);
        } else if (!issue.labels.some((l) => l.name === 'needs-human')) {
          if (ctx.dryRun) log(`DRY RUN  would hand #${issue.number} to a person for its invalid blocker #${invalid.number}`);
          else {
            mutate(ctx, `comment on #${issue.number}`, ['gh', 'issue', 'comment', String(issue.number), '--body', `<!-- appraise-handoff verdict=needs-human -->\nBlocked by #${invalid.number}, which is ${invalid.state === 'DELETED' ? 'deleted' : 'closed not planned'}, and no open parent owns the dependency. A person decides whether this still waits on anything.`]);
            mutate(ctx, `label #${issue.number} needs-human`, ['gh', 'issue', 'edit', String(issue.number), '--add-label', 'needs-human']);
          }
        }
      }
      const parentNumber = issue.parent?.number ?? null;
      if (parentNumber !== null && issue.labels.some((l) => l.name === 'loop/paused')) {
        const parentNode = io.view(parentNumber);
        if (parentNode && parentNode.state !== 'OPEN') {
          const node = io.view(issue.number);
          const mine = node?.comments.some((c) => c.author === ctx.botLogin && c.body.includes(`carve-pause by=${parentNumber} `) && !node.comments.some((u) => u.author === ctx.botLogin && u.body.includes(`carve-unpause by=${parentNumber}`) && u.databaseId > c.databaseId));
          if (mine) {
            if (ctx.dryRun) log(`DRY RUN  would release the pause #${parentNumber} left on #${issue.number}`);
            else {
              mutate(ctx, `unpause #${issue.number} for closed #${parentNumber}`, ['gh', 'issue', 'comment', String(issue.number), '--body', `<!-- carve-unpause by=${parentNumber} -->\n#${parentNumber} is closed; its pause is released.`]);
              mutate(ctx, `unlabel #${issue.number} loop/paused`, ['gh', 'issue', 'edit', String(issue.number), '--remove-label', 'loop/paused']);
              for (const d of descendants(issue.number, io)) {
                const dn = io.view(d);
                if (dn?.labels.some((l) => l.name === 'loop/paused')) {
                  mutate(ctx, `unpause #${d} for closed #${parentNumber}`, ['gh', 'issue', 'comment', String(d), '--body', `<!-- carve-unpause by=${parentNumber} -->\n#${parentNumber} is closed; its pause is released.`]);
                  mutate(ctx, `unlabel #${d} loop/paused`, ['gh', 'issue', 'edit', String(d), '--remove-label', 'loop/paused']);
                }
              }
            }
          }
        }
      }
    }
  }
}

export { isHeld };
export type { AppraiseKnobs };

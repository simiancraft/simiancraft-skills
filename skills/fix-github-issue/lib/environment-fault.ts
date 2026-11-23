/**
 * Environment faults: a seat's run ended for a reason that lies outside the work. The machine ran
 * out of disk (`ENOSPC`) or memory (`ENOMEM`), a person stopped the agent with a signal this
 * driver did not send, or the tracker could not be reached. Such a run says nothing about the work's concept, code, or proof: the work
 * was not judged, which is a different fact from judged and failed. Every seat that runs an agent
 * refuses such a run by throwing an `EnvironmentFault`, and every driver settles it here, the same
 * way: nothing is counted, nothing is dead-lettered or held, and the work is rerun later.
 *
 * The one exception is a host fault the work itself causes (tests that fill the disk or leak
 * memory). The first host fault on an issue is free and leaves a marker label; the same kind of
 * fault again on its rerun, after the host was declared fixed, is charged as an ordinary failure.
 * A person's stop is never charged.
 */

import { readFileSync } from 'node:fs';
import type { Context } from './context.ts';
import { ensureLabel } from './labels.ts';
import { loopNote } from './note.ts';
import { mutate, sh, transportFailureIn } from './shell.ts';
import { stopComment, stopIn } from './stop-record.ts';

/** The host conditions, by errno code: the machine's, never the work's, the first time. */
export const HOST_FAULT_KINDS = ['ENOSPC', 'ENOMEM'] as const;
export type HostFaultKind = (typeof HOST_FAULT_KINDS)[number];
/**
 * `stopped`: a stop signal this driver did not send, a person's most likely. `transport`: the
 * tracker could not be reached. `stuck-check`: a check its provider queued and never started.
 */
export type EnvironmentFaultKind = HostFaultKind | 'stopped' | 'transport' | 'stuck-check';

/**
 * What a run that ended on an environment fault carries: the kind, the signal for a stop, and the
 * role of the seat that ran into it. A fault the driver hit in its own work (a worktree it could
 * not write) names no role.
 */
export type Fault = { kind: EnvironmentFaultKind; signal?: string; role?: string; check?: string; provider?: string };

/** The codes, and the strerror text a command such as git or a shell prints for them instead. */
const PATTERNS: Array<[RegExp, HostFaultKind]> = [
  [/\bENOSPC\b/, 'ENOSPC'],
  [/no space left on device/i, 'ENOSPC'],
  [/\bENOMEM\b/, 'ENOMEM'],
  [/cannot allocate memory/i, 'ENOMEM'],
];

/** Thrown by a seat whose run ended on an environment fault; the message names the seat and the fault. */
export class EnvironmentFault extends Error {
  constructor(
    readonly fault: Fault,
    readonly role: string,
    message: string,
  ) {
    super(message);
  }
}

/** True for a fault of the host (disk, memory), which pauses the line; false for a person's stop or a transport failure. */
export function isHostFault(fault: Fault): fault is Fault & { kind: HostFaultKind } {
  return isHostFaultKind(fault.kind);
}

/** True for a host fault's kind: the one kind of fault the burndown reruns in the same run, once the line is resumed. */
export function isHostFaultKind(kind: string | undefined): kind is HostFaultKind {
  return (HOST_FAULT_KINDS as readonly string[]).includes(kind ?? '');
}

/** The host fault a piece of text reports, or null. */
export function hostFaultIn(text: string): HostFaultKind | null {
  return PATTERNS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

/**
 * The host fault the tail of an agent's log reports, or null. Consulted only after a non-zero exit,
 * like the upstream refusals: an agent whose prose names ENOSPC costs at most a pause on a run that
 * had already failed, and a person releases that.
 */
export function hostFaultInLog(logPath: string): HostFaultKind | null {
  try {
    return hostFaultIn(readFileSync(logPath, 'utf8').slice(-8000));
  } catch {
    return null;
  }
}

/**
 * The environment fault behind a thrown error, or null: an EnvironmentFault's own (with its seat), a Node error's
 * `code` (a write the driver made on a full disk), or a failed command whose message carries the text.
 */
export function environmentFaultOf(error: unknown): Fault | null {
  if (error instanceof EnvironmentFault) return { ...error.fault, role: error.fault.role ?? error.role };
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (HOST_FAULT_KINDS as readonly string[]).includes(code)) return { kind: code as HostFaultKind };
  const kind = error instanceof Error ? hostFaultIn(error.message) : null;
  if (kind) return { kind };
  return error instanceof Error && transportFailureIn(error.message) ? { kind: 'transport' } : null;
}

/** How a fault reads in a log line or a reason. */
export function describeFault(fault: Fault): string {
  if (fault.kind === 'stopped') return `a stop signal (${fault.signal ?? 'unknown'}) this driver did not send`;
  if (fault.kind === 'transport') return 'a transport failure reaching the tracker';
  if (fault.kind === 'stuck-check') return `a check stuck in its provider's queue (${fault.check ?? 'unnamed check'}, by ${fault.provider ?? 'unknown provider'})`;
  return `a host fault (${fault.kind})`;
}

/**
 * The seat a role belongs to: a role's variants are one seat (`coder-revise` and `coder-conflict`
 * are the coder; `panel-framer` and `panel-judge` are the panel's raiser).
 */
export const seatOf = (role: string): string => role.split('-')[0];

/**
 * The marker a free host fault leaves on the issue, one per kind, naming the seat that hit it
 * (`loop/environment-fault: ENOSPC@prover`). It is what makes the exception durable: a restart
 * reads it from the tracker, so the next fault of that kind is still a repeat. A marker with no
 * seat (the driver's own fault, or one written before markers named the seat) belongs to any seat.
 */
export const faultMarker = (kind: HostFaultKind, role?: string | null): string => `loop/environment-fault: ${kind}${role ? `@${seatOf(role)}` : ''}`;

/** The kind and seat a marker label names, or null for a label that is not a fault marker. */
export function parseFaultMarker(name: string): { kind: HostFaultKind; seat: string | null } | null {
  const match = /^loop\/environment-fault: (\w+)(?:@(.+))?$/.exec(name);
  if (!match || !(HOST_FAULT_KINDS as readonly string[]).includes(match[1])) return null;
  return { kind: match[1] as HostFaultKind, seat: match[2] ?? null };
}

/** The fault markers on a set of labels, by kind, each with the seat it names (null: any seat). */
function markersIn(labels: Array<{ name: string }>): Map<HostFaultKind, string | null> {
  const found = new Map<HostFaultKind, string | null>();
  for (const label of labels) {
    const marker = parseFaultMarker(label.name);
    if (marker) found.set(marker.kind, marker.seat);
  }
  return found;
}

/**
 * The fault markers each issue is known to carry, by repository and issue, as its driver read them
 * when it took the issue up and as this process has written them since: each kind, with the seat
 * that hit it. A clean seat run clears them without a tracker read: an issue whose labels this
 * process never saw is left alone.
 */
const knownMarkers = new Map<string, Map<HostFaultKind, string | null>>();
const markerKey = (ctx: Context, issue: number) => `${ctx.project?.repo ?? ''}#${issue}`;

/** Records the fault markers an issue carries, from the labels its driver read when it took it up. */
export function rememberFaultMarkers(ctx: Context, issue: number, labels: Array<{ name: string }>): void {
  knownMarkers.set(markerKey(ctx, issue), markersIn(labels));
}

/**
 * A seat ran for the issue and finished without an environment fault, so that seat's work got past
 * the point its free fault interrupted: the markers that seat left come off (and any marker that
 * names no seat), and a later fault of the same code, which would be a different occasion, is free
 * again. Another seat's clean run clears nothing of a fault it did not hit: a clean coder run says
 * nothing about whether the prover will fill the disk again. A marker that cannot be removed is
 * only logged.
 */
export function clearFaultMarkers(ctx: Context, issue: number, role: string, say: (message: string) => void): void {
  const known = knownMarkers.get(markerKey(ctx, issue));
  if (!known || known.size === 0) return;
  const seat = seatOf(role);
  for (const [kind, faulted] of [...known]) {
    if (faulted !== null && faulted !== seat) continue;
    // Known to carry it no longer, which outranks a snapshot of the labels read before this cleared it.
    known.delete(kind);
    const marker = faultMarker(kind, faulted);
    try {
      mutate(ctx, `unlabel #${issue} ${marker}`, ['gh', 'issue', 'edit', String(issue), '--remove-label', marker]);
      say(`${role} ran cleanly after the free ${kind} fault; ${marker} comes off`);
    } catch (error) {
      say(`could not remove ${marker}: ${(error as Error).message.split('\n')[0]}`);
    }
  }
}

/**
 * An outside stop: the work stopped for a reason the change did not cause. Its cause decides what
 * follows. `host` (a full disk or exhausted memory), `signal` (a stop this driver did not send),
 * `transport` (the tracker unreachable), and `stuck-check` (a check its provider queued and never
 * started, which the checks wait names) end a run that judged nothing, and the work reruns. `base`
 * (a gate that fails on the untouched base) and `needs-person` (a seat that needs access, a
 * credential, or a record it may not touch) end a run that cannot go on without a person, and the
 * work waits on one with its pull request held open. Whatever the cause, nothing is counted, no
 * pull request is closed, and the stop is recorded on the issue (`loop-stop kind=outside`).
 */
export type OutsideCause = 'host' | 'signal' | 'transport' | 'stuck-check' | 'base' | 'needs-person';

/** The causes a person answers; every other cause reruns the work. */
export const WAITS_ON_A_PERSON: readonly OutsideCause[] = ['base', 'needs-person'];

/** The cause behind a fault a run ended on. */
export function causeOf(fault: Fault): OutsideCause {
  if (isHostFault(fault)) return 'host';
  return fault.kind === 'transport' || fault.kind === 'stuck-check' ? fault.kind : 'signal';
}

/**
 * A stop to settle: a fault a run ended on (its cause follows from it), or a seat's word that the
 * work needs a person, with the seat and its reason.
 */
export type OutsideStop = { fault: Fault } | { cause: 'base' | 'needs-person'; seat: 'coder' | 'prover'; reason: string };

/**
 * What a settled stop came to. `free`: the work was not judged; nothing is counted, and it reruns
 * or waits on a person by its cause. `charged`: the same host fault came back on the rerun, so the
 * work reproduced it, and the caller settles it as an ordinary failure with `reason`.
 */
export type FaultSettlement = { charged: false; reason: string; held?: true } | { charged: true; reason: string };

/**
 * How many outside stops of one rerunning cause in a row (`transport`, `stuck-check`) an issue may
 * take before the next one waits on a person instead of rerunning. Text that only looks like a
 * network failure, or a check a provider never starts, would otherwise rerun the work on every run.
 */
export const OUTSIDE_REPEAT_BOUND = 3;

/** The rerunning causes whose repeats are bounded; a host fault has its marker, and a person's stop is never bounded. */
const BOUNDED: readonly OutsideCause[] = ['transport', 'stuck-check'];

/**
 * How many of the newest stops on the issue's thread are the loop's outside stops of this cause, in
 * a row: the record the earlier runs left is what makes the count survive a restart. Any other stop
 * (an approval, a park, a hold) ends the run of them. A thread that cannot be read counts none, so
 * a tracker that is down reruns as before.
 */
function repeatsOf(ctx: Context, issue: number, cause: OutsideCause): number {
  let comments: Array<{ author: string; body: string }>;
  try {
    if (ctx.io?.view) {
      comments = ((ctx.io.view(issue) as { comments?: Array<{ author: string; body: string }> } | null)?.comments ?? []);
    } else {
      const raw = JSON.parse(sh(ctx, ['gh', 'issue', 'view', String(issue), '--json', 'comments'], ctx.repoRoot, 1)) as { comments: Array<{ author: { login: string } | null; body: string }> };
      comments = raw.comments.map((c) => ({ author: c.author?.login ?? 'ghost', body: c.body }));
    }
  } catch {
    return 0;
  }
  let repeats = 0;
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].author !== ctx.botLogin) continue;
    const stop = stopIn(comments[i].body);
    if (!stop) continue;
    if (stop.kind !== 'outside' || stop.fields.cause !== cause) break;
    repeats += 1;
  }
  return repeats;
}

/** Where a held pull request stands while it waits, and the record the hold leaves instead of the default one. */
export type HoldOptions = { pr?: number; continuation?: boolean; record?: string };

/** Writes that only report a stop: a failure is logged, and the settlement stands without it. */
function report(ctx: Context, say: (message: string) => void, description: string, argv: string[]): void {
  try {
    mutate(ctx, description, argv);
  } catch (error) {
    say(`could not ${description}: ${(error as Error).message.split('\n')[0]}`);
  }
}

/**
 * The one place an outside stop is settled, whichever seat or driver met it.
 *
 * A fault: a host fault asks the driver to pause the line (`onHostFault`), charged or not, since the
 * host is in that state either way; it is free the first time and leaves its marker
 * (`loop/environment-fault: <code>@<seat>`), and the same kind again, with the marker on the issue,
 * is charged and the marker comes off. A signal and a transport failure are always free. A free
 * fault is recorded on the issue, and the work reruns.
 *
 * A seat's word that the work needs a person: the issue carries `needs-human`, and the pull request,
 * when there is one, stays open with `needs-human` on it too and a pointer to the issue; a pull
 * request this work was continuing goes back to draft. The record says why and how the hold comes
 * off (`options.record` replaces the default words, as a held proof's own does).
 */
export function settleOutsideStop(
  ctx: Context,
  issue: { number: number; labels: Array<{ name: string }> },
  stop: OutsideStop,
  where: string,
  say: (message: string) => void,
  options: HoldOptions = {},
): FaultSettlement {
  if ('fault' in stop) return settleFault(ctx, issue, stop.fault, where, say);
  const { cause, seat, reason } = stop;
  const { pr, continuation } = options;
  const why = cause === 'base' ? 'a gate fails on the untouched base, which is not this change\'s to fix' : 'the work needs a person';
  const body =
    options.record ??
    stopComment('outside', { cause, seat, pr }, [
      `**Held for a person:** ${why}. ${pr ? `Pull request #${pr} stays open as a draft.` : 'Nothing was closed.'}`,
      '',
      reason.trim(),
      '',
      `Remove the \`needs-human\` label from this issue once that is resolved: the next burndown run continues ${pr ? `#${pr}` : 'the work'}, or run the fix command with \`--redrive\` to do it at once.`,
    ].join('\n'));
  // The record first, then the label that hides the issue from selection: a crash between the two
  // leaves an issue that is still selectable, never one held without a reason on its thread.
  mutate(ctx, `record the hold on #${issue.number}`, ['gh', 'issue', 'comment', String(issue.number), '--body', body]);
  mutate(ctx, `label #${issue.number} needs-human`, ['gh', 'issue', 'edit', String(issue.number), '--add-label', 'needs-human']);
  if (pr) {
    if (continuation) mutate(ctx, `return PR #${pr} to draft while it is held`, ['gh', 'pr', 'ready', String(pr), '--undo']);
    mutate(ctx, `label PR #${pr} needs-human`, ['gh', 'pr', 'edit', String(pr), '--add-label', 'needs-human']);
    const held = seat === 'prover' ? 'Held for a person while proving' : 'Held for a person';
    mutate(ctx, `note the hold on PR #${pr}`, ['gh', 'pr', 'comment', String(pr), '--body', loopNote(`${held}; the reason and how to lift the hold are on #${issue.number}. Not to be merged while \`needs-human\` is on this pull request.`)]);
  }
  return { charged: false, reason: `${why}: ${reason}` };
}

function settleFault(ctx: Context, issue: { number: number; labels: Array<{ name: string }> }, fault: Fault, where: string, say: (message: string) => void): FaultSettlement {
  const what = `${describeFault(fault)}${where ? ` in ${where}` : ''} on #${issue.number}`;
  const record = (rerun: string) =>
    report(ctx, say, `record the outside stop on #${issue.number}`, ['gh', 'issue', 'comment', String(issue.number), '--body', stopComment('outside', { cause: causeOf(fault), seat: fault.role ? seatOf(fault.role) : undefined }, `**Stopped outside the change:** ${what}. The work was not judged and nothing was counted; ${rerun}.`)]);
  if (!isHostFault(fault)) {
    const cause = causeOf(fault);
    const times = BOUNDED.includes(cause) ? repeatsOf(ctx, issue.number, cause) + 1 : 0;
    if (times >= OUTSIDE_REPEAT_BOUND) {
      // The same outside stop on run after run is no longer evidence of a passing outage: a person
      // looks before the work runs again. Recorded as a wait on a person, so a redrive lifts it.
      const seat = fault.role ? seatOf(fault.role) : undefined;
      const reason = `${what}, ${times} times in a row; it waits on a person instead of rerunning`;
      try {
        mutate(ctx, `record the hold on #${issue.number}`, ['gh', 'issue', 'comment', String(issue.number), '--body', stopComment('outside', { cause: 'needs-person', seat, after: cause, times }, [
          `**Held for a person:** ${what}, the same outside stop ${times} times in a row. Nothing was counted, and the work does not rerun on its own again.`,
          '',
          `If the cause has passed, remove the \`needs-human\` label from this issue: the next burndown run continues the work, or run the fix command with \`--redrive\` to do it at once.`,
        ].join('\n'))]);
        mutate(ctx, `label #${issue.number} needs-human`, ['gh', 'issue', 'edit', String(issue.number), '--add-label', 'needs-human']);
        say(reason);
        return { charged: false, reason, held: true };
      } catch (error) {
        say(`could not hold #${issue.number} for a person (${(error as Error).message.split('\n')[0]}); it reruns instead`);
      }
    }
    say(`${what}; the work was not judged: nothing is counted, and it is rerun on a later pass`);
    record('it is rerun on a later pass');
    return { charged: false, reason: `${what}; not judged` };
  }
  try {
    ctx.onHostFault?.(what);
  } catch (hook) {
    say(`could not pause the line: ${(hook as Error).message.split('\n')[0]}`);
  }
  // What this process knows outranks the caller's snapshot, which can predate a clean run's clear.
  const known = knownMarkers.get(markerKey(ctx, issue.number));
  const carried = known ?? markersIn(issue.labels);
  if (carried.has(fault.kind)) {
    // Charged whichever seat hits it again: the work reproduced the host fault before the seat that
    // first hit it got past it.
    const marker = faultMarker(fault.kind, carried.get(fault.kind));
    known?.delete(fault.kind);
    const reason = `the work reproduced ${describeFault(fault)} on its rerun after the host was restored${where ? ` (in ${where})` : ''}, so this time it is charged to the work`;
    say(reason);
    try {
      mutate(ctx, `unlabel #${issue.number} ${marker}`, ['gh', 'issue', 'edit', String(issue.number), '--remove-label', marker]);
    } catch (error) {
      say(`could not remove ${marker}: ${(error as Error).message.split('\n')[0]}`);
    }
    return { charged: true, reason };
  }
  say(`${what}; the work was not judged: nothing is counted, the line is paused, and the work is rerun once it is resumed`);
  const marker = faultMarker(fault.kind, fault.role);
  try {
    ensureLabel(ctx, marker, 'fbca04', 'A run failed on its host and was not judged; the same fault again is charged');
    mutate(ctx, `label #${issue.number} ${marker}`, ['gh', 'issue', 'edit', String(issue.number), '--add-label', marker]);
    const key = markerKey(ctx, issue.number);
    knownMarkers.set(key, new Map([...(knownMarkers.get(key) ?? []), [fault.kind, fault.role ? seatOf(fault.role) : null]]));
  } catch (error) {
    say(`could not mark the free fault (${(error as Error).message.split('\n')[0]}); a repeat will be free too`);
  }
  record('it is rerun once the line is resumed');
  return { charged: false, reason: `${what}; not judged` };
}

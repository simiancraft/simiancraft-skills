/**
 * Environment faults: a seat's run ended for a reason that lies outside the work. The machine ran
 * out of disk (`ENOSPC`) or memory (`ENOMEM`), or a person stopped the agent with a signal this
 * driver did not send. Such a run says nothing about the work's concept, code, or proof: the work
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
import { mutate } from './shell.ts';

/** The host conditions, by errno code: the machine's, never the work's, the first time. */
export const HOST_FAULT_KINDS = ['ENOSPC', 'ENOMEM'] as const;
export type HostFaultKind = (typeof HOST_FAULT_KINDS)[number];
/** `stopped`: a stop signal this driver did not send, a person's most likely. */
export type EnvironmentFaultKind = HostFaultKind | 'stopped';

/**
 * What a run that ended on an environment fault carries: the kind, the signal for a stop, and the
 * role of the seat that ran into it. A fault the driver hit in its own work (a worktree it could
 * not write) names no role.
 */
export type Fault = { kind: EnvironmentFaultKind; signal?: string; role?: string };

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

/** True for a fault of the host (disk, memory), which pauses the line; false for a person's stop. */
export function isHostFault(fault: Fault): fault is Fault & { kind: HostFaultKind } {
  return fault.kind !== 'stopped';
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
  return kind ? { kind } : null;
}

/** How a fault reads in a log line or a reason. */
export function describeFault(fault: Fault): string {
  return fault.kind === 'stopped' ? `a stop signal (${fault.signal ?? 'unknown'}) this driver did not send` : `a host fault (${fault.kind})`;
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
 * What a settled fault came to. `free`: the work was not judged; nothing is counted and the work
 * is rerun later. `charged`: the same host fault came back on the rerun, so the work reproduced it,
 * and the caller settles it as an ordinary failure with `reason`.
 */
export type FaultSettlement = { charged: false; reason: string } | { charged: true; reason: string };

/**
 * The one place an environment fault is settled, whichever seat it came from. A host fault asks the
 * driver to pause the line (`onHostFault`), whether or not it is charged, since the host is in that
 * state either way. A person's stop is always free. A host fault is free the first time and leaves
 * its marker; the same kind again, with the marker on the issue, is charged and the marker comes off.
 * A marker that cannot be written is only logged: the fault stays free.
 */
export function settleEnvironmentFault(ctx: Context, issue: { number: number; labels: Array<{ name: string }> }, fault: Fault, where: string, say: (message: string) => void): FaultSettlement {
  const what = `${describeFault(fault)}${where ? ` in ${where}` : ''} on #${issue.number}`;
  if (!isHostFault(fault)) {
    say(`${what}; the work was not judged: nothing is counted, and it is rerun on a later pass`);
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
  return { charged: false, reason: `${what}; not judged` };
}

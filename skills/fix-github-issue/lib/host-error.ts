/**
 * Host errors: the machine ran out of something (disk, memory), so whatever was running on it
 * failed for a reason that says nothing about the work. A seat that fails this way gave no answer
 * and no wrong one; the pipeline counts nothing, queues nothing, keeps the lane, and asks its
 * driver to pause the line until a person has fixed the host.
 */

import { readFileSync } from 'node:fs';

/** The errno codes that are the host's, never the work's. */
export const HOST_ERROR_CODES = ['ENOSPC', 'ENOMEM'] as const;
export type HostErrorCode = (typeof HOST_ERROR_CODES)[number];

/** The codes, and the strerror text a command such as git or a shell prints for them instead. */
const PATTERNS: Array<[RegExp, HostErrorCode]> = [
  [/\bENOSPC\b/, 'ENOSPC'],
  [/no space left on device/i, 'ENOSPC'],
  [/\bENOMEM\b/, 'ENOMEM'],
  [/cannot allocate memory/i, 'ENOMEM'],
];

/** Thrown where a seat failed on the host; the message names the seat, the code, and its log. */
export class HostError extends Error {
  constructor(
    readonly code: HostErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The host error a piece of text reports, or null. */
export function hostErrorIn(text: string): HostErrorCode | null {
  return PATTERNS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

/**
 * The host error behind a thrown error, or null: a HostError's own code, a Node error's `code`
 * (a write the driver made on a full disk), or a failed command whose message carries the text.
 */
export function hostErrorOf(error: unknown): HostErrorCode | null {
  if (error instanceof HostError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (HOST_ERROR_CODES as readonly string[]).includes(code)) return code as HostErrorCode;
  return error instanceof Error ? hostErrorIn(error.message) : null;
}

/**
 * The host error the tail of an agent's log reports, or null. Consulted only after a non-zero exit,
 * like the upstream refusals: an agent whose prose names ENOSPC costs at most a pause on a run that
 * had already failed, and a person releases that.
 */
export function hostErrorInLog(logPath: string): HostErrorCode | null {
  try {
    return hostErrorIn(readFileSync(logPath, 'utf8').slice(-8000));
  } catch {
    return null;
  }
}

/**
 * The engine registry and the seat spec: which CLIs the pipeline can drive, and how an
 * `engine[:model]` string resolves against them.
 */

import { join } from 'node:path';
import { LAST_MESSAGE_FILE } from './control-files.ts';

const FIXTURE_RUNNER = join(import.meta.dir, 'fixture-runner.ts');

/**
 * Every CLI the loop can drive: how to run one prompt to completion, non-interactively, with the
 * approval gate bypassed. Adding an engine is one entry here and nothing else.
 *
 * Headless runs cannot answer a permission prompt, and the worker needs git, gh, and the network,
 * so every entry carries its CLI's bypass flag. The confinement is the throwaway worktree, not the
 * sandbox; read those flags as the loop's real risk surface rather than as boilerplate.
 *
 * `fixture` and `fixture2` are not models: `fixture:<path>` copies the file at `<path>` into the
 * control file for the role and exits 0, so a gate can drive a flow to an exact verdict. Two names
 * so a worker and its confirmer can both be fixtures and still count as different engines.
 */
export const ENGINES = {
  claude: {
    command: (_cwd: string, prompt: string, model?: string) => [
      'claude',
      '-p',
      prompt,
      ...(model ? ['--model', model] : []),
      '--dangerously-skip-permissions',
    ],
  },
  codex: {
    command: (cwd: string, prompt: string, model?: string) => [
      'codex',
      'exec',
      '--cd',
      cwd,
      ...(model ? ['--model', model] : []),
      '--dangerously-bypass-approvals-and-sandbox',
      '--output-last-message',
      join(cwd, LAST_MESSAGE_FILE),
      prompt,
    ],
  },
  fixture: {
    command: (cwd: string, _prompt: string, model?: string) => ['bun', FIXTURE_RUNNER, cwd, model ?? ''],
  },
  fixture2: {
    command: (cwd: string, _prompt: string, model?: string) => ['bun', FIXTURE_RUNNER, cwd, model ?? ''],
  },
} satisfies Record<string, { command: (cwd: string, prompt: string, model?: string) => string[] }>;

export type Seat = { engine: keyof typeof ENGINES; model?: string };

/** Parses `engine` or `engine:model`, refusing an engine the registry does not know. */
export function parseSeat(spec: string, source: string): Seat {
  const [engine, ...rest] = spec.split(':');
  if (!(engine in ENGINES)) {
    throw new Error(`${source}: unknown engine '${engine}'; known engines: ${Object.keys(ENGINES).join(', ')}`);
  }
  return { engine: engine as keyof typeof ENGINES, model: rest.join(':') || undefined };
}

export function seatLabel(seat: Seat): string {
  return seat.model ? `${seat.engine}:${seat.model}` : seat.engine;
}

/** True for a seat that answers from a file rather than a model. Runs even in a dry run: it mutates nothing. */
export function isFixture(seat: Seat): boolean {
  return seat.engine === 'fixture' || seat.engine === 'fixture2';
}

/**
 * A second opinion is only a second opinion from a different engine. Throws when two seats that
 * are meant to check each other share one; `what` names them in the error.
 */
export function assertDistinctEngines(a: Seat, b: Seat, what: string): void {
  if (a.engine === b.engine) throw new Error(`${what} must be different engines; both are ${a.engine}`);
}

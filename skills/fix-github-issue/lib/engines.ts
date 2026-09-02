/**
 * The engine registry and the seat spec: which CLIs the pipeline can drive, and how an
 * `engine[:model]` string resolves against them.
 */

import { join } from 'node:path';
import { LAST_MESSAGE_FILE } from './control-files.ts';

/**
 * Every CLI the loop can drive: how to run one prompt to completion, non-interactively, with the
 * approval gate bypassed. Adding an engine is one entry here and nothing else.
 *
 * Headless runs cannot answer a permission prompt, and the worker needs git, gh, and the network,
 * so every entry carries its CLI's bypass flag. The confinement is the throwaway worktree, not the
 * sandbox; read those flags as the loop's real risk surface rather than as boilerplate.
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

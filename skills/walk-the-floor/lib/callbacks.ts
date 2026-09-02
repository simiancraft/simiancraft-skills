/**
 * The two callback slots, `on-pass` and `on-fail`. Either an executable the driver runs with the
 * ledger entry on stdin, or a Markdown prompt handed to the agent, or both. The walker never
 * knows what a callback does; the executable form exists so a safety interlock never depends on
 * an agent following a prompt.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LedgerEntry } from './floor.ts';

export type CallbackName = 'on-pass' | 'on-fail';

export type CallbackResult = {
  /** True when an executable existed and was run. */
  ran: boolean;
  exitCode?: number;
  /** The prompt file's text, when one exists, for the caller to hand to the next agent turn. */
  prompt?: string;
};

const CALLBACK_TIMEOUT_MS = 60_000;

function executable(path: string): boolean {
  try {
    const mode = statSync(path).mode;
    return (mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export async function runCallback(
  dir: string,
  name: CallbackName,
  entry: LedgerEntry,
  log: (message: string) => void,
): Promise<CallbackResult> {
  const result: CallbackResult = { ran: false };
  const script = join(dir, name);
  if (existsSync(script) && executable(script)) {
    const proc = Bun.spawn([script], {
      cwd: dir,
      stdin: new Response(`${JSON.stringify(entry)}\n`),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => proc.kill(), CALLBACK_TIMEOUT_MS);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    const out = (await new Response(proc.stdout).text()).trim();
    const err = (await new Response(proc.stderr).text()).trim();
    log(`${name} exited ${exitCode}${out ? `: ${out.split('\n')[0]}` : ''}${err ? ` (stderr: ${err.split('\n')[0]})` : ''}`);
    result.ran = true;
    result.exitCode = exitCode;
  }
  const prompt = join(dir, `${name}.md`);
  if (existsSync(prompt)) result.prompt = readFileSync(prompt, 'utf8');
  return result;
}

/**
 * Callback slots: the way a producer extends a base skill without the base skill knowing what
 * it did. A slot is a name in a directory. An executable of that name is run by the driver with
 * a JSON payload on stdin; a Markdown file of that name plus `.md` is a prompt the caller hands to
 * an agent turn. Either, both, or neither may exist. The executable form exists so anything
 * load-bearing (an interlock, a label, a pause) never depends on an agent following prose.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { children, killAgent, readResult, renderTemplate, runAgent, SETSID } from './agent.ts';
import type { Context } from './context.ts';
import type { Seat } from './engines.ts';
import { RunStopping } from './shell.ts';

/** What a callback prompt may write to `loop-callback.json` to be recorded; optional. */
export type CallbackVerdict = { outcome: string; reason: string };

export const CALLBACK_FILE = 'loop-callback.json';

export type CallbackResult = {
  /** True when an executable existed and was run to completion (any exit code). */
  ran: boolean;
  exitCode?: number;
  /** The prompt file's text, when one exists, for the caller to hand to the next agent turn. */
  prompt?: string;
  /** Which file names were found, for the log. */
  found: string[];
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

/** True when either form of the slot exists. */
export function hasCallback(dir: string, name: string): boolean {
  return (existsSync(join(dir, name)) && executable(join(dir, name))) || existsSync(join(dir, `${name}.md`));
}

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return '';
  return (await new Response(stream).text()).trim();
}

/**
 * Runs the executable form of `name` with `payload` on stdin, and returns the prompt form's text
 * when it exists. Never throws: a callback that fails is logged and the caller continues.
 *
 * The executable leads its own process group where setsid exists and is registered with the
 * agent children, so a timeout or the driver's shutdown takes down whatever it started (a callback
 * that runs the knife runs agents of its own). `timeoutMs: 0` means no timer: a callback that
 * runs agents cannot be bounded by a minute.
 */
export async function runCallback(
  dir: string,
  name: string,
  payload: unknown,
  log: (message: string) => void,
  options: { timeoutMs?: number } = {},
): Promise<CallbackResult> {
  const result: CallbackResult = { ran: false, found: [] };
  const script = join(dir, name);
  if (existsSync(script) && executable(script)) {
    result.found.push(name);
    const timeoutMs = options.timeoutMs ?? CALLBACK_TIMEOUT_MS;
    try {
      const proc = Bun.spawn(SETSID ? [SETSID, script] : [script], {
        cwd: dir,
        stdin: new Response(`${JSON.stringify(payload)}\n`),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      // A callback is often a driver of this collection (the knife, through carve.ts), with its own
      // stop handler, agents, and claims; a stop gives it the time to finish that.
      children.add(Object.assign(proc, { ownDriver: true as const }));
      const timer = timeoutMs > 0 ? setTimeout(() => killAgent(proc), timeoutMs) : null;
      // Both pipes at once: a callback that fills stderr while the driver waits on stdout would hang.
      const [out, err] = await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
      const exitCode = await proc.exited;
      if (timer) clearTimeout(timer);
      children.delete(proc);
      // The last line, not the first: a callback that is itself a driver opens with a banner and
      // ends with what it did.
      const tail = (text: string) => text.split('\n').filter((line) => line.trim() !== '').at(-1) ?? '';
      log(`${name} exited ${exitCode}${out ? `: ${tail(out)}` : ''}${err ? ` (stderr: ${tail(err)})` : ''}`);
      result.ran = true;
      result.exitCode = exitCode;
    } catch (error) {
      log(`${name} could not run: ${(error as Error).message}`);
    }
  }
  const prompt = join(dir, `${name}.md`);
  if (existsSync(prompt)) {
    result.found.push(`${name}.md`);
    result.prompt = readFileSync(prompt, 'utf8');
  }
  return result;
}

/**
 * Runs a slot's prompt form as one agent turn on `seat`, in a scratch directory that is not a
 * checkout, rendered with the project vocabulary plus `vars` and `{{CALLBACK_FILE}}`. Throws only
 * for a stop: a turn that fails, cannot start, or answers nothing is logged with a null verdict.
 */
export async function runCallbackPrompt(
  ctx: Context,
  seat: Seat,
  name: string,
  template: string,
  vars: Record<string, string>,
  key: number,
  say: (message: string) => void,
): Promise<{ exitCode: number; verdict: CallbackVerdict | null }> {
  const cwd = join(ctx.runDir, `callback-${name}-${key}-${process.pid}`);
  try {
    rmSync(cwd, { recursive: true, force: true });
    mkdirSync(cwd, { recursive: true });
    const prompt = renderTemplate(ctx, template, { ...vars, CALLBACK_FILE });
    const run = await runAgent(ctx, 'callback', key, cwd, seat, prompt);
    const answer = run.exitCode === 0 ? readResult<CallbackVerdict>(cwd, CALLBACK_FILE) : null;
    const verdict = answer && typeof answer.outcome === 'string' && typeof answer.reason === 'string' ? answer : null;
    if (verdict) say(`${name}.md: ${verdict.outcome}; ${verdict.reason}`);
    else if (run.exitCode !== 0) say(`${name}.md exited ${run.exitCode}`);
    else say(`${name}.md finished without a recorded outcome`);
    return { exitCode: run.exitCode, verdict };
  } catch (error) {
    // A stop unwinds through here; anything else is the callback's failure, never the caller's.
    if (error instanceof RunStopping) throw error;
    say(`${name}.md could not run: ${(error as Error).message}`);
    return { exitCode: -1, verdict: null };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

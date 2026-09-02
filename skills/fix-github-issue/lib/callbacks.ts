/**
 * Callback slots: the way a producer extends a base skill without the base skill knowing what
 * it did. A slot is a name in a directory. An executable of that name is run by the driver with
 * a JSON payload on stdin; a Markdown file of that name plus `.md` is a prompt the caller hands to
 * an agent turn. Either, both, or neither may exist. The executable form exists so anything
 * load-bearing (an interlock, a label, a pause) never depends on an agent following prose.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type CallbackResult = {
  /** True when an executable existed and was run. */
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

/**
 * Runs the executable form of `name` with `payload` on stdin, and returns the prompt form's text
 * when it exists. Never throws: a callback that fails is logged and the caller continues.
 */
export async function runCallback(
  dir: string,
  name: string,
  payload: unknown,
  log: (message: string) => void,
): Promise<CallbackResult> {
  const result: CallbackResult = { ran: false, found: [] };
  const script = join(dir, name);
  if (existsSync(script) && executable(script)) {
    result.found.push(name);
    try {
      const proc = Bun.spawn([script], {
        cwd: dir,
        stdin: new Response(`${JSON.stringify(payload)}\n`),
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

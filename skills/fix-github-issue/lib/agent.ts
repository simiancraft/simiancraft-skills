/**
 * The agent process: rendering a prompt, spawning one headless CLI run to completion, killing it
 * when it overruns, streaming its output to a log, and reading the verdict back off disk.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from './context.ts';
import { APPRAISAL_FILE, LAST_MESSAGE_FILE, REVIEW_FILE, VERDICT_FILE } from './control-files.ts';
import { ENGINES, type Seat, seatLabel } from './engines.ts';
import { assertNotMainCheckout, inFlight } from './lane.ts';

export { APPRAISAL_FILE, CONTROL_FILES, LAST_MESSAGE_FILE, REVIEW_FILE, VERDICT_FILE } from './control-files.ts';

/** Live agent processes, so a signal can take them down rather than orphaning them. */
export const children = new Set<{ pid: number; kill: () => void }>();

/** How long an unattended agent may run before it is killed. A hung agent must not hold a lane. */
export const AGENT_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * How long the merge gate waits for a pull request's checks before parking instead of merging.
 * Size this to the repository's slowest required check; some builds legitimately take a long
 * time on a fresh head.
 */
export const CHECKS_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * Extra attempts an agent gets when the upstream refused for a reason that is not about the work.
 * A model at capacity is a different fact from a model that tried and failed: the first is worth
 * asking again, the second is not, and spending the lane on the first loses an issue for the run.
 * Bounded at one so a sustained outage costs each issue one wasted attempt, not an unbounded loop.
 */
export const AGENT_RETRIES = 1;
export const RETRY_BACKOFF_MS = 60 * 1000;

/**
 * Refusals that mean "ask again later" rather than "this work failed". Matched against the tail of
 * the agent's own log, and only ever consulted after a non-zero exit, so a phrase appearing in an
 * agent's prose costs at most one extra attempt on a run that had already failed.
 */
export const RETRYABLE_UPSTREAM = [
  'at capacity',
  'overloaded',
  'rate limit',
  'service unavailable',
  'try a different model',
];

export function retryableFailure(logPath: string): string | null {
  try {
    const tail = readFileSync(logPath, 'utf8').slice(-8000).toLowerCase();
    return RETRYABLE_UPSTREAM.find((phrase) => tail.includes(phrase)) ?? null;
  } catch {
    return null;
  }
}

/** Agents run under setsid where available, so a kill reaches their whole process group. */
export const SETSID = Bun.which('setsid');

/**
 * Takes an agent down with everything it started. A bare `proc.kill()` reaches only the CLI
 * itself, and a hung check command or dev server it spawned would outlive it, holding a port into
 * the next lane. With setsid the agent leads its own group, so `-pid` addresses the whole tree;
 * without it the group kill is a no-op ESRCH and the plain kill still lands.
 */
export function killAgent(proc: { pid: number; kill: () => void }): void {
  const signal = (sig: 'SIGTERM' | 'SIGKILL') => {
    try {
      process.kill(-proc.pid, sig);
    } catch {
      // no such group; fall through to the direct kill
    }
    try {
      process.kill(proc.pid, sig);
    } catch {
      // already gone
    }
  };
  signal('SIGTERM');
  // An agent that ignores SIGTERM must not keep holding its lane; escalate once, unref'd so the
  // timer never keeps the loop process alive on its own.
  setTimeout(() => signal('SIGKILL'), 10_000).unref();
}

/**
 * Fills a prompt template with the project vocabulary and the caller's own variables.
 *
 * Prompt directories are searched in order, so a driver's own prompts shadow the pipeline's. Every
 * prompt gets the project vocabulary, so a prompt never names a repository directly and porting the
 * pipeline does not mean rewriting prose in three files.
 */
export function renderPrompt(ctx: Context, file: string, vars: Record<string, string>): string {
  const found = ctx.promptsDirs.map((dir) => join(dir, file)).find((path) => existsSync(path));
  if (!found) throw new Error(`no prompt ${file} in ${ctx.promptsDirs.join(', ')}`);
  let text = readFileSync(found, 'utf8');
  const withProject: Record<string, string> = {
    PROJECT: ctx.project.name,
    REMOTE: ctx.project.remote,
    SHARED_SERVICES: ctx.project.sharedServices.join(', '),
    REPO: ctx.project.repo,
    BASE_BRANCH: ctx.project.baseBranch,
    EVIDENCE_BRANCH: ctx.project.evidenceBranch,
    CHECK_COMMAND: ctx.project.checkCommand,
    INSTALL_COMMAND: ctx.project.installCommand,
    CONVENTION_DOCS: ctx.project.conventionDocs.map((d) => `\`${d}\``).join(', '),
    SIZING_SCALE: ctx.project.sizingScale,
    MAIN_CHECKOUT: ctx.repoRoot,
    PORT_BASE: String(ctx.project.portBase),
    PORT_SPAN: String(ctx.project.portSpan),
    ...vars,
  };
  for (const [key, value] of Object.entries(withProject)) {
    text = text.replaceAll(`{{${key}}}`, value);
  }
  return text;
}

/**
 * Streams an agent's output into its log as it arrives, and returns the whole of it.
 *
 * Buffering until the process exits means a run that is killed leaves no log at all, which is
 * exactly the run whose output you need. Appending per chunk costs nothing and makes a killed run
 * diagnosable.
 */
export async function pump(stream: ReadableStream<Uint8Array> | null, logPath: string, prefix = ''): Promise<string> {
  if (!stream) return '';
  const decoder = new TextDecoder();
  let collected = '';

  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    collected += text;
    appendFileSync(logPath, prefix ? text.replace(/^/gm, prefix) : text);
  }
  return collected;
}

/** The argv that runs one prompt to completion, non-interactively, on the seat's engine. */
export function agentCommand(seat: Seat, cwd: string, prompt: string): string[] {
  return ENGINES[seat.engine].command(cwd, prompt, seat.model);
}

/**
 * Runs an agent, asking again when the upstream refused rather than the work failing.
 *
 * `onRetry` restores whatever state the next attempt needs; a worker passes a lane reset, while an
 * appraiser and a reviewer need nothing because neither leaves state a rerun would trip over.
 */
export async function runAgent(
  ctx: Context,
  role: string,
  issue: number,
  cwd: string,
  seat: Seat,
  prompt: string,
  onRetry?: () => void,
): Promise<{ logPath: string; exitCode: number }> {
  for (let attempt = 0; ; attempt++) {
    const run = await runAgentOnce(ctx, role, issue, cwd, seat, prompt);
    if (run.exitCode === 0 || attempt >= AGENT_RETRIES) return run;

    const reason = retryableFailure(run.logPath);
    if (!reason) return run;

    ctx.log(`  #${issue}  ${role} hit an upstream refusal ("${reason}"); retrying once in ${RETRY_BACKOFF_MS / 1000}s`);
    onRetry?.();
    await Bun.sleep(RETRY_BACKOFF_MS);
  }
}

/** Runs one headless agent process to completion, capturing its output into a per-issue log. */
export async function runAgentOnce(ctx: Context, role: string, issue: number, cwd: string, seat: Seat, prompt: string) {
  mkdirSync(ctx.runDir, { recursive: true });
  const logPath = join(ctx.runDir, `${issue}-${role}-${Date.now()}.log`);

  if (ctx.dryRun) {
    writeFileSync(logPath, prompt);
    ctx.log(`  DRY RUN  would run ${role} (${seatLabel(seat)}) on #${issue} (prompt written to ${logPath})`);
    return { logPath, exitCode: 0 };
  }

  assertNotMainCheckout(ctx, cwd, role);
  ctx.log(`  running ${role} on #${issue} via ${seatLabel(seat)} (log: ${logPath})`);

  // Clear the previous run's answer for THIS role before starting; a crashed agent must not hand
  // back its predecessor's verdict. Role-specific on purpose: clearing everything meant starting a
  // reviewer destroyed the worker verdict that findStranded resumes a crashed run from, so a crash
  // during review or merging stranded the pull request the resume path exists to save.
  const clearsByRole: Record<string, string[]> = {
    appraiser: [APPRAISAL_FILE, LAST_MESSAGE_FILE],
    worker: [VERDICT_FILE, LAST_MESSAGE_FILE],
    'worker-revise': [VERDICT_FILE, LAST_MESSAGE_FILE],
    reviewer: [REVIEW_FILE, LAST_MESSAGE_FILE],
  };
  for (const stale of clearsByRole[role] ?? [VERDICT_FILE, REVIEW_FILE, APPRAISAL_FILE, LAST_MESSAGE_FILE]) {
    rmSync(join(cwd, stale), { force: true });
  }

  // The worktree belongs to the agent until it exits. Nothing else may touch it in the meantime.
  const entry = inFlight.get(issue);
  if (entry) entry.busy = true;

  // ANTHROPIC_API_KEY takes precedence over the claude.ai login, so a key inherited from the shell
  // sends a Claude worker to an API account rather than the login the operator intended.
  const { ANTHROPIC_API_KEY: _inheritedKey, ...childEnv } = process.env;

  const argv = agentCommand(seat, cwd, prompt);
  const proc = Bun.spawn(SETSID ? [SETSID, ...argv] : argv, {
    cwd,
    env: childEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.add(proc);
  // Drain both pipes at once. Reading stdout to EOF first deadlocks a child that fills its stderr
  // pipe in the meantime: it blocks waiting for stderr space while the parent waits for stdout EOF.
  const timeout = setTimeout(() => {
    ctx.log(`  #${issue}  ${role} exceeded ${AGENT_TIMEOUT_MS / 60000} minutes; killing it`);
    killAgent(proc);
  }, AGENT_TIMEOUT_MS);

  writeFileSync(logPath, `${new Date().toISOString()} ${role} on #${issue} via ${seatLabel(seat)}\n`);
  const [output, errors] = await Promise.all([pump(proc.stdout, logPath), pump(proc.stderr, logPath, 'stderr: ')]);
  const exitCode = await proc.exited;
  clearTimeout(timeout);

  // `claude -p` prints its final message to stdout and writes no file, so without this the
  // fallback verdict channel would exist only for engines with an --output-last-message flag.
  const lastMessagePath = join(cwd, LAST_MESSAGE_FILE);
  if (!existsSync(lastMessagePath) && output.trim().length > 0) writeFileSync(lastMessagePath, output);

  children.delete(proc);
  appendFileSync(logPath, `\nexit code: ${exitCode}\n`);
  if (exitCode !== 0) ctx.log(`  #${issue}  ${role} exited ${exitCode}; its answer is not trusted`);

  if (entry) entry.busy = false;

  return { logPath, exitCode };
}

/** The last few meaningful lines of a log, so a failure explains itself without opening a file. */
export function logTail(logPath: string, lines = 4): string {
  if (!existsSync(logPath)) return 'no log written';
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(' | ');
}

/**
 * Reads the verdict the agent produced. Preferred channel is the file it was asked to write; the
 * fallback is the last message, since an agent that answers in chat rather than on disk has still
 * done the thinking and throwing that away costs a whole run.
 */
export function readResult<T>(cwd: string, file: string): T | null {
  const fromFile = parseJsonFile<T>(join(cwd, file));
  if (fromFile) return fromFile;

  const lastMessage = join(cwd, LAST_MESSAGE_FILE);
  if (!existsSync(lastMessage)) return null;

  const text = readFileSync(lastMessage, 'utf8');
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text);
  const bare = /\{[\s\S]*\}/.exec(text);
  for (const candidate of [fenced?.[1], bare?.[0]]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // fall through to the next candidate
    }
  }
  return null;
}

export function parseJsonFile<T>(resultPath: string): T | null {
  if (!existsSync(resultPath)) return null;
  try {
    return JSON.parse(readFileSync(resultPath, 'utf8')) as T;
  } catch {
    return null;
  }
}

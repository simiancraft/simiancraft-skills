/**
 * The agent process: rendering a prompt, spawning one headless CLI run to completion, killing it
 * when it overruns, streaming its output to a log, and reading the verdict back off disk.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from './context.ts';
import { APPRAISAL_FILE, CARVING_FILE, CONFIRMATION_FILE, LAST_MESSAGE_FILE, REVIEW_FILE, VERDICT_FILE } from './control-files.ts';
import { ENGINES, isFixture, type Seat, seatLabel } from './engines.ts';
import { LeaseLostError, leaseLost } from '../../carve-github-issue/lib/claims.ts';
import { assertNotMainCheckout, inFlight } from './lane.ts';
import { beginStop, isStopping, RunStopping, stoppableSleep } from './shell.ts';

export { APPRAISAL_FILE, CONTROL_FILES, LAST_MESSAGE_FILE, REVIEW_FILE, VERDICT_FILE } from './control-files.ts';

/** Live agent processes, so a signal can take them down rather than orphaning them. */
export const children = new Set<{ pid: number; kill: () => void; exitCode: number | null; issue?: number; repo?: string }>();

/** Stops every agent this process is running on one issue: its lease is gone, so its work must stop with it. */
export function killAgentsOn(repo: string, issue: number): number {
  let killed = 0;
  for (const proc of children) {
    if (proc.issue !== issue || proc.repo !== repo) continue;
    killAgent(proc);
    killed += 1;
  }
  return killed;
}

/** How long an unattended agent may run before it is killed. A hung agent must not hold a lane. */
export const AGENT_TIMEOUT_MS = 45 * 60 * 1000;
/** The cap in force, held in an object so a test can shorten it; nothing else changes it. */
export const agentTimeout = { ms: AGENT_TIMEOUT_MS };
/** The exit code a run killed at the cap is given, after the shell's `timeout`: never 0, whatever the engine said on its way down. */
export const TIMED_OUT_EXIT = 124;

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
 * Takes every running agent down and waits for it, so a driver's signal handler can release its
 * locks only once nothing it started is still running with its approval gates bypassed. SIGTERM
 * first; whatever is still alive after `graceMs` gets SIGKILL; whatever survives that is reported.
 */
export async function shutdownAgents(graceMs = 10_000): Promise<number> {
  // First, and before anything is awaited: the kills below must not be settled as failures.
  beginStop();
  const running = [...children];
  if (running.length === 0) return 0;
  for (const proc of running) killAgent(proc);
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && running.some((proc) => proc.exitCode === null)) await Bun.sleep(200);
  for (const proc of running) {
    if (proc.exitCode !== null) continue;
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      // no group
    }
    try {
      process.kill(proc.pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  await Bun.sleep(200);
  return running.filter((proc) => proc.exitCode === null).length;
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
  return renderTemplate(ctx, readFileSync(found, 'utf8'), vars);
}

/** The same rendering for prompt text that did not come from a shipped file: a producer's callback prompt, say. */
export function renderTemplate(ctx: Context, template: string, vars: Record<string, string>): string {
  let text = template;
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
  // Inserted values are data. A value carrying `{{...}}` (an issue title, say) must not be
  // re-expanded by a later placeholder pass, so the braces are broken apart on the way in.
  const inert = (value: string) => value.replaceAll('{{', '{ {').replaceAll('}}', '} }');
  for (const [key, value] of Object.entries(withProject)) {
    text = text.replaceAll(`{{${key}}}`, inert(value));
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
): Promise<AgentRun> {
  for (let attempt = 0; ; attempt++) {
    const run = await runAgentOnce(ctx, role, issue, cwd, seat, prompt);
    // A run killed at the cap is not asked again: it spent the cap, and the lane has waited that long.
    if (run.exitCode === 0 || run.timedOut || attempt >= AGENT_RETRIES) return run;

    const reason = retryableFailure(run.logPath);
    if (!reason) return run;

    ctx.log(`  #${issue}  ${role} hit an upstream refusal ("${reason}"); retrying once in ${RETRY_BACKOFF_MS / 1000}s`);
    onRetry?.();
    await stoppableSleep(RETRY_BACKOFF_MS);
  }
}

/**
 * What a seat's run came to. `notRun` marks a seat a dry run skipped: exit 0 there means nothing
 * ran, not that an agent succeeded, and no answer file exists to read. `timedOut` marks a run the
 * driver killed at the cap: an engine can exit 0 on its way down with an answer file half meant,
 * so its exit code is never 0 here and no seat reads what it left.
 */
export type AgentRun = { logPath: string; exitCode: number; notRun?: true; timedOut?: true };

/** Runs one headless agent process to completion, capturing its output into a per-issue log. */
export async function runAgentOnce(ctx: Context, role: string, issue: number, cwd: string, seat: Seat, prompt: string): Promise<AgentRun> {
  if (isStopping()) throw new RunStopping(`the run is stopping; ${role} not started on #${issue}`);
  // A lease can run out where no agent is running to be killed: in the backoff before a retry.
  // An agent started then would push and open pull requests on an issue another run may hold.
  if (leaseLost(ctx, issue)) throw new LeaseLostError(`this run lost its lease on #${issue}; ${role} not started`);
  mkdirSync(ctx.runDir, { recursive: true });
  const logPath = join(ctx.runDir, `${issue}-${role}-${Date.now()}.log`);

  // A fixture seat runs in a dry run: it copies a file and mutates nothing, and a gate that drives a
  // whole flow in a dry run needs its answers.
  if (ctx.dryRun && !isFixture(seat)) {
    writeFileSync(logPath, prompt);
    ctx.log(`  DRY RUN  would run ${role} (${seatLabel(seat)}) on #${issue} (prompt written to ${logPath})`);
    return { logPath, exitCode: 0, notRun: true };
  }
  mkdirSync(cwd, { recursive: true });

  assertNotMainCheckout(ctx, cwd, role);
  ctx.log(`  running ${role} on #${issue} via ${seatLabel(seat)} (log: ${logPath})`);

  // Clear the previous run's answer for THIS role before starting; a crashed agent must not hand
  // back its predecessor's verdict. Role-specific on purpose: clearing everything meant starting a
  // reviewer destroyed the worker verdict that findStranded resumes a crashed run from, so a crash
  // during review or merging stranded the pull request the resume path exists to save.
  const clearsByRole: Record<string, string[]> = {
    appraiser: [APPRAISAL_FILE, LAST_MESSAGE_FILE],
    confirmer: [CONFIRMATION_FILE, LAST_MESSAGE_FILE],
    worker: [VERDICT_FILE, LAST_MESSAGE_FILE],
    'worker-revise': [VERDICT_FILE, LAST_MESSAGE_FILE],
    reviewer: [REVIEW_FILE, LAST_MESSAGE_FILE],
    carver: [CARVING_FILE, LAST_MESSAGE_FILE],
    callback: ['loop-callback.json', LAST_MESSAGE_FILE],
  };
  // A role the table does not name (a reproof, a diagnosis) clears every answer file there is.
  const answers = clearsByRole[role] ?? [VERDICT_FILE, REVIEW_FILE, APPRAISAL_FILE, CONFIRMATION_FILE, CARVING_FILE, LAST_MESSAGE_FILE];
  for (const stale of answers) rmSync(join(cwd, stale), { force: true });

  // The worktree belongs to the agent until it exits. Nothing else may touch it in the meantime.
  const entry = inFlight.get(issue);
  if (entry) entry.busy = true;

  // ANTHROPIC_API_KEY takes precedence over the claude.ai login, so a key inherited from the shell
  // sends a Claude worker to an API account rather than the login the operator intended.
  // LOOP_ROLE tells a fixture which control file the seat writes; a real engine ignores it.
  const { ANTHROPIC_API_KEY: _inheritedKey, ...inherited } = process.env;
  const childEnv = { ...inherited, LOOP_ROLE: role };

  const argv = agentCommand(seat, cwd, prompt);
  const proc = Bun.spawn(SETSID ? [SETSID, ...argv] : argv, {
    cwd,
    env: childEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.add(Object.assign(proc, { issue, repo: ctx.project.repo }));
  // Drain both pipes at once. Reading stdout to EOF first deadlocks a child that fills its stderr
  // pipe in the meantime: it blocks waiting for stderr space while the parent waits for stdout EOF.
  let timedOut = false;
  const timeout = setTimeout(() => {
    // An agent that already exited answered in time; only something it left running still holds
    // its output open. That is taken down with the group, and the agent's own exit code stands.
    if (proc.exitCode === null) {
      timedOut = true;
      ctx.log(`  #${issue}  ${role} exceeded ${agentTimeout.ms / 60000} minutes; killing it`);
    } else {
      ctx.log(`  #${issue}  ${role} exited ${proc.exitCode} but left a process holding its output past ${agentTimeout.ms / 60000} minutes; killing that`);
    }
    killAgent(proc);
  }, agentTimeout.ms);

  writeFileSync(logPath, `${new Date().toISOString()} ${role} on #${issue} via ${seatLabel(seat)}\n`);
  const [output, errors] = await Promise.all([pump(proc.stdout, logPath), pump(proc.stderr, logPath, 'stderr: ')]);
  const exited = await proc.exited;
  clearTimeout(timeout);
  // The driver killed it, so whatever code the engine chose on its way down says nothing: every
  // seat distrusts a non-zero exit, and that is the branch a killed run belongs in.
  const exitCode = timedOut && exited === 0 ? TIMED_OUT_EXIT : exited;

  // `claude -p` prints its final message to stdout and writes no file, so without this the
  // fallback verdict channel would exist only for engines with an --output-last-message flag.
  const lastMessagePath = join(cwd, LAST_MESSAGE_FILE);
  if (!existsSync(lastMessagePath) && output.trim().length > 0) writeFileSync(lastMessagePath, output);

  children.delete(proc);
  appendFileSync(logPath, timedOut ? `\nkilled by the driver after ${agentTimeout.ms / 60000} minutes (the engine exited ${exited}); exit code: ${exitCode}\n` : `\nexit code: ${exitCode}\n`);
  if (entry) entry.busy = false;
  // An agent that ended under a stop was stopped: that is no answer and no failure, so nothing
  // downstream may count it, queue it, or trust what it left behind.
  if (isStopping()) {
    ctx.log(`  #${issue}  ${role} was stopped with the run (exit ${exitCode}); nothing is settled from it`);
    throw new RunStopping(`the run is stopping; ${role} on #${issue} was stopped, not answered`);
  }
  if (timedOut) {
    // Every seat distrusts the exit code, but the resume path reads a verdict file from a lane a
    // dead run left behind, so what a killed agent wrote does not stay on disk to be found later.
    for (const left of answers) rmSync(join(cwd, left), { force: true });
    ctx.log(`  #${issue}  ${role} timed out at ${agentTimeout.ms / 60000} minutes and was killed; its answer is not trusted`);
    return { logPath, exitCode, timedOut: true };
  }
  if (exitCode !== 0) ctx.log(`  #${issue}  ${role} exited ${exitCode}; its answer is not trusted`);

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

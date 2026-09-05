#!/usr/bin/env bun
/**
 * Follow a run without composing shell. From inside an adopting repository:
 *
 *   bun run <skill-dir>/watch.ts                 # events from the current run; exits when the driver exits
 *   bun run <skill-dir>/watch.ts --all           # every line, not only events
 *   bun run <skill-dir>/watch.ts --wait          # print nothing until the run ends, then its terminal lines
 *   bun run <skill-dir>/watch.ts --floor <dir>   # follow a standalone walker on <dir> instead of the loop
 *
 * The loop tees its console to `<worktreeRoot>/runs/driver.log` and its walker child to
 * `runs/floor.log`; a standalone walker tees to `<floor>/walk.log`. This script polls those files
 * in-process and reports the pid it found in the lock, so an agent watching a run needs one
 * command and no `tail`, `kill`, `pgrep`, or subshell. It reads and never writes.
 *
 * With no lock, or a lock whose pid is gone, it prints what the last run left and exits 0; a run
 * that is still alive when the watcher is interrupted is untouched.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { invokeRootFrom, loadProjectConfig, PIPELINE_DEFAULTS, repoRootFrom } from '../fix-github-issue/lib/config.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const ALL = flag('all');
const WAIT = flag('wait');
const FLOOR = opt('floor');

/** The lines an operator acts on; everything else is agent chatter echoed through. */
const EVENT = new RegExp(
  [
    'run pid \\d+ started',
    'walker started',
    'running (appraiser|worker|reviewer|walker) on',
    'appraisal:',
    'verdict:',
    'review:',
    'review round',
    'merge PR',
    'merged',
    'park',
    'DLQ',
    'needs-(decision|human)',
    'already-fixed',
    'obsolete',
    'closed',
    'worker failed',
    'reviewer wrote no verdict',
    'exceeded \\d+ minutes',
    'refusing',
    'did not report',
    'conflicts with',
    'uncommitted changes',
    'Cannot find',
    'SyntaxError',
    'line-switch',
    'paused',
    'liveness: down',
    ': (present|intact|absent|not-checkable|not-yet-deployed|unverified) by',
    'incident',
    'Walking \\d+',
    'nothing on the floor',
    'received SIG',
    '^done$',
    'no sized candidates',
    'nothing to appraise',
  ].join('|'),
);

/** A terminal line is one that decides an issue's fate or ends the run; `--wait` prints only these. */
const TERMINAL =
  /merge PR|merged|park|DLQ|needs-(decision|human)|already-fixed|obsolete|worker failed|reviewer wrote no verdict|exceeded \d+ minutes|refusing|conflicts with|incident|liveness: down|received SIG|^done$|no sized candidates/;

type Followed = { path: string; offset: number; label: string; inode?: number };

function readLockPid(lockPath: string): number | null {
  if (!existsSync(lockPath)) return null;
  const pid = Number(readFileSync(lockPath, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the new complete lines since the last call, leaving a partial trailing line for next
 * time. A replaced file (different inode) or a shrunken one restarts from zero; a file that
 * vanishes between the stat and the read is simply retried on the next poll.
 */
function drain(file: Followed): string[] {
  let size: number;
  let inode: number;
  try {
    const stat = statSync(file.path);
    size = stat.size;
    inode = stat.ino;
  } catch {
    return [];
  }
  if (file.inode !== undefined && file.inode !== inode) file.offset = 0; // rotated or replaced
  file.inode = inode;
  if (size < file.offset) file.offset = 0; // truncated; start over
  if (size === file.offset) return [];
  const buffer = Buffer.alloc(size - file.offset);
  let text: string;
  try {
    const fd = openSync(file.path, 'r');
    try {
      readSync(fd, buffer, 0, buffer.length, file.offset);
    } finally {
      closeSync(fd);
    }
    text = buffer.toString('utf8');
  } catch {
    return [];
  }
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) return [];
  file.offset += Buffer.byteLength(text.slice(0, lastNewline + 1));
  return text.slice(0, lastNewline).split('\n');
}

/** Start at the header of the most recent run in the file, so an old run's lines are not replayed. */
function seekToLastRun(file: Followed, header: RegExp): void {
  if (!existsSync(file.path)) return;
  const text = readFileSync(file.path, 'utf8');
  let at = -1;
  for (const match of text.matchAll(header)) at = match.index ?? at;
  file.offset = at < 0 ? 0 : Buffer.byteLength(text.slice(0, at));
}

async function main(): Promise<void> {
  const repoRoot = repoRootFrom(process.cwd());
  const invokeRoot = invokeRootFrom(process.cwd(), repoRoot);
  const { project } = await loadProjectConfig({
    invokeRoot,
    repoRoot,
    fileName: 'burn-down-github-issues.config.ts',
    defaults: PIPELINE_DEFAULTS,
    positiveIntegers: ['maxReviewRounds'],
    help: ['watch.ts reads the same config as loop.ts to find the runs directory.'],
  });

  let lockPath: string;
  let files: Followed[];
  if (FLOOR) {
    const dir = resolve(FLOOR);
    lockPath = join(dir, 'floor.lock');
    files = [{ path: join(dir, 'walk.log'), offset: 0, label: 'walk' }];
    seekToLastRun(files[0], /^.*walk-the-floor$/gm);
  } else {
    const runDir = resolve(repoRoot, project.worktreeRoot, 'runs');
    lockPath = join(runDir, 'loop.lock');
    files = [
      { path: join(runDir, 'driver.log'), offset: 0, label: 'loop' },
      { path: join(runDir, 'floor.log'), offset: 0, label: 'floor' },
    ];
    // The driver's header is timestamped like every other log line.
    seekToLastRun(files[0], /^\d{2}:\d{2}:\d{2}  run pid \d+ started/gm);
    // The floor log has no per-run header; show only what arrives from now on.
    if (existsSync(files[1].path)) files[1].offset = statSync(files[1].path).size;
  }

  const pid = readLockPid(lockPath);
  const held: string[] = [];
  const emit = (label: string, line: string) => {
    const text = files.length > 1 ? `[${label}] ${line}` : line;
    if (WAIT) {
      if (TERMINAL.test(line)) held.push(text);
      return;
    }
    if (ALL || EVENT.test(line)) console.log(text);
  };

  const pump = () => {
    for (const file of files) for (const line of drain(file)) if (line.trim() !== '') emit(file.label, line);
  };

  if (pid === null) {
    console.log(`no running driver (${lockPath} absent or its pid is gone); showing what the last run left`);
    pump();
    if (WAIT) for (const line of held) console.log(line);
    return;
  }

  console.log(`following pid ${pid} via ${lockPath}`);
  pump();
  while (alive(pid)) {
    await Bun.sleep(1000);
    pump();
  }
  await Bun.sleep(1500); // let the final lines land after the process exits
  pump();
  if (WAIT) for (const line of held) console.log(line);
  console.log(`driver ${pid} exited`);
}

await main();

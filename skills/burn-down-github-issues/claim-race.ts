#!/usr/bin/env bun
/**
 * Prove the claim lock on the real tracker: several contenders claim one issue at the same
 * instant, and exactly one may win. From inside an adopting repository:
 *
 *   bun run <skill-dir>/claim-race.ts --issue <n> --contenders 3 --rounds 3
 *
 * Each contender is its own process with its own run id, exactly as two loops on two machines
 * would be. All are released at one wall-clock instant, each runs the real `claim()` (the comment,
 * the label, the re-read, the tie-break by comment id), reports what it got, holds a won claim
 * for a moment, and releases it. The parent judges every round: one winner, every other
 * contender `busy`, and afterwards no unreleased claim on the thread. Use an issue that carries
 * `loop/skip` and exists for this, since the thread collects claim and unclaim markers.
 *
 * This is the experiment the fake-tracker unit tests cannot run: GitHub has no compare-and-swap,
 * and the announce-then-reread protocol is only as good as the window between two runs' writes.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claim, trackerIo } from '../carve-github-issue/lib/claims.ts';
import { readTree } from '../carve-github-issue/lib/tree.ts';
import { invokeRootFrom, loadProjectConfig, PIPELINE_DEFAULTS, repoRootFrom } from '../fix-github-issue/lib/config.ts';
import { createContext } from '../fix-github-issue/lib/context.ts';
import { parseSeat } from '../fix-github-issue/lib/engines.ts';

const HERE = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (name: string, fallback: number) => {
  const raw = opt(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--${name} expects a positive integer, got '${raw}'`);
    process.exit(1);
  }
  return n;
};

const ISSUE = num('issue', 0);
if (ISSUE === 0) {
  console.error('--issue <n> is required');
  process.exit(1);
}
const CONTEND = args.includes('--contend');
const START = Number(opt('start') ?? 0);

const REPO_ROOT = repoRootFrom(process.cwd());
const INVOKE_ROOT = invokeRootFrom(process.cwd(), REPO_ROOT);
const CONFIG = await loadProjectConfig({
  invokeRoot: INVOKE_ROOT,
  repoRoot: REPO_ROOT,
  fileName: 'burn-down-github-issues.config.ts',
  defaults: PIPELINE_DEFAULTS,
  positiveIntegers: [],
  help: ['claim-race.ts reads the same config the loop does'],
});

const seat = parseSeat('codex', 'seat');
const ctx = createContext({
  project: CONFIG.project,
  knobs: PIPELINE_DEFAULTS,
  seats: { worker: seat, reviewer: seat },
  repoRoot: REPO_ROOT,
  invokeRoot: INVOKE_ROOT,
  promptsDirs: [],
  dryRun: false,
  log: CONTEND ? () => {} : (m) => console.log(m),
  step: () => {},
});

type Report = { runId: string; result: 'won' | 'busy'; commentId: number | null; claimedAt: number; error?: string };

if (CONTEND) {
  // A contender: wait for the shared instant, claim, report on stdout as one JSON line, release.
  const wait = START - Date.now();
  if (wait > 0) await Bun.sleep(wait);
  const io = trackerIo(ctx);
  let report: Report;
  try {
    const handle = await claim(ctx, io, ISSUE, 'working');
    const claimedAt = Date.now();
    if (handle === 'busy') {
      report = { runId: ctx.runId, result: 'busy', commentId: null, claimedAt };
    } else {
      report = { runId: ctx.runId, result: 'won', commentId: handle.commentId, claimedAt };
      await Bun.sleep(3000);
      handle.release();
    }
  } catch (error) {
    report = { runId: ctx.runId, result: 'busy', commentId: null, claimedAt: Date.now(), error: (error as Error).message };
  }
  console.log(JSON.stringify(report));
  process.exit(0);
}

const CONTENDERS = num('contenders', 2);
const ROUNDS = num('rounds', 1);
let failures = 0;

console.log(`claim race on #${ISSUE}: ${CONTENDERS} contender(s), ${ROUNDS} round(s), repo ${CONFIG.project.repo}`);
for (let round = 1; round <= ROUNDS; round++) {
  const start = Date.now() + 4000;
  const children = Array.from({ length: CONTENDERS }, () =>
    Bun.spawn(['bun', 'run', HERE, '--issue', String(ISSUE), '--contend', '--start', String(start)], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );
  const outputs = await Promise.all(children.map(async (child) => ({ out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text(), code: await child.exited })));
  const reports: Report[] = [];
  for (const { out, err, code } of outputs) {
    const line = out.trim().split('\n').filter(Boolean).pop();
    try {
      reports.push(JSON.parse(line ?? '') as Report);
    } catch {
      reports.push({ runId: '?', result: 'busy', commentId: null, claimedAt: 0, error: `no report (exit ${code}): ${err.trim().split('\n').pop() ?? ''}` });
    }
  }
  const winners = reports.filter((r) => r.result === 'won');
  const errors = reports.filter((r) => r.error);
  const io = trackerIo(ctx);
  const tree = readTree(ctx, ISSUE, io);
  const unreleased = tree.claims.filter((c) => !c.released && Date.parse(c.expires) > Date.now());
  const ok = winners.length === 1 && errors.length === 0 && unreleased.length === 0;
  if (!ok) failures++;
  console.log(`round ${round}: ${ok ? 'PASS' : 'FAIL'}  winners ${winners.length}/${CONTENDERS}  errors ${errors.length}  unreleased claims after ${unreleased.length}`);
  for (const r of reports.sort((a, b) => a.claimedAt - b.claimedAt)) {
    const offset = r.claimedAt ? `+${r.claimedAt - start}ms` : '';
    console.log(`  ${r.result.padEnd(4)} ${r.runId} ${offset}${r.commentId ? ` comment ${r.commentId}` : ''}${r.error ? `  ${r.error}` : ''}`);
  }
}
console.log(failures === 0 ? `all ${ROUNDS} round(s) passed` : `${failures} round(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);

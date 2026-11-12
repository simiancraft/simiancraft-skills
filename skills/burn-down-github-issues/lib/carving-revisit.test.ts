import '../../../test/no-real-gh.preload.ts';
import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CARVE_DEFAULTS } from '../../carve-github-issue/lib/carve.ts';
import { FakeTracker, fakeIssue } from '../../carve-github-issue/lib/fake-tracker.ts';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import { Carving, MAX_REVISITS_PER_RUN } from './carving.ts';

const scratch = mkdtempSync(join(tmpdir(), 'carving-revisit-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const bot = 'loop-bot';

function carving(io: FakeTracker, lines: string[] = []) {
  const ctx = {
    botLogin: bot, runId: 'host-1-1', dryRun: false, dryRunLog: [], io,
    repoRoot: scratch, invokeRoot: scratch, runDir: join(scratch, 'runs'), promptsDirs: [],
    project: { repo: 'o/r', baseBranch: 'main', remote: 'origin', worktreeRoot: '../wt' },
    knobs: { checks: 'required', checksTimeoutMinutes: 10, maxWorkerAttempts: 3, pointScale: [1, 2, 3, 5, 8] },
    seats: { worker: { engine: 'fixture' }, reviewer: { engine: 'fixture2' } }, log: () => {}, step: () => {},
  } as unknown as Context;
  return new Carving({
    ctx,
    knobs: { ...CARVE_DEFAULTS, ceiling: 2, callbacksDir: join(scratch, 'absent'), seats: { carver: { engine: 'fixture' }, confirmer: { engine: 'fixture2' } } },
    appraisal: { seats: { appraiser: { engine: 'fixture' }, confirmer: { engine: 'fixture2' } }, confirmCloses: true, skipLabels: [], maxAppraiseAttempts: 1, sizeCallbackTimeoutMinutes: 1 },
    only: null,
    ageDays: 100,
    mark: () => {},
    log: (line) => lines.push(line),
  });
}

/** A trunk #10 with two open children; the knife itself is replaced by a counter. */
function trunk() {
  return new FakeTracker(bot, [
    fakeIssue(10, { labels: [{ name: 'size: 8' }, { name: 'loop/carved' }], subIssues: [11, 12] }),
    fakeIssue(11, { parentNumber: 10, labels: [{ name: 'size: 3' }] }),
    fakeIssue(12, { parentNumber: 10, labels: [{ name: 'size: 3' }] }),
  ]);
}

// biome-ignore lint/suspicious/noExplicitAny: the knife's entry is private; the tests count its calls.
const knife = (during: () => Promise<void> = async () => {}) => spyOn(Carving.prototype as any, 'visitTree').mockImplementation(during);
afterEach(() => (Carving.prototype as unknown as { visitTree: { mockRestore?: () => void } }).visitTree.mockRestore?.());

describe('revisiting a trunk within one run', () => {
  it('does not visit again when nothing on the tree moved', async () => {
    const io = trunk();
    const lines: string[] = [];
    const visits = knife();
    const run = carving(io, lines);
    await run.revisit(10, 'the sweep');
    await run.revisit(10, '#11 commented');
    expect(visits).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => l.includes('unchanged since its last revisit this run'))).toBe(true);
  });

  it('visits again when a child closed after the last visit, in the same run', async () => {
    const io = trunk();
    const visits = knife();
    const run = carving(io);
    await run.revisit(10, 'the sweep');
    io.close(11);
    await run.revisit(10, '#11 closed');
    io.close(12);
    await run.revisit(10, '#12 closed');
    expect(visits).toHaveBeenCalledTimes(3);
  });

  it('runs two revisits of one trunk one after the other, never together', async () => {
    const io = trunk();
    let active = 0;
    let most = 0;
    knife(async () => {
      active++;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    });
    const run = carving(io);
    io.close(11);
    const first = run.revisit(10, '#11 closed');
    io.close(12);
    const second = run.revisit(10, '#12 closed');
    await Promise.all([first, second]);
    expect(most).toBe(1);
  });

  it('stops at the per-run cap however often the tree moves', async () => {
    const io = trunk();
    const lines: string[] = [];
    const visits = knife();
    const run = carving(io, lines);
    for (let i = 0; i <= MAX_REVISITS_PER_RUN; i++) {
      io.comment(10, 'person', `note ${i}`);
      await run.revisit(10, `a person commented (${i})`);
    }
    expect(visits).toHaveBeenCalledTimes(MAX_REVISITS_PER_RUN);
    expect(lines.some((l) => l.includes(`revisited ${MAX_REVISITS_PER_RUN} times this run`))).toBe(true);
  });

  it('finishes when the visit itself closes a child of the trunk, and serves that close with one more pass', async () => {
    const io = trunk();
    let calls = 0;
    let run: Carving;
    knife(async () => {
      calls++;
      if (calls === 1) {
        // The knife closes a superseded child; its close hook asks for this same trunk.
        io.close(12);
        await run.revisit(10, '#12 closed');
      }
    });
    run = carving(io);
    const done = run.revisit(10, 'the sweep');
    const outcome = await Promise.race([done.then(() => 'done'), new Promise((resolve) => setTimeout(() => resolve('stuck'), 1000))]);
    expect(outcome).toBe('done');
    expect(calls).toBe(2);
  });

  it('visits again when a child closed during the visit, though the tracker it left shows the close', async () => {
    const io = trunk();
    let calls = 0;
    knife(async () => {
      calls++;
      if (calls === 1) io.close(11); // another lane's merge, during the knife's turn
    });
    const run = carving(io);
    await run.revisit(10, 'the sweep');
    await run.revisit(10, '#11 closed'); // that lane's close hook, after the visit
    expect(calls).toBe(2);
  });

  it('still serves a close that arrived during a visit that threw, and reports the throw', async () => {
    const io = trunk();
    let calls = 0;
    let run: Carving;
    knife(async () => {
      calls++;
      if (calls === 1) {
        io.close(11);
        io.close(12);
        await run.revisit(10, '#12 closed, the last child'); // another lane's close hook, during the visit
        throw new Error('knife failed');
      }
    });
    run = carving(io);
    await expect(run.revisit(10, 'the sweep')).rejects.toThrow('knife failed');
    expect(calls).toBe(2);
  });

  it('retries the same facts after a visit that threw', async () => {
    const io = trunk();
    let calls = 0;
    knife(async () => {
      calls++;
      if (calls === 1) throw new Error('knife failed');
    });
    const run = carving(io);
    await expect(run.revisit(10, 'the sweep')).rejects.toThrow('knife failed');
    await run.revisit(10, 'the next trigger, nothing new');
    expect(calls).toBe(2);
  });

  it('never refuses the visit after the last child closes, however many came before', async () => {
    const io = trunk();
    const visits = knife();
    const run = carving(io);
    for (let i = 0; i <= MAX_REVISITS_PER_RUN; i++) {
      io.comment(10, 'person', `note ${i}`);
      await run.revisit(10, `a person commented (${i})`);
    }
    expect(visits).toHaveBeenCalledTimes(MAX_REVISITS_PER_RUN);
    io.close(11);
    io.close(12);
    await run.revisit(10, '#12 closed, the last child');
    expect(visits).toHaveBeenCalledTimes(MAX_REVISITS_PER_RUN + 1);
  });

  it('still visits after a visit that threw, and the throw reaches the caller', async () => {
    const io = trunk();
    let calls = 0;
    knife(async () => {
      calls++;
      if (calls === 1) throw new Error('knife failed');
    });
    const run = carving(io);
    await expect(run.revisit(10, 'the sweep')).rejects.toThrow('knife failed');
    io.close(11);
    await run.revisit(10, '#11 closed');
    expect(calls).toBe(2);
  });
});

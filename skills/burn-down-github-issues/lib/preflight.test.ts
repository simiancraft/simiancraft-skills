import '../../../test/no-real-gh.preload.ts';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '../../fix-github-issue/lib/context.ts';
import { reportPreflight } from './preflight.ts';

function fixture(protection: string[] | Error, requiredChecks: string[] = [], checks = 'required') {
  const messages: string[] = [];
  const reads: string[][] = [];
  const ctx = {
    project: { repo: 'fixture/project', baseBranch: 'release' },
    knobs: { requiredChecks, checks },
    dryRun: true,
    log: (message: string) => messages.push(message),
  } as unknown as Context;
  const io = {
    say: ctx.log,
    read: (argv: string[]) => {
      reads.push(argv);
      expect(argv).toEqual(['gh', 'api', 'repos/fixture/project/branches/release/protection/required_status_checks', '--jq', '[.contexts[]?, .checks[]?.context] | unique']);
      if (protection instanceof Error) throw protection;
      return JSON.stringify(protection);
    },
  };
  return { ctx, io, messages, reads };
}

describe('landing preflight', () => {
  for (const [name, protection, configured, expected] of [
    ['protection only', ['build'], [], ['build']],
    ['config only', [], ['test'], ['test']],
    ['overlapping union', ['build', 'test', 'build'], ['test', 'lint', 'lint'], ['test', 'lint', 'build']],
  ] as const) {
    it(name, () => {
      const f = fixture([...protection], [...configured]);
      reportPreflight(f.ctx, f.io);
      expect(f.messages[1]).toEndWith(JSON.stringify(expected));
      expect(f.messages).toHaveLength(2);
      expect(f.reads).toHaveLength(1);
    });
  }

  it('names the empty list and both remedies in required mode', () => {
    const f = fixture([]);
    reportPreflight(f.ctx, f.io);
    expect(f.messages[1]).toEndWith('[]');
    expect(f.messages[2]).toContain('required landing check list is empty');
    expect(f.messages[2]).toContain('Configure requiredChecks or required status checks on base release');
  });

  it('uses the landing fallback when protection is unavailable', () => {
    const f = fixture(new Error('no protection or no read access'), ['build']);
    reportPreflight(f.ctx, f.io);
    expect(f.messages[1]).toEndWith('["build"]');
  });

  it('reports none mode without the required-mode warning', () => {
    const f = fixture([], [], 'none');
    reportPreflight(f.ctx, f.io);
    expect(f.messages.join('\n')).not.toContain('WARNING');
    expect(f.messages[2]).toContain('gate is disabled');
  });
});

// Exercise the command's actual main body with explicit boundaries, as in pressure.test.ts.
// Unknown dependencies fail rather than reaching a live tracker or starting a process.
async function dryRunMain(f: ReturnType<typeof fixture>, backlog: unknown[]) {
  const source = readFileSync(new URL('../loop.ts', import.meta.url), 'utf8');
  const start = source.indexOf('async function main():');
  const body = source.slice(start, source.indexOf('\n}', start) + 2);
  const noop = () => {};
  const seat = (engine: string) => ({ engine });
  const deps = {
    CLOSURE_PROBE: null, teeConsole: noop, join, RUN_DIR: '.', step: noop,
    PROJECT: { name: 'fixture' }, BASE: 'release', CONFIG: { concurrency: 1 },
    MAX_POINTS: 2, SEATS: { appraiser: seat('a'), confirmer: seat('b'), worker: seat('a'), reviewer: seat('b'), carver: seat('a'), carveConfirmer: seat('b') },
    seatLabel: (s: { engine: string }) => s.engine, DRY_RUN: true, ctx: f.ctx,
    log: f.io.say, reportPreflight: (ctx: Context) => reportPreflight(ctx, f.io),
    claimLock: () => noop, startPulse: () => noop, SILENT: true, PULSE_MINUTES: 5,
    process: { pid: 1, on: noop }, installStopHandler: noop, FLOOR_MODE: null,
    FLOOR: null, BOARD: null, ensureLabels: noop, CARVING: { sweep: noop },
    allIssues: () => backlog, placeBacklog: async (issues: unknown[]) => issues,
    SKIP_APPRAISAL: true, LIMIT: 2, selectCandidates: () => [], pulse: noop,
    ADMISSION: { start: noop, admit: async () => [] },
  };
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(body);
  await new Function(...Object.keys(deps), `${js}\nreturn main();`)(...Object.values(deps));
}

it('the command reports before selection, including an empty backlog, without mutations or seats', async () => {
  for (const backlog of [[], [{ number: 1 }]]) {
    const f = fixture(['build']);
    await dryRunMain(f, backlog);
    expect(f.reads).toHaveLength(1);
    expect(f.messages.some((line) => line.endsWith('["build"]'))).toBe(true);
    expect(f.messages.some((line) => line.startsWith('nothing in Ready'))).toBe(true);
  }
});

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS = join(import.meta.dir, '..', '..');
const DRIVERS = ['burn-down-github-issues/loop.ts', 'fix-github-issue/fix.ts', 'appraise-github-issues/appraise.ts', 'carve-github-issue/carve.ts', 'walk-the-floor/walk.ts'];

describe('every driver guards its arguments before it does anything', () => {
  for (const driver of DRIVERS) {
    const path = join(SKILLS, driver);
    const source = readFileSync(path, 'utf8');
    const usage = /export const USAGE = `([\s\S]*?)`;/.exec(source)?.[1] ?? '';
    const spec = /export const CLI = (\{[\s\S]*?\}) as const;/.exec(source)?.[1] ?? '';
    const known = [...spec.matchAll(/'([a-z][a-z-]*)'/g)].map((m) => m[1]);

    it(`${driver}: every flag it reads is one it knows, and one its usage names`, () => {
      // The three ways a driver reads an argument: a switch, an option, and a positive number.
      const read = [...new Set([...source.matchAll(/\b(?:flag|opt|positive)\('([a-z][a-z-]*)'/g)].map((m) => m[1]))].filter((name) => name !== 'help');
      expect(read.length).toBeGreaterThan(2);
      expect(known.length).toBeGreaterThan(2);
      expect(read.filter((name) => !known.includes(name))).toEqual([]);
      expect(known.filter((name) => !usage.includes(`--${name}`))).toEqual([]);
    });

    it(`${driver}: the guard runs before any config is loaded`, () => {
      const guard = source.search(/^guardCli\(/m);
      // The repository is asked about first, and then the config is loaded; the guard precedes both.
      const config = source.search(/repoRootFrom\(process\.cwd\(\)\)|await load(Project|Walk)Config/);
      expect(guard).toBeGreaterThan(-1);
      expect(config).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(config);
    });

    it(`${driver}: --help exits 0 with the usage, and a typo exits 2 without running`, () => {
      // From a directory that is no repository and holds no config: a driver that got past its
      // guard would fail some other way, with some other exit code.
      const run = (...args: string[]) => Bun.spawnSync(['bun', path, ...args], { cwd: '/', stdout: 'pipe', stderr: 'pipe' });
      const help = run('--help');
      expect(help.exitCode).toBe(0);
      expect(help.stdout.toString()).toContain('--help, -h');
      const typo = run('--dryrun');
      expect(typo.exitCode).toBe(2);
      expect(typo.stderr.toString()).toContain("unknown flag '--dryrun'");
      expect(run('-h').exitCode).toBe(0);
    }, 30_000);
  }
});

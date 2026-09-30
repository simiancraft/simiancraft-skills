import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNERSHIP_MARKER, placeSizeCallbacks } from './place-callbacks.ts';

const TEMPLATE = readFileSync(join(import.meta.dir, '..', 'callbacks', 'on-size-over-ceiling'), 'utf8');
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'callbacks-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
const vars = { repoRoot: "/tmp/it's here", carveDir: '/tmp/skills/carve-github-issue', maxPoints: 2 };

describe('placeSizeCallbacks', () => {
  test('renders an executable with the marker on line 2 and the paths quoted', () => {
    const logs: string[] = [];
    const out = placeSizeCallbacks(dir, TEMPLATE, vars, (m) => logs.push(m), false);
    expect(out.rendered).toBe(join(dir, 'on-size-over-2'));
    const body = readFileSync(join(dir, 'on-size-over-2'), 'utf8');
    expect(body.split('\n')[1]).toBe(OWNERSHIP_MARKER);
    expect(body).toContain("cd '/tmp/it'\\''s here'");
    expect(body).toContain("--issue \"$issue\" --ceiling 2");
    expect(statSync(join(dir, 'on-size-over-2')).mode & 0o111).not.toBe(0);
  });
  test('re-renders on a ceiling change, removing the marked file and keeping an unmarked one', () => {
    writeFileSync(join(dir, 'on-size-over-99'), '#!/bin/sh\necho mine\n');
    const out = placeSizeCallbacks(dir, TEMPLATE, { ...vars, maxPoints: 3 }, () => {}, false);
    expect(out.rendered).toBe(join(dir, 'on-size-over-3'));
    expect(out.removed).toEqual([join(dir, 'on-size-over-2')]);
    expect(existsSync(join(dir, 'on-size-over-99'))).toBe(true);
    expect(existsSync(join(dir, 'on-size-over-2'))).toBe(false);
  });
  test('refuses to overwrite an unmarked file at the rendered name', () => {
    writeFileSync(join(dir, 'on-size-over-5'), '#!/bin/sh\necho theirs\n');
    const out = placeSizeCallbacks(dir, TEMPLATE, { ...vars, maxPoints: 5 }, () => {}, false);
    expect(out.refused).toBe(join(dir, 'on-size-over-5'));
    expect(out.rendered).toBeNull();
    expect(readFileSync(join(dir, 'on-size-over-5'), 'utf8')).toContain('theirs');
  });
  test('a dry run writes nothing', () => {
    const before = readdirSync(dir).sort();
    const out = placeSizeCallbacks(dir, TEMPLATE, { ...vars, maxPoints: 8 }, () => {}, true);
    expect(out.rendered).toBe(join(dir, 'on-size-over-8'));
    expect(readdirSync(dir).sort()).toEqual(before);
  });
});

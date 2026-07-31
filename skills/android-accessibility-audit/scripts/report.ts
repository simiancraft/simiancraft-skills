#!/usr/bin/env bun
/**
 * Aggregate a sweep's per-route reports into a summary.
 *
 * Usage: bun report.ts <sweep-outdir>/json
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Report } from './analyze';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: bun report.ts <sweep-outdir>/json');
  process.exit(1);
}

const reports: Report[] = [];
const unreadable: string[] = [];

for (const file of readdirSync(dir).sort()) {
  if (!file.endsWith('.json')) continue;
  try {
    reports.push(JSON.parse(readFileSync(join(dir, file), 'utf8')) as Report);
  } catch {
    // An empty or truncated report means the route was never really inspected.
    // Surfacing it matters more than skipping it: silently dropping these is
    // how a corrupted capture gets counted as a clean pass.
    unreadable.push(file);
  }
}

const byRule: Record<string, number> = {};
const jsErrors = new Set<string>();
let errors = 0;
let warnings = 0;

for (const r of reports) {
  errors += r.errors;
  warnings += r.warnings;
  for (const m of r.jsErrors) jsErrors.add(m);
  for (const f of r.findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
}

console.log(`${reports.length} routes | errors=${errors} warnings=${warnings}`);

if (unreadable.length > 0) {
  console.log(`\n!! ${unreadable.length} unreadable report(s), route NOT inspected:`);
  for (const f of unreadable) console.log(`   ${f}`);
}

const suspect = reports.filter((r) => r.suspectCapture);
if (suspect.length > 0) {
  console.log(`\n!! ${suspect.length} suspect capture(s), likely caught mid-mount:`);
  for (const r of suspect) console.log(`   ${r.label} (${r.textNodes} text nodes)`);
}

console.log('\n=== by rule ===');
for (const [rule, n] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${rule}`);
}

console.log('\n=== worst routes ===');
for (const r of [...reports].sort((a, b) => b.errors - a.errors || b.warnings - a.warnings).slice(0, 12)) {
  console.log(
    `  err=${String(r.errors).padStart(3)} warn=${String(r.warnings).padStart(3)}  ${r.label}`,
  );
}

console.log(`\nzero-error routes: ${reports.filter((r) => r.errors === 0).length}/${reports.length}`);

if (jsErrors.size > 0) {
  console.log('\n=== JS errors seen (LogBox) ===');
  for (const m of jsErrors) console.log(`  ${m.slice(0, 120)}`);
}

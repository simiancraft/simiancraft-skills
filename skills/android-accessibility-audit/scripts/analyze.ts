#!/usr/bin/env -S npx tsx
/**
 * Analyze one `maestro hierarchy` dump for Android accessibility defects.
 *
 * Runtime-agnostic on purpose: plain node:fs and no runtime-specific globals,
 * so `bun`, `npx tsx`, `pnpm dlx tsx`, or a compiled build all work. Nothing
 * here is Bun-only.
 *
 * Deliberately NOT axe-core. axe evaluates a DOM; this is a native view
 * hierarchy where the equivalent failures wear different shapes and several
 * axe rules have no native analogue at all.
 *
 * Usage: bun analyze.ts <hierarchy.json> <label> [density]
 * Emits a JSON report on stdout.
 */

/**
 * Physical pixels per dp. Override per device: `adb shell wm density` divided
 * by 160. A 440dpi emulator is 2.75; getting this wrong scales every geometry
 * finding, so pass it explicitly when auditing anything but the default AVD.
 */
const DEFAULT_DENSITY = 2.75;
/**
 * Android/Material guidance for a touch target. This is NOT the WCAG 2.2 AA
 * threshold: SC 2.5.8 asks for 24x24 CSS px and allows five exceptions
 * (spacing, equivalent control, inline, user-agent, essential), none of which
 * this evaluates. Report findings as platform guidance, not a WCAG failure.
 */
const MIN_TARGET_DP = 48;
/**
 * Heuristic, not a standard. Nothing in Material or WCAG designates 32dp; it
 * exists only to sort "noticeably small" from "barely under" during triage.
 */
const SEVERE_TARGET_DP = 32;
/**
 * A tree with fewer text nodes than this is usually captured mid-mount.
 * Exported so the sweep applies the same floor rather than duplicating it;
 * two copies of this number silently drift apart.
 */
export const MIN_TEXT_NODES = 8;

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Status bar and system UI, which is not the app under test. */
const SYSTEM_NOISE =
  /^\d{1,2}:\d{2}|Wifi|Phone signal|Phone \w+ bars|Battery|notification|Android System|Security & privacy/i;

/**
 * React Native's LogBox toast renders over the app in a debug build. Its nodes
 * are clickable and unnamed, so left in they manufacture findings against
 * dev-only chrome that never ships. There is no resource-id or distinguishing
 * class to key on, so match the toast's shape: an accessible name that starts
 * with the badge ("!" or an error count) followed by the message.
 */
const LOGBOX_NAME = /^(!|\d+),\s/;

export interface RawNode {
  attributes?: Record<string, string>;
  children?: RawNode[];
}

interface Bounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  h: number;
}

interface Node {
  depth: number;
  cls: string;
  text: string;
  desc: string;
  hint: string;
  clickable: boolean;
  importantForAccessibility: string;
  enabled: boolean;
  id: string;
  bounds: Bounds | null;
  clickableAncestors: Node[];
}

export interface Finding {
  rule: string;
  severity: 'error' | 'warn';
  detail: string;
  cls?: string;
  id?: string;
  bounds?: Bounds | null;
}

export interface Report {
  label: string;
  nodes: number;
  appNodes: number;
  clickables: number;
  textNodes: number;
  /** True when the capture looks mid-mount rather than settled. */
  suspectCapture: boolean;
  /** LogBox messages seen. A toast means a real JS error fired on this screen. */
  jsErrors: string[];
  errors: number;
  warnings: number;
  findings: Finding[];
}

function parseBounds(raw: string | undefined): Bounds | null {
  const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(raw ?? '');
  if (!m) return null;
  const [x1, y1, x2, y2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
}

function contains(outer: Bounds | null, inner: Bounds | null): boolean {
  if (!outer || !inner) return false;
  return (
    inner.x1 >= outer.x1 && inner.x2 <= outer.x2 && inner.y1 >= outer.y1 && inner.y2 <= outer.y2
  );
}

function flatten(root: RawNode): Node[] {
  const out: Node[] = [];
  const walk = (n: RawNode | undefined, depth: number, ancestors: Node[]) => {
    if (!n) return;
    const a = n.attributes ?? {};
    const node: Node = {
      depth,
      cls: (a.class ?? '').split('.').pop() ?? '',
      text: (a.text ?? '').trim(),
      desc: (a.accessibilityText ?? '').trim(),
      hint: (a.hintText ?? '').trim(),
      clickable: a.clickable === 'true',
      importantForAccessibility: a['important-for-accessibility'] ?? '',
      enabled: a.enabled !== 'false',
      id: a['resource-id'] ?? '',
      bounds: parseBounds(a.bounds),
      clickableAncestors: ancestors,
    };
    out.push(node);
    const next = node.clickable ? [...ancestors, node] : ancestors;
    for (const c of n.children ?? []) walk(c, depth + 1, next);
  };
  walk(root, 0, []);
  return out;
}

export function analyze(root: RawNode, label: string, density = DEFAULT_DENSITY): Report {
  const all = flatten(root);

  const logboxRoots = all.filter((n) => n.clickable && LOGBOX_NAME.test(n.desc));
  const jsErrors = logboxRoots.map((n) => n.desc.replace(LOGBOX_NAME, ''));
  const inLogbox = (n: Node) => logboxRoots.some((r) => contains(r.bounds, n.bounds));

  const app = all.filter((n) => !SYSTEM_NOISE.test(`${n.text} ${n.desc}`) && !inLogbox(n));
  // hintText is Android's HINT, not the accessible name. Counting it as a name
  // hides genuinely unnamed controls, so it does not satisfy this check.
  const named = (n: Node) => Boolean(n.desc || n.text);

  const findings: Finding[] = [];
  const add = (
    rule: string,
    severity: Finding['severity'],
    node: Node | null,
    detail: string,
  ): void => {
    findings.push({
      rule,
      severity,
      detail,
      cls: node?.cls,
      id: node?.id,
      bounds: node?.bounds ?? null,
    });
  };

  // --- Clickable with no accessible name ------------------------------------
  // A screen reader announces these as a bare "button"; the user cannot know
  // what activating one does.
  for (const n of app) {
    if (!n.clickable || named(n)) continue;
    if (!n.enabled) continue; // a disabled control is not an operable target
    // When a descendant carries the text, announcement depends on the platform
    // merging it upward, which usually works. Report it, but not as an error.
    const descendantSpeaks = app.some((d) => d.depth > n.depth && contains(n.bounds, d.bounds) && named(d));
    add(
      'clickable-unnamed',
      descendantSpeaks ? 'warn' : 'error',
      n,
      descendantSpeaks
        ? 'Clickable has no contentDescription; a descendant supplies text, so announcement depends on label merging'
        : 'Clickable has no contentDescription, text, or hint; announced as an unnamed control',
    );
  }

  // --- Touch target below the Material minimum ------------------------------
  for (const n of app) {
    if (!n.clickable || !n.bounds || !n.enabled) continue;
    const wDp = n.bounds.w / density;
    const hDp = n.bounds.h / density;
    if (wDp === 0 || hDp === 0) continue;
    if (wDp >= MIN_TARGET_DP && hDp >= MIN_TARGET_DP) continue;
    add(
      'target-size-48dp',
      Math.min(wDp, hDp) < SEVERE_TARGET_DP ? 'error' : 'warn',
      n,
      `${wDp.toFixed(1)}x${hDp.toFixed(1)}dp is below the ${MIN_TARGET_DP}dp minimum (${n.desc || n.text || 'unnamed'})`,
    );
  }

  // --- Nested touchables ----------------------------------------------------
  // The outer control takes accessibility focus, so the inner one is
  // unreachable. Common shape: a clickable row containing clickable cells.
  for (const n of app) {
    if (!n.clickable || n.clickableAncestors.length === 0) continue;
    const parent = n.clickableAncestors[n.clickableAncestors.length - 1];
    add(
      'nested-touchable',
      'warn',
      n,
      `Clickable nested inside clickable "${parent.desc || parent.text || parent.cls}"; the inner control may be unreachable`,
    );
  }

  // --- Inputs named by their placeholder or mask ----------------------------
  for (const n of app) {
    if (!/EditText/i.test(n.cls)) continue;
    const name = n.desc || n.text || n.hint;
    if (!name) {
      add('input-unnamed', 'error', n, 'Text input has no accessible name');
      continue;
    }
    if (/^\*+$/.test(name)) {
      add('input-name-is-mask', 'error', n, `Input announces its mask ("${name}") as its name`);
    } else if (/@|e\.g\.|example|yourname/i.test(name) && !n.desc) {
      add(
        'input-name-is-placeholder',
        'warn',
        n,
        `Input announces its placeholder ("${name}") as its name; no separate label association`,
      );
    }
  }

  // --- Explicitly hidden from accessibility ---------------------------------
  for (const n of app) {
    if (n.importantForAccessibility === 'false' && n.clickable) {
      add('clickable-hidden', 'error', n, 'Clickable is marked important-for-accessibility=false');
    }
  }

  // --- Headings: NOT CHECKABLE HERE, deliberately ---------------------------
  // AccessibilityNodeInfo.isHeading() has existed since API 28, so the state
  // does exist on the node. Neither `maestro hierarchy` nor stock
  // `uiautomator dump` serialises it, so THIS input cannot support the rule and
  // a check written against it would pass silently on every screen. Obtaining it
  // needs a custom dumper: a UiAutomation instrumentation test or an
  // accessibility service walking rootInActiveWindow and emitting isHeading.
  // Until then count accessibilityRole="header" in source, as a proxy rather
  // than verification of the runtime node.

  const textNodes = app.filter((n) => n.text).length;

  return {
    label,
    nodes: all.length,
    appNodes: app.length,
    clickables: app.filter((n) => n.clickable).length,
    textNodes,
    suspectCapture: textNodes < MIN_TEXT_NODES,
    jsErrors,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warn').length,
    findings,
  };
}

// `import.meta.main` is not portable across runtimes; comparing the resolved
// entry path is.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const [file, label, density] = process.argv.slice(2);
  if (!file || !label) {
    console.error('usage: analyze.ts <hierarchy.json> <label> [density]');
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as RawNode;
  const report = analyze(raw, label, density ? Number(density) : undefined);
  console.log(JSON.stringify(report, null, 2));
}

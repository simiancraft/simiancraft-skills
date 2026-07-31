---
name: android-accessibility-audit
description: >-
  Audit an Android app's real accessibility tree, route by route, and get counted
  findings back. Deep-links each route on a booted emulator or device, captures the
  native tree with `maestro hierarchy`, and reports unnamed controls, touch targets
  under Material's 48dp, nested touchables that steal focus from the control inside
  them, and inputs that announce their placeholder instead of their label. Use when
  the task is "audit accessibility on Android", "is this screen usable with
  TalkBack", "find unlabeled buttons", "check touch target sizes", or "prove the
  accessibility work actually landed on device". Complements static linting, which
  cannot see runtime-supplied names, geometry, nesting, or third-party components.
  Project-agnostic; works for any Android, React Native, or Expo app that deep-links.
  Layers on android-emulator-harness for bring-up and mobile-accessibility for the
  underlying model. Validated on Linux/WSL with Maestro 2.x and an API 34 AVD.
status: complete
sources:
  - https://m3.material.io/foundations/designing/structure (Material's 48dp minimum touch target)
  - https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html (WCAG 2.2 AA asks only 24x24 CSS px, which is why a web pass is not enough)
  - https://developer.android.com/reference/android/view/accessibility/AccessibilityNodeInfo (the tree this reads, including isHeading())
  - https://reactnative.dev/docs/accessibility (how RN props map onto that tree)
---

# Android Accessibility Audit

Static linting finds unlabeled elements in source. This finds what the device
actually exposes, which is a different set. The gap is not academic: names
supplied at runtime, geometry, focus stealing, and third-party components are all
invisible to source analysis and all routinely broken.

**Read [mobile-accessibility](../mobile-accessibility/SKILL.md) first** for the
one-tree-two-readers model. **Use
[android-emulator-harness](../android-emulator-harness/SKILL.md)** to get an app
running; this skill assumes that is already done.

## The core claim

An accessibility pass is not done because a linter is green, and it is not done
because a screen "looks fine". It is done when the tree a screen reader reads has
a name for every control, targets big enough to hit, and no control hidden inside
another. Those are measurable. Measure them.

## Dependencies

Nothing to install per project; these are host tools. The sweep preflights all of
them and exits 127 naming whichever is missing, rather than running to completion
with empty captures.

| Tool | Why | Override |
|---|---|---|
| `adb` (platform-tools) | deep-links routes, screenshots, device registry | `ADB` |
| Maestro 2.x | dumps the accessibility tree (`maestro hierarchy`) | `MAESTRO` |
| JDK 17 | Maestro refuses to start on older JDKs | see gotchas |
| a TypeScript runner | runs `analyze.ts` and `report.ts` | `RUNNER`, default `bun` |
| GNU `timeout` (coreutils) | bounds every hung adb or Maestro call | `TIMEOUT` |

The two TypeScript files use only `node:fs`, `node:path`, and `node:url`, with no
runtime-specific globals, so `bun`, `npx tsx`, `pnpm dlx tsx`, or a compiled build
all work: `RUNNER="npx tsx" ./scripts/sweep.sh ...`. There are no npm
dependencies and no package.json; the scripts are standalone.

On macOS, `timeout` arrives from Homebrew coreutils as `gtimeout`, so set
`TIMEOUT=gtimeout`.

## Prerequisites

This skill provisions none of these. Get them from `android-emulator-harness`:

- a device or emulator visible to `adb devices`
- the app installed, **debuggable build preferred** so the JS tracks your working
  tree rather than whatever shipped
- the bundler running and reachable (`adb reverse tcp:8081 tcp:8081` for Metro)
- **already signed in and past any onboarding gate**

That last one is not a footnote. An onboarding or auth gate redirects every deep
link to itself, so the sweep will happily audit the same gate screen N times and
report it as N clean routes. Confirm you can deep-link to a route and land on it
before sweeping anything.

## Workflow

### 1. Build the route list

One `url-path<TAB>label` per line. Labels become filenames.

```
/settings	settings
/profile	profile
/search	search
```

**Expo Router:** group segments in parentheses (`(root)`, `(tabs)`) do **not**
appear in URLs. Strip them from any generated manifest before deep linking, or
every route will 404 into the fallback.

```bash
# from an Expo route manifest
bun -e '
import {ROUTES} from "./path/to/routes.ts";
const strip = (p) => "/" + p.split("/").filter((s) => s && !/^\(.*\)$/.test(s)).join("/");
for (const r of ROUTES.filter((r) => r.navigable)) console.log(strip(r.path) + "\t" + r.label);
' > /tmp/routes.txt
```

### 2. Sweep

```bash
APP_SCHEME=myapp ./scripts/sweep.sh /tmp/routes.txt /tmp/a11y-out
```

Every `adb` call is pinned to `ANDROID_SERIAL` (default `emulator-5554`). Set it
when more than one device is attached, or adb will refuse with "more than one
device/emulator". Set `BUNDLER_PORT` if your bundler is not on 8081, or
`BUNDLER_PORT=` to skip the reverse entirely for a standalone build.

Per route: a hierarchy dump, a screenshot, and a JSON report. On a 440dpi AVD,
budget roughly 15 to 20 seconds per route.

Get the density right or every geometry finding is wrong by that factor:

```bash
adb shell wm density   # 440 -> DENSITY=2.75
DENSITY=2.75 APP_SCHEME=myapp ./scripts/sweep.sh /tmp/routes.txt /tmp/a11y-out
```

### 3. Aggregate

```bash
bun ./scripts/report.ts /tmp/a11y-out/json
# or with any other runner:
npx tsx ./scripts/report.ts /tmp/a11y-out/json
```

Reports totals, findings by rule, worst routes, unreadable reports, and suspect
captures. **Read the last two before believing the totals.**

### 4. Fix the shared component, not the route

Findings cluster. Five unnamed buttons on every screen is one navigation bar, not
five defects. Forty nested touchables across a dozen list screens is one row
component. Find the shared ancestor before touching a single route, then re-sweep
and diff the counts as your receipt.

## What it checks

| Rule | Severity | Meaning |
|---|---|---|
| `clickable-unnamed` | error | Clickable with no name; announced as a bare "button". Downgraded to warning when a descendant supplies text, since platforms usually merge that upward |
| `target-size-48dp` | error under 32dp, else warning | Below Material's 48dp minimum |
| `nested-touchable` | warning | Clickable inside a clickable; the outer takes focus and the inner is unreachable |
| `input-name-is-placeholder` | warning | Input announces its placeholder or current value instead of its label |
| `input-name-is-mask` | error | Password input announces literal asterisks as its name |
| `clickable-hidden` | error | Clickable marked `important-for-accessibility=false` |

`target-size-48dp` is the rule a web audit will not give you. WCAG 2.2 AA asks
only for 24x24 CSS px, so a control can pass axe-core and still be half the size
a thumb needs.

The analyzer filters React Native's LogBox toast, which is dev-only chrome and
would otherwise manufacture unnamed-clickable findings on every screen in a debug
build. Messages it sees are surfaced as `jsErrors` instead: a toast means a real
JS error fired on that screen, which is worth knowing even though it is not an
accessibility defect.

## What it deliberately refuses to check

**Headings.** React Native maps `accessibilityRole="header"` onto
`AccessibilityNodeInfo.isHeading()`, but neither `maestro hierarchy` nor
`uiautomator dump` serialises that bit: the attribute set has no heading field and
the node class is unchanged. A tree-based heading rule would pass silently on
every screen and prove nothing, which is worse than having no rule. Count
`accessibilityRole="header"` in source instead, and know that a low count means
titles are plain text to a screen reader.

This is the general principle: a check that cannot fail is not a check.

## What a passing sweep does not mean

Say this out loud when reporting results, because the number looks more total than
it is.

- **Real screen-reader behaviour is unverified.** This reads the tree. Focus
  order, announcement phrasing, and gesture navigation are not measured, and a
  correctly labelled tree can still traverse badly. Some manual TalkBack passes on
  core flows stay unavoidable.
- **Contrast is not measured.**
- **Only the routes you listed were seen.** Routes behind a role, a feature flag,
  or entity data are invisible unless you provision for them. If an unprivileged
  fixture silently redirects a whole admin surface, the sweep reports clean routes
  that were never rendered.
- **Static analysis still has its own coverage.** Run both; neither alone is a
  coverage claim.

## Gotchas that cost real time

- **A stale `offline` device entry blinds Maestro.** With a dead entry listed
  beside a live one, Maestro reports `No running emulator found` while
  `adb devices` looks healthy. This took out 31 of 34 routes on one run.
  `sweep.sh` flushes the adb server in-loop when it sees that message. If
  something keeps re-registering the dead entry, suspect a second emulator or a
  parallel session.
- **Maestro sometimes prints `Running on <device>` to stdout** ahead of the JSON,
  corrupting the capture. Three routes recorded empty reports this way and read as
  clean passes until the files were parsed. `sweep.sh` strips everything before
  the first brace; `report.ts` lists unreadable files instead of skipping them.
- **A dump taken mid-mount has the app's nodes but no text**, which looks exactly
  like a screen with no labels. The sweep re-dumps below a text-node floor and
  `analyze.ts` sets `suspectCapture` so a thin capture stays visible downstream.
  Raise `SETTLE_SECONDS` for data-heavy screens.
- **`JAVA_HOME` may be pre-set to a JDK Maestro rejects.**
  `export JAVA_HOME="${JAVA_HOME:-...}"` keeps the existing value and silently
  does nothing. Force the assignment.
- **`adb` may not be able to fork its own daemon.** `adb start-server` exits 0
  while the forked server dies. Run `adb nodaemon server` as a persistent
  background process.

The through-line: **an empty result is not a pass.** Every failure mode above
produces a screen that was never inspected while looking exactly like a screen
with nothing wrong. Anything consuming a sweep has to tell those apart.

## Files

| File | Purpose |
|---|---|
| `scripts/sweep.sh` | Deep-links each route, captures tree and screenshot, calls the analyzer |
| `scripts/analyze.ts` | Pure function from one hierarchy dump to findings; no device needed |
| `scripts/report.ts` | Aggregates a sweep directory into totals and worst offenders |

`analyze.ts` exports `analyze(root, label, density)` if you want to consume it
directly rather than through the sweep.

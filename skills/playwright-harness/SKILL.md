---
name: playwright-harness
description: >-
  Drive a real browser with Playwright on any OS and gate on what you observe:
  write a script, launch Chromium (headless by default; a shared headed window
  when a human must watch or drive), drive the page, and assert on screenshots
  plus collected page errors. The operational trunk for browser work;
  specializations layer on top. Use for ANY web task: "drive the UI headlessly",
  "smoke-test a screen", "screenshot a component or canvas", "reproduce a console
  error", "fill and submit a form", "test a login flow", "check responsive
  layout", "find broken links", "open a browser I can watch/drive", or "automate
  a browser flow". Open references/interactions.md and references/flows.md for
  the element vocabulary and multi-step recipes; switch to
  playwright-camera-mask-testing for a camera or person feed, or
  playwright-gif-capture for an animated GIF. Validated on Linux/WSL (headless,
  ANGLE GPU path for WebGL) and macOS (headless + interactive headed mode).
---

# Playwright Harness

Project-agnostic kernel for driving a browser and asserting on it; the operational
trunk the rest of the suite hangs off.

## Map of the suite

This skill is the trunk: what to install, plus the run-and-assert pattern.
Everything else hangs off it.

```
playwright-harness/                     <- you are here: prerequisites + run pattern + assert loop
├── references/
│   ├── interactions.md                 address elements: locators, actions, waits, assertions
│   └── flows.md                        recipes: login, forms, responsive, link-checking, network stubbing
├── scripts/
│   ├── keeper.mjs                      interactive headed mode: long-lived shared browser + CDP
│   └── observe.mjs                     interactive headed mode: attach, report URL/errors, screenshot
└── specializations (separate, discoverable skills; read this one first):
    ├── playwright-camera-mask-testing  a real person through getUserMedia; assert segmentation/mask by vision
    └── playwright-gif-capture          an animated GIF of a page, canvas, or WebGL animation
```

`references/` is this skill's own depth, loaded by reading the file. The
specializations are separate, discoverable skills; open one when its input (a
camera feed, a GIF) is what you need.

> **Runtime/package manager.** Examples use plain `node` + `npm`; substitute your
> own runner (`bun`, `pnpm`, `yarn`) wherever they appear. Playwright itself is
> unaffected.

## Prerequisites (install once)

- **Node 18+** and a package manager.
- **Playwright + a browser binary.** Playwright ships no browser by default:
  ```bash
  npm i -D playwright          # or add to the project that already has it
  npx playwright install chromium
  ```
- **Headless system libraries (Linux/WSL only).** A fresh box is missing the
  shared libs Chromium needs (`libnss3`, `libatk`, `libgbm`, …); the symptom is a
  launch error listing `error while loading shared libraries`. Install them once:
  ```bash
  npx playwright install-deps chromium   # needs sudo; or your distro's equivalent packages
  ```
  **macOS needs none of this** — the downloaded Chromium runs as-is, headless or
  headed. There is no `install-deps` step and no GPU shim to configure; a headed
  launch opens a normal window on the desktop.
- Some specializations need extra binaries (e.g. `ffmpeg` for video/GIF encode);
  each declares its own in a "Prerequisites" block.

## The run pattern

1. **Write the script into a dedicated scratch dir**, never into the skill or the
   project: `/tmp/pw-<task>/run.mjs`, with any output alongside it
   (`/tmp/pw-<task>/shot.png`). A per-task dir stops parallel runs from colliding
   on a shared filename. Parameterize the URL as `const TARGET_URL =
   process.env.TARGET_URL || '<default>'` so it is never hardcoded.
2. **Make `playwright` resolvable from the script's own directory.** ESM resolves
   a bare import from the SCRIPT's location upward; cwd is irrelevant, so running a
   `/tmp` script from inside a project that has playwright does NOT work. Symlink
   an existing install into the scratch dir (do not reuse a shared
   `/tmp/node_modules`; it collides with other `/tmp` installs and then the import
   silently fails to resolve):
   ```bash
   mkdir -p /tmp/pw-<task>
   ln -sfn /path/to/an-install/node_modules /tmp/pw-<task>/node_modules  # an install that has playwright
   node /tmp/pw-<task>/run.mjs
   ```
   No install handy? `cd /tmp/pw-<task> && npm i playwright` right there. Confirm
   it resolves before relying on it: from the scratch dir, `node -e
   "import('playwright').then(() => console.log('resolves'))"`.
3. **Default to headless.** It is faster and gives clean, chrome-free screenshots.
   Use `headless: false` only when a human must watch or drive — see "Interactive
   headed mode" below. (On a display-less box — CI, WSL without WSLg — headed
   launches fail outright; headless is not just the default there, it is the only
   mode.)

```js
// /tmp/pw-task/run.mjs
import { chromium } from 'playwright';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:8080/';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));

await page.goto(TARGET_URL, { waitUntil: 'load' });
await page.locator('#root').screenshot({ path: '/tmp/pw-task/shot.png' }); // element-cropped; use page.screenshot() for the full page
await browser.close();
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors');
```

## Interactive headed mode (shared browser, human + agent)

When a human must watch the agent drive — or type URLs and act while the agent
observes — one browser is shared between them instead of scripting a headless
one-shot. Two scripts in `scripts/` implement it; copy them into the scratch dir
(they follow the same resolution rule as any run-pattern script):

- **`keeper.mjs`** — launched as a **background process**, it opens a headed
  Chromium with a persistent profile (`./profile` beside the script, so logins
  survive relaunches) and exposes CDP on `:9222` (`CDP_PORT` to override). The
  human gets a real window with an address bar; the process lives until the
  window closes.
- **`observe.mjs`** — run on demand, it attaches over CDP, reports the active
  tab's URL and title, and screenshots it for vision assertion. Its
  `browser.close()` only detaches the CDP connection; the headed window stays up.

Driving works the same way: any ad-hoc script that starts with
`chromium.connectOverCDP('http://127.0.0.1:9222')` can locate elements, click,
and fill in the shared window using the ordinary vocabulary from
`references/interactions.md`. Two caveats learned the hard way:

- **The keeper dies with its parent.** If the shell/session that spawned it
  exits, the window vanishes. Check the CDP port (`lsof -nP -iTCP:9222`) before
  assuming the browser is still up; relaunching is idempotent thanks to the
  persistent profile.
- **Screenshots of a headed window include its real viewport**, sized by the
  human's window, not a scripted `viewport:` — assert on element crops, not
  pixel-exact page dimensions.

## Assert on what you observe

- **Gate on page errors.** Collect `pageerror` + `console` errors (filter
  favicon/DevTools noise), and treat a non-empty list as a failure.
- **Then Read the screenshot** (vision); that is the half only your eyes can do.
  Crop with `locator.screenshot()` so the assertion is about the thing under test,
  not the whole page.
- **Wait on conditions, not the clock:** `waitForSelector`, `waitForURL`,
  `waitForLoadState`, or a page-exposed signal, beats a fixed `waitForTimeout`.

## Interactions and flows

The element vocabulary and the multi-step recipes live in the two references
above. They exist to reach observable states worth gating on, not to be a general
automation toolkit; a new recipe earns its place by ending on something you
assert, not just an action it performs.

## WebGL / GPU caveat (headless, any OS; fix shown is Linux/WSLg)

Default headless Chromium renders WebGL via **SwiftShader** on every platform,
which silently **no-ops heavy GPU work**: a canvas-heavy page or a generative
shader renders black/empty with GPU time ~0, no error. A headed launch (macOS or
a Linux desktop) always has the real GPU, so interactive headed mode sidesteps
this entirely. If a canvas is empty headless but works in a real browser,
relaunch reaching the real GPU — under WSLg, via ANGLE:

```js
chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'] });
```

Confirm you got a real GPU, not SwiftShader, via the renderer string:

```js
await page.evaluate(() => { const g = document.createElement('canvas').getContext('webgl2');
  const x = g.getExtension('WEBGL_debug_renderer_info');
  return x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : 'no-debug-renderer-info'; });
```

Read the string case-insensitively for the software markers `SwiftShader` and
`llvmpipe`: if either is present you are on the no-op software path. The leading
`ANGLE (` proves nothing on its own; the software path can arrive wrapped, e.g.
`ANGLE (Google, Vulkan ... SwiftShader driver)`. A real GPU names an actual
adapter, e.g. `ANGLE (Intel..., D3D12 (Intel(R) UHD Graphics 770), ...)`.

Let any shader/animation settle a second or two after first paint (PSO compile)
before capturing, or early frames stutter.

## Serving an exported static site

To test a production build, serve it and point `TARGET_URL` at it. If the app
deploys under a sub-path (project Pages sites), serve it under that sub-path;
root-served local runs hide absolute-path 404s (`/_app/...`, `/static/...`) that
only bite in production:

```bash
mkdir -p /tmp/site && ln -sfn "$(pwd)/dist" /tmp/site/<base-path>
python3 -m http.server 8091 -d /tmp/site   # test http://localhost:8091/<base-path>/
```

`python3 -m http.server PORT -d DIR` serves any static directory (a single loose
fixture works the same way). It is static-only and cannot answer an app's live
endpoints (`/api/...`); for those, point `TARGET_URL` at the running dev server,
or stub the endpoints with the network-stubbing recipe in `references/flows.md`.

## Scope

- **CAN validate:** page loads and routing, UI wiring and flows, element presence,
  console/page-error cleanliness, visual state by vision, the real deployed site
  (point `TARGET_URL` at it; no install needed).
- **CANNOT validate:** real frame-rate/perf (headless timing is not device
  timing), true input-device fidelity, or Firefox/WebKit capability differences
  unless you launch those browsers explicitly.

## The specialization contract

A sibling skill (mapped above) says "Read playwright-harness first" and adds only
its delta: its inputs and its assertion. It does not re-document the run pattern,
the assert loop, or the GPU caveat. A new reference follows the same rule: it
states its patterns and points back here for execution.

---
name: playwright-harness
description: >-
  Drive a real browser headlessly with Playwright on Linux/WSL and gate on what
  you observe: write a script, launch Chromium (real GPU under WSLg via ANGLE when
  WebGL matters), drive the page, and assert on screenshots + collected page
  errors. The web analog of an emulator harness. Use for ANY web project when the
  task is "run the page in a browser", "drive the UI headlessly", "smoke-test a
  screen", "screenshot a component/canvas", "reproduce a console error", or "set
  up browser testing". Project-agnostic base; layer a domain skill on top for
  specialized inputs (see playwright-camera-mask-testing for a camera feed,
  playwright-gif-capture for animated GIFs). Validated on Linux/WSL, headless
  Chromium, with the ANGLE GPU path for WebGL.
---

# Playwright Harness (headless, Linux/WSL)

Project-agnostic kernel for driving a browser and asserting on it. Specializations
sit ON TOP of this and override only the parts they must.

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
- **Headless system libraries (Linux/WSL).** A fresh box is missing the shared
  libs Chromium needs (`libnss3`, `libatk`, `libgbm`, …); the symptom is a launch
  error listing `error while loading shared libraries`. Install them once:
  ```bash
  npx playwright install-deps chromium   # needs sudo; or your distro's equivalent packages
  ```
- Some specializations need extra binaries (e.g. `ffmpeg` for video/GIF encode);
  each declares its own in a "Prerequisites" block.

## The run pattern

1. **Write the script to a temp path**, never into the skill or the project:
   `/tmp/pw-<task>.mjs`. Parameterize the URL as `const TARGET_URL =
   process.env.TARGET_URL || '<default>'` so it is never hardcoded.
2. **Run it with `playwright` resolvable.** An ESM bare import resolves from the
   script's directory upward, so run from (or under) a dir that has playwright
   installed, or symlink one next to the script:
   ```bash
   node /tmp/pw-task.mjs                            # cwd or a parent already has playwright
   ln -sfn "$PWD/node_modules" /tmp/node_modules    # else symlink an install so /tmp resolves bare imports
   ```
3. **Default to headless.** It is faster and gives clean, chrome-free screenshots.
   Use `headless: false` only to watch a flow interactively while debugging.

```js
// /tmp/pw-task.mjs
import { chromium } from 'playwright';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:8080/';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));

await page.goto(TARGET_URL, { waitUntil: 'load' });
await page.locator('#root').screenshot({ path: '/tmp/shot.png' }); // element; omit .locator for full page
await browser.close();
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors');
```

## Assert on what you observe

- **Gate on page errors.** Collect `pageerror` + `console` errors (filter
  favicon/DevTools noise), and treat a non-empty list as a failure.
- **Then Read the screenshot** (vision); that is the half only your eyes can do.
  Crop with `locator.screenshot()` so the assertion is about the thing under test,
  not the whole page.
- **Wait on conditions, not the clock:** `waitForSelector`, `waitForURL`,
  `waitForLoadState`, or a page-exposed signal, beats a fixed `waitForTimeout`.

## WebGL / GPU caveat (WSLg, headless)

Default headless Chromium renders WebGL via **SwiftShader**, which silently
**no-ops heavy GPU work**: a canvas-heavy page or a generative shader renders
black/empty with GPU time ~0, no error. If a canvas is empty headless but works in
a real browser, relaunch reaching the real GPU under WSLg:

```js
chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'] });
```

Confirm you got a real GPU, not SwiftShader, via the renderer string:

```js
await page.evaluate(() => { const g = document.createElement('canvas').getContext('webgl2');
  const x = g.getExtension('WEBGL_debug_renderer_info');
  return x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : 'no-debug-renderer-info'; });
```

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

## Scope

- **CAN validate:** page loads and routing, UI wiring and flows, element presence,
  console/page-error cleanliness, visual state by vision, the real deployed site
  (point `TARGET_URL` at it; no install needed).
- **CANNOT validate:** real frame-rate/perf (headless timing is not device
  timing), true input-device fidelity, or Firefox/WebKit capability differences
  unless you launch those browsers explicitly.

## Specializations that layer on this base

- **playwright-camera-mask-testing**: feed a real person through getUserMedia and
  assert segmentation/mask effects by vision.
- **playwright-gif-capture**: capture an animated GIF of a page or canvas.

A new specialization says "Read playwright-harness first" and adds only its delta
(its inputs, its assertion); it does not re-document the run pattern, the assert
loop, or the GPU caveat.

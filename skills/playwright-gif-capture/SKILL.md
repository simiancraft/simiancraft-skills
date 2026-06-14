---
name: playwright-gif-capture
description: >-
  Specialization of playwright-harness for capturing an ANIMATED GIF of web
  content: drive a page/canvas/WebGL animation, grab a sequence of frames, and
  encode a looping GIF. Use when the task is "make a gif of this", "grab a gif of
  the demo/animation/shader", "record the canvas as a gif", or "capture a looping
  clip for a PR/README/issue"; any time a still screenshot is not enough. Read
  playwright-harness FIRST for script conventions and execution. For the
  quality/size dials (preventing deep-fried color, janky frame rate, or oversized
  files) read references/gif-optimization.md rather than guessing. Validated on
  Linux/WSL, headless Chromium + ANGLE, against WebGL canvas content.
---

# GIF Capture: specialization of playwright-harness

**Read `playwright-harness` first.** The base owns prerequisites, the run pattern
(write to `/tmp/pw-*.mjs`, run with `playwright` resolvable), and the drive/assert
+ WebGL-GPU patterns. This skill changes only how you turn a running animation
into frames. Encoding and the quality/size tradeoffs live in
**`references/gif-optimization.md`**; open it before tuning, since a deep-fried,
janky, or oversized GIF is easy to make by accident.

**Headless is required here** (not just the default): the encode is offline and
you want clean, chrome-free frames.

## Prerequisites (in addition to the base)

- `ffmpeg` to encode frames/video into a GIF; `npm i ffmpeg-static` in a /tmp dir
  gives a binary path, no system install.
- For tuning, `gifski` (best on gradients) and `gifsicle` (size reduction); see
  `references/gif-optimization.md`. ImageMagick is an optional alternative.

## Capture the frames. Two ways.

### A. Frame-by-frame screenshots (default)

The default for canvas, WebGL, or any clock-driven animation. Drive the clock
yourself, one frame at a time, and screenshot each step: deterministic (same
frames every run), evenly spaced (no wall-clock jitter, so no jank), croppable to
an element, and it sidesteps the recordVideo GPU-death trap below.

```js
// /tmp/pw-gif.mjs  (run via the harness: node, with playwright resolvable)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:8080/';
const FRAMES = 48, FPS = 16, OUT = '/tmp/gif-frames';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'], // real GPU under WSLg; see GPU note
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
await page.goto(TARGET_URL, { waitUntil: 'load' });
const target = page.locator('#canvas'); // element to crop to (omit -> full page)

for (let i = 0; i < FRAMES; i++) {
  const t = i / FPS; // animation time for this frame (seconds)
  // Step the animation deterministically. Best: the page exposes a render hook.
  await page.evaluate((t) => window.__renderAtTime?.(t), t);
  await page.waitForTimeout(30); // let the draw land (and the GPU flush)
  await target.screenshot({ path: `${OUT}/f${String(i).padStart(4, '0')}.png` });
}
await browser.close();
console.log(`wrote ${FRAMES} frames to ${OUT}`);
```

The clean version needs a **render-at-time hook** on the page
(`window.__renderAtTime(t)` sets the clock and draws one frame). If the app only
has a free-running `requestAnimationFrame` loop, either (a) add a tiny hook for
the capture, or (b) fall back to wall-clock sampling: `waitForTimeout(1000/FPS)`
between shots, accepting minor unevenness. Capture exactly one period of a
periodic animation so it loops seamlessly.

### B. Playwright recordVideo (DOM/CSS animations you cannot time-step)

```js
const context = await browser.newContext({
  recordVideo: { dir: '/tmp/gif-vid', size: { width: 960, height: 540 } },
});
const page = await context.newPage();
await page.goto(TARGET_URL);
await page.waitForTimeout(3000); // record real-time playback
await context.close();           // <- video finalizes on CONTEXT close, not page close
// -> /tmp/gif-vid/<hash>.webm, then encode (below)
```

Real-time, whole viewport, no hook needed. Two costs: it records wall-clock (so it
inherits any jank), and **under heavy GPU load it can kill the GPU process
mid-record and the rest goes black** (cranked WebGL + recordVideo is the known
offender). For canvas/shader content prefer method A, or record at a light load.

## Encode to a GIF

A sane default to get a watchable loop (`ffmpeg-static` via `npm i` in /tmp; npm,
not bun, since the postinstall downloads the binary):

```bash
cd /tmp && npm i ffmpeg-static >/dev/null 2>&1
FF=$(node -e "process.stdout.write(require('/tmp/node_modules/ffmpeg-static'))")
# from frame PNGs (method A):
"$FF" -y -framerate 16 -i /tmp/gif-frames/f%04d.png \
  -vf "scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5" \
  -loop 0 /tmp/out.gif
# from a recorded webm (method B): swap "-framerate 16 -i .../f%04d.png" for "-i /tmp/gif-vid/*.webm" and add fps=16 to the -vf chain
```

**Then stop guessing and open `references/gif-optimization.md`** for the
color/fps/size tradeoff model, the tool matrix (ffmpeg vs gifski vs gifsicle vs
ImageMagick), and the target-size loop. The short version: banding/deep-fried,
raise the dither or switch to gifski; too large, trade dims, then duration, fps,
colors, then a gifsicle lossy pass; janky, capture by method A at a fixed clock
and encode at the capture fps (12 to 20 is the sweet spot).

Always print the output byte size and **Read the GIF back** (vision) before
shipping.

## GPU note (delta)

The base's WebGL/GPU caveat applies verbatim; the launch args above already use
it. For shader content the ANGLE relaunch is mandatory (heavy shaders no-op under
SwiftShader headless), and you must let the animation settle a second or two (PSO
compile) before the first captured frame. See playwright-harness, "WebGL / GPU
caveat".

## Embedding the GIF in a GitHub PR / issue / README

GitHub's inline drag-and-drop upload (user-attachments) has **no API**, so an
agent cannot post one that way. The working pattern: commit the GIF to a
never-merge assets branch (e.g. `evidence/issue-verification`) and embed it by
**raw.githubusercontent URL**
(`![demo](https://raw.githubusercontent.com/<org>/<repo>/evidence/issue-verification/<path>.gif)`),
which renders and animates inline. Push that branch from a detached worktree with
`--no-verify` (an assets worktree has no node_modules, so a pre-commit hook
manager such as lefthook or husky would fail).
Never open a PR from the assets branch. For a committed README asset, a normal
commit on the feature branch is fine; mind the repo's size budget.

## Scope

- **CAN:** produce a reproducible, tight animated GIF of any web/canvas/WebGL
  animation; crop to an element; control frame count, fps, size, and palette;
  capture the real deployed site (point `TARGET_URL` at it).
- **CANNOT:** prove real-time FPS/perf (frame-by-frame is a controlled
  reconstruction at a chosen fps, not a measurement; use a GPU-time meter for
  cost); capture audio; or render a single frame so heavy it trips the OS GPU
  watchdog (split the work or lower the load first).

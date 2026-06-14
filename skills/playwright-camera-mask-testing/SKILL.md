---
name: playwright-camera-mask-testing
description: >-
  Specialization of playwright-harness for CAMERA / segmentation testing in the
  browser: put a real PERSON in front of getUserMedia so MediaPipe / selfie
  segmentation produces an actual mask, then verify background-replacement /
  blur / shader effects by vision. Use when the task is "test the mask on web",
  "verify segmentation in the browser", "feed the camera a person fixture",
  "check a camera/background effect in Chrome", or any time a web app must SEE
  a human through the webcam without physical hardware. Read playwright-harness
  FIRST for script conventions and execution; this skill only adds the
  camera-feed pieces. The web analog of android-emulator-mask-testing.
  Validated on Linux/WSL, headless Chromium, against MediaPipe Selfie
  Segmentation.
---

# Camera / Mask Testing: specialization of playwright-harness

**Read `playwright-harness` first.** The base owns prerequisites, the run pattern
(write to `/tmp/pw-*.mjs`, run with `playwright` resolvable), and the drive/assert
+ WebGL-GPU patterns. This skill changes only how the camera is fed. MediaPipe
selfie segmentation runs in WASM and works headless.

## Prerequisites (in addition to the base)

`ffmpeg`, only to turn the still fixture into the looping `.y4m` Chrome plays as a
fake camera; no system install needed, `npm i ffmpeg-static` in a /tmp dir gives a
binary path.

This skill ships two fixtures (derivations and provenance in
`fixtures/README.md`):

- **`fixtures/person-web.png`**: a 640x480 webcam-shaped frame, full-body
  subject occupying ~82% of frame height, vertically centered, on a clean
  light-gray ground (`#CDD0D4`). Derived from
  `android-emulator-mask-testing/fixtures/person-framed.png`. Web presents the
  capture file **1:1** (no sensor crop), so do NOT reuse the Android fixture
  directly; its left-quarter framing compensates an emulator sensor shift that
  does not exist on web.
- **`fixtures/office-empty.png`**: a 1280x720 empty office, the **no-person
  negative case**: a realistic scene (furniture, plants, windows, hard
  shadows) with nothing segmentable in it. Use it to mock the scene itself
  when the feed should contain no one.

## The three camera modes (pick by what you are asserting)

1. **Green-ball mode** (Chromium's built-in synthetic feed): proves the
   pipeline RUNS end to end (getUserMedia resolves, effects apply, no page
   errors). Useless for mask quality; the feed has no person.

   ```js
   args: [
     '--use-fake-device-for-media-stream',
     '--use-fake-ui-for-media-stream',          // auto-grants the permission prompt
     '--autoplay-policy=no-user-gesture-required',
   ]
   ```

2. **Person mode** (file-backed feed): proves mask SHAPE and compositing
   (person kept, background replaced/blurred). Add one flag; it **requires**
   `--use-fake-device-for-media-stream` to be present too:

   ```js
   args: [
     '--use-fake-device-for-media-stream',
     '--use-file-for-fake-video-capture=/tmp/person-web.y4m',
     '--use-fake-ui-for-media-stream',
     '--autoplay-policy=no-user-gesture-required',
   ]
   ```

   The file must be **`.y4m`** (uncompressed YUV4MPEG2) or **`.mjpeg`**; Chrome
   loops it forever. Generate the y4m from the fixture at test time; it is too
   big to keep around (size = W x H x 1.5 bytes x frames; 640x480 x 2 s @ 15 fps
   ≈ 14 MB). No system ffmpeg needed: `npm i ffmpeg-static` in a /tmp dir.

   ```bash
   ffmpeg -loop 1 -i fixtures/person-web.png -t 2 -r 15 -pix_fmt yuv420p /tmp/person-web.y4m
   ```

   Keep dimensions even (yuv420p requirement) and resolution ≤ 720p. A malformed
   y4m (odd dimensions, wrong `pix_fmt`) makes Chrome play nothing with no error:
   a dead-looking feed that mimics segmentation falling through, so regenerate the
   y4m before any deeper diagnosis.

3. **Empty-scene mode** (same flags, `office-empty.png` as the file): the
   guaranteed-clean no-person feed. The fixture is chosen because it does NOT
   false-positive (validated clean at a 0.75 segmentation-confidence cutoff; that
   is the fixture's property, not an app's tuned threshold), so
   whole-frame assertions stay unconfounded: background replacement should
   cover the WHOLE frame, blur should blur the whole frame uniformly, and any
   sharp person-shaped region that appears is the app's bug (an empty mask
   not honored), not the feed's. Use it for effects like blur where a person,
   real or spurious, would muddy the read.

## Asserting the mask

Gate on page errors (collect `pageerror` + console `error`, filter
favicon/DevTools noise) the same as the base, then drive the effect and **Read
the screenshot** (vision):

- **Working mask:** the person is kept (sharp, full silhouette) and the
  background is replaced (image effect) or blurred (blur effect).
- **Segmentation fell through:** the frame is unchanged, or the WHOLE frame got
  the effect (no stencil). Check the network panel/console: web MediaPipe
  typically loads from a CDN, so an offline run or a strict CSP kills it.
- **Empty mask:** the person vanishes into the background layer.
- **Halo / ragged edges:** real signal, not a harness bug; this rig is how you
  tune the app's threshold/hardness controls. Iterate the controls and re-Read.

A static fixture **cannot test temporal stability** (flicker, edge crawl); for
that, encode a moving subject: `ffmpeg -i subject.mp4 -t 5 -r 15 -pix_fmt
yuv420p -vf scale=640:480 /tmp/subject.y4m` (same loop behavior).

## Serving an exported static site

Use the base's serving recipe (playwright-harness, "Serving an exported static
site"). The camera-specific trap: a pre-rendered page can look alive while its
entry JS 404s and the camera is never requested, so a camera that never starts on
the deployed site IS that bug until proven otherwise.

## GPU note (delta)

WASM segmentation survives SwiftShader, so green-ball and person modes work
headless with no GPU flags. Only HEAVY generative-shader layers need the base's
ANGLE relaunch (`--use-gl=angle --use-angle=gl`); see playwright-harness, "WebGL /
GPU caveat".

## Scope

- **CAN validate:** getUserMedia wiring, effect pipeline, mask shape,
  compositing, per-effect uniforms, threshold/hardness tuning by vision, the
  deployed site itself (point `TARGET_URL` at production; no install needed).
- **CANNOT validate:** real FPS/perf, real-camera noise/exposure behavior,
  Safari/Firefox capability fallbacks (the fake-capture flags are
  Chromium-only), temporal mask stability from a still fixture.

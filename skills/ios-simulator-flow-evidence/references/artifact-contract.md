---
title: Artifact contract
summary: the directory layout, names, and formats this skill emits, the stable seam the external GitHub-presentation skill consumes
status: complete
sources:
  - "formats are the capture tools' outputs: PNG (axe screenshot / simctl io screenshot), MP4 (axe record-video), MOV (simctl recordVideo); the layout and naming below are conventions this skill defines"
---

# Artifact contract

Reference for **ios-simulator-flow-evidence**. This skill produces a **flow-evidence bundle**:
a directory with a known shape that the separate **prove-work-on-github** skill
consumes. The bundle is the seam between the two; keep it stable so the presentation side does
not break.

## The bundle layout

```
<flow-name>/
  manifest.json          # the index; see references/flow-manifest.md
  screenshots/
    01-launch.png        # zero-padded step index + state label
    02-signed-in.png
  video/
    flow.mp4             # or flow.mov; optional, present only if recorded
```

- **`<flow-name>/`**: one directory per flow, named for the flow (kebab-case), not for a date
  or a run id.
- **`manifest.json`**: required; the machine-readable index tying steps to artifacts.
- **`screenshots/`**: the per-step PNGs (`references/screenshots.md`), named `NN-label.png`.
- **`video/`**: optional; the MP4 or MOV (`references/video.md`). A GIF appears here only if a
  converter was available to produce one.

## The formats are fixed

- Screenshots are **PNG** (`axe screenshot` emits PNG; `simctl io screenshot` defaults to
  PNG, with other formats available via `--type`). This skill fixes PNG as the convention.
- Video is **MP4** (`axe record-video`) or **MOV** (`simctl recordVideo`).
- The manifest is **JSON** with the shape in `references/flow-manifest.md`.

These come from the capture tools; the layout, the directory names, and the `NN-label`
screenshot naming are conventions this skill defines, so that a consumer can find every part
of a bundle without being told.

## This skill produces; it does not publish

Producing a bundle to this contract is the whole job. Uploading it, embedding it in a PR, or
rendering it is the separate **prove-work-on-github** skill's job. Do not reach across
that seam; emit the bundle and stop.

## See also

- `references/flow-manifest.md`: the `manifest.json` schema.
- `references/screenshots.md`: the PNG sequence and its naming.
- `references/video.md`: the MP4 / MOV recording and the GIF caveat.

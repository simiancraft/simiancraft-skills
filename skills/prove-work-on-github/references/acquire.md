---
name: acquire
description: >-
  How to capture the artifacts the scope tags call for: resolving the repo's release
  branch, the per-scope capture approach, and the nearby harness skills used to drive
  browsers, mobile simulators, and cameras.
role: lifecycle-stage
stage: 2
---

# Acquire

Given the scope tags from stage 1, capture the artifacts. Acquisition leans on nearby
harness skills; this skill does not reinvent them.

## Resolve the release branch first

Several later steps target the repo's default/release branch, and it is **not** assumed to
be `main`. Resolve it:

```sh
gh repo view --json defaultBranchRef -q .defaultBranchRef.name
```

It may be `master` (older repos), `main`, or project-chosen (for example `preview`). The
anti-merge protection (stage 3) targets whatever this resolves to.

## Capture per scope

Each scope tag implies a capture method.

> TODO: per-scope capture recipes (db dump, over-the-wire capture, browser/mobile driving,
> design/flow capture), each producing an artifact plus its manifest entry.

## Nearby harness skills (acquisition tools)

Proof may need these other skills, and that is fine. Reference them softly; degrade
gracefully if a given harness is not present in the environment.

| Need | Skill |
|------|-------|
| Drive a real browser headlessly; screenshot; collect page errors | `playwright-harness` |
| Capture an animated GIF of web content | `playwright-gif-capture` |
| Put a real person in front of a webcam for segmentation/camera effects | `playwright-camera-mask-testing` |
| Drive an Android app in a headless emulator | `android-emulator-harness` |
| Camera/segmentation testing on the Android emulator | `android-emulator-mask-testing` |
| iOS simulator capture | (on-machine Xcode tooling) |

## Consumes / produces

- Consumes: scope tags (stage 1).
- Produces: raw artifacts, each tagged with a draft manifest entry (`artifact-manifest.md`):
  scope tags, covered paths, capture commit SHA, capture method.

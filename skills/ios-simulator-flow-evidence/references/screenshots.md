---
title: Screenshot evidence
summary: capturing one PNG per driven step and vision-verifying each as proof of a flow
status: draft
sources:
  - "axe screenshot --help (PNG output, --output) and xcrun simctl io <udid> screenshot (PNG; see ios-simulator references/capture.md for --type and --mask)"
  - https://developer.apple.com/documentation/xcode/capturing-screenshots-and-videos-from-simulator
---

# Screenshot evidence

Reference for **ios-simulator-flow-evidence**. A sequence of stills is the default, most
reviewable proof of a flow: one PNG per meaningful step, each verified to show the state it
claims. The capture mechanics are **ios-simulator** `references/capture.md`; this file is
the evidence discipline on top of them.

## One PNG per step

Drive the flow (see **ios-simulator** `references/driving.md`), and capture a still after
each step that changes the screen. Either tool writes a PNG:

```bash
axe screenshot --udid <udid> --output 01-launch.png
xcrun simctl io <udid> screenshot 02-signed-in.png
```

Both read the **device framebuffer**, so the Simulator window's size and position are
irrelevant; never resize or full-screen it to "fit" a shot (see `references/capture.md`).

## Freeze the status bar first

Before capturing, override the status bar so the clock, battery, and signal are fixed rather than
drifting between shots (the standard clean-screenshot setup): `xcrun simctl status_bar <udid>
override --time "9:41" --batteryState charged --batteryLevel 100` (see **ios-simulator**
`references/device-state.md`), and `status_bar <udid> clear` when done.

## Name shots so the sequence is the story

Use a zero-padded index plus a state label, so a directory listing reads as the flow:

```
01-launch.png
02-signed-in.png
03-detail-open.png
```

The index gives order; the label gives meaning. The manifest
(`references/flow-manifest.md`) ties each filename to the step and the assertion it proves.

## Vision-verify every shot

A screenshot is proof only once you have confirmed it shows the expected state. After each
capture, look at the PNG and check the concrete thing the step was supposed to produce (the
right screen, the expected row, the success toast); do not assume the tap landed. A green
run with a screenshot of the wrong screen is a false pass. Record the check in the manifest's
`verified` field.

## See also

- **ios-simulator** `references/capture.md`: the framebuffer, `--type`, and `--mask`.
- **ios-simulator** `references/driving.md`: driving the steps you are capturing.
- `references/flow-manifest.md`: tying each PNG to its step and assertion.
- `references/video.md`: when a continuous recording suits the flow better than stills.
- **ios-simulator** `references/device-state.md`: status-bar overrides for deterministic shots.

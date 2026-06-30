---
title: Capturing the screen
summary: take a screenshot with simctl or AXe, read its pixel dimensions, and use the device framebuffer as a window-independent coordinate space
status: draft
sources:
  - "xcrun simctl help io (screenshot operation, flags, formats)"
  - "axe screenshot --help (AXe screenshot subcommand)"
  - "man sips (read image pixel dimensions; ships with macOS)"
---

# Capturing the screen

Reference for **ios-simulator**. Screenshots only; recording video is evidence and
lives in **ios-simulator-flow-evidence** `references/video.md`.

## Why the screenshot is window-independent

A screenshot is the device's **framebuffer**, not a grab of the
on-screen window. Its dimensions are fixed by the device (e.g. an iPhone 16 Pro is
1206 x 2622 px; device pixel sizes come from Apple's specs, see `lifecycle.md`) no
matter how large, small, or off-screen the Simulator window is, and whether it is
full-screen or not. So a target's position in the screenshot is a stable **device
fraction**; you never need to resize or full-screen the window to reason about
coordinates. (Turning that fraction into a device point uses the scale derived in
`lifecycle.md`.)

## Take a screenshot

```bash
xcrun simctl io booted screenshot screenshot.png        # PNG to a file
xcrun simctl io booted screenshot -                     # PNG to stdout
```

`screenshot` accepts `--type=<png|tiff|bmp|gif|jpeg>` (default `png`),
`--display=<internal|external>` (default `internal`), and, for non-rectangular
displays, `--mask=<ignored|alpha|black>` (`ignored` saves the unmasked framebuffer,
`alpha` uses the mask as premultiplied alpha, `black` renders the mask black).

AXe captures the same buffer and is convenient when you are already driving with it:

```bash
axe screenshot --udid <udid> --output screenshot.png
```

With no `--output`, AXe writes `Simulator Screenshot - <device name> - <timestamp>.png`
to the current directory.

## Read the pixel dimensions

`sips` (ships with macOS) reports an image's pixel size, which you need to compute
the device scale (see `lifecycle.md`):

```bash
sips -g pixelWidth -g pixelHeight screenshot.png
```

## Verify with vision

A screenshot is raw data, not proof. After capturing, open the PNG and confirm by
vision that the expected screen rendered (right screen, the change visible, no error
overlay) before treating it as evidence. Packaging screenshots as artifacts lives in
**ios-simulator-flow-evidence** `references/screenshots.md`.

## See also

- `lifecycle.md`, deriving the device scale from a screenshot's pixel width.
- `driving.md`, acting on what the screenshot shows (tap/type via AXe).
- **ios-simulator-flow-evidence** `references/video.md`, recording the screen instead
  of capturing stills.
- **ios-simulator-flow-evidence** `references/screenshots.md`, packaging screenshots as
  flow artifacts.

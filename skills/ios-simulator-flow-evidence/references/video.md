---
title: Video evidence
summary: recording a flow to MP4 or MOV (simctl recordVideo with documented start/stop signals, or AXe record-video), and the GIF post-process and its external dependency
status: complete
sources:
  - "xcrun simctl io <udid> recordVideo: QuickTime .mov; --codec h264|hevc (default hevc), --display, --mask, --force; writes 'Recording started' to stderr at the first frame; SIGINT stops and finalizes (from `xcrun simctl io` help)"
  - "axe record-video --help: MP4 (H.264); --fps 1-30 (default 10), --quality 1-100 (default 80), --scale 0.1-1.0, --output"
  - https://developer.apple.com/documentation/xcode/capturing-screenshots-and-videos-from-simulator
  - "GIF conversion needs ffmpeg or gifski, external tools that are not part of this toolchain; confirm the invocation against your installed version"
---

# Video evidence

Reference for **ios-simulator-flow-evidence**. A continuous recording suits a flow whose
proof is motion (a transition, a gesture, a loading sequence) rather than discrete states.
The native outputs are **MP4** (AXe) and **MOV** (simctl); an animated **GIF is not native**
and needs a separate tool (below).

## simctl recordVideo: the scriptable recorder

`xcrun simctl io <udid> recordVideo` records to a QuickTime `.mov`. It is the recorder with
**documented start and stop signals**, which is what makes it scriptable: it writes
`Recording started` to stderr once the first frame is processed, and a `SIGINT` stops it and
finalizes the file. Options: `--codec h264|hevc` (default `hevc`), `--display`, `--mask`, and
`--force` to overwrite.

```bash
xcrun simctl io <udid> recordVideo --codec h264 flow.mov 2>rec.err &
rec=$!
until grep -q "Recording started" rec.err; do :; done   # wait for the first frame
# ... drive the flow (see ios-simulator references/driving.md) ...
kill -INT "$rec"        # SIGINT: stop recording
wait "$rec"             # simctl finalizes the .mov on exit
```

Use `h264` when the artifact must play everywhere; `hevc` (the default) is smaller but less
universally supported by viewers and downstream tools.

## AXe record-video: MP4 with frame and quality control

`axe record-video --udid <udid>` writes an **MP4 (H.264)** and exposes `--fps` (1-30, default
10), `--quality` (1-100, default 80), `--scale` (0.1-1.0), and `--output`. Reach for it when
you want a smaller MP4 by dropping fps or scale, or a higher-quality capture. When you need a
scripted, signal-driven start and stop, prefer `simctl recordVideo`, whose stop semantics are
documented above.

## AXe stream-video: a live frame stream

`axe stream-video --udid <udid>` streams frames to stdout instead of writing a file: `--format
mjpeg|raw|ffmpeg|bgra` (default `mjpeg`), `--fps` (1-30, default 10), `--quality` (1-100, default
80), and `--scale` (0.1-1.0). Reach for it to watch a flow live or pipe frames into another tool
(for example `ffmpeg`); for a finalized evidence artifact you attach to a PR, record to a file
instead.

## GIF: a post-process, not a native output

No simulator capture tool emits an animated GIF; AXe produces MP4, simctl produces MOV, and
both screenshot tools produce PNG. To deliver a GIF you must convert the recording with a
**separate tool that may not be installed** (`ffmpeg` or `gifski`); `sips` ships with macOS
but only handles still images, not animated GIF. The standard `ffmpeg` two-pass palette
conversion is:

```bash
ffmpeg -i flow.mov -vf "fps=10,scale=480:-1:flags=lanczos,palettegen" palette.png
ffmpeg -i flow.mov -i palette.png -lavfi "fps=10,scale=480:-1:flags=lanczos[x];[x][1:v]paletteuse" flow.gif
```

Confirm the invocation against your installed `ffmpeg`; flags drift across versions. **If no
converter is available, deliver the MP4 or MOV, not a GIF, and say so in the manifest.** Do
not claim a GIF you could not produce.

## See also

- **ios-simulator** `references/driving.md`: driving the flow you are recording.
- **ios-simulator** `references/capture.md`: the device framebuffer (why window state is moot).
- `references/screenshots.md`: a still sequence when discrete states are the proof.
- `references/flow-manifest.md`: recording the video path and any device-only gaps.

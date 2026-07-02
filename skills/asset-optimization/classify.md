---
title: Classify
summary: determine an asset's kind from a file before routing it to an executor, by extension then by content probe, resolving the ambiguous cases (still vs animated, vector PDF vs scanned PDF, SVG with embedded raster)
status: draft
---

# Classify

The dispatch in [`SKILL.md`](SKILL.md) routes by **kind**, but a file on disk does not announce its kind
reliably: extensions lie, and containers hold more than one thing. Classify by extension first, confirm
by content, then resolve the known ambiguities before routing.

## First pass: extension

| Kind | Extensions |
|------|------------|
| raster | `.png .jpg .jpeg .webp .avif .jxl .tif .tiff .bmp .heic .heif` |
| vector | `.svg` |
| animation | `.gif` (and animated `.webp` / `.apng`, see below) |
| video | `.mp4 .mov .webm .mkv .m4v .avi` |
| audio | `.wav .aiff .aif .mp3 .m4a .aac .opus .ogg .flac` |
| model | `.glb .gltf` |
| document | `.pdf` |
| font | `.ttf .otf .woff .woff2` |

## Second pass: confirm by content (the extension can lie)

```sh
file --mime-type -b IN            # magic-byte type, ignores the extension
identify -format '%m %n\n' IN | head -1   # format + frame count (identify prints per frame; take the first)
ffprobe -v error -show_entries stream=codec_type -of csv=p=0 IN   # audio-only vs has video
```

## Ambiguities to resolve before routing

- **Still vs animated.** A `.webp`, `.png` (APNG), `.avif`, or `.gif` may be either. `identify -format '%n'`
  (as `identify -format '%n\n' IN | head -1`) returns the frame count (`avifdec --info` for AVIF): more
  than one frame is **animation**, exactly one is **raster**. A single-frame GIF is raster.
- **PDF: vector vs scanned raster.** A scanned PDF is raster pages wrapped in a container; it stays
  `document` but optimizes through the raster path (see `executors/document/procedure.md`).
- **SVG with an embedded raster** (`<image>` base64). It is not really vector; see
  `executors/vector/procedure.md`.
- **A GIF that should be a video.** Classification says `animation`; the redirect in
  `executors/animation/procedure.md` may then send it to `video`. Classify first, redirect second.

When the content probe disagrees with the extension, the content wins.

## Not yet a kind

Deliberately out of scope for now (log and skip, do not guess): Lottie or JSON animations, ICO favicons,
office documents (docx, pptx), USDZ or AR models, and raw camera formats. Each is a candidate future
kind; add one through [`AGENTS.md`](AGENTS.md) when it earns its place.

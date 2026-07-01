---
title: Animation (GIF, animated WebP) - procedure
status: draft
sources:
  - "tools: ../../tools.md (Animation). Curated commands: cookbook.md."
---

# Animation: procedure

A short, looping sequence of frames. GIF is the legacy default but is palette-limited (256 colors)
and heavy; the biggest wins here are usually a format change, not a within-GIF tweak.

## Prerequisites

From the manifest ([`../../tools.md`](../../tools.md)): gifsicle (optimize existing GIF), gifski
(high-quality GIF from frames), ffmpeg palettegen/paletteuse (video to GIF), gif2webp / img2webp +
webpinfo (animated WebP); oxipng + pngcheck (optimize and validate APNG).

## Steps

1. **Inspect:** frame count, dimensions, fps, palette size, total duration.
2. **Decide format for the target** ([`targets.md`](targets.md)): GIF is rarely the answer on the web.
3. **Optimize or convert** ([`cookbook.md`](cookbook.md)): within-GIF (gifsicle) or a format change
   (animated WebP, or video for anything non-trivial).
4. **Validate:** webpinfo for animated WebP; play-through spot check for GIF.
5. **Keep only if smaller AND valid;** record in [`expectations.md`](expectations.md).

## When another kind is preferred

- **The GIF is long, large, or photographic** -> convert to **video** (H.264 MP4 or WebM);
  [`../video/procedure.md`](../video/procedure.md). The canonical "GIF too long? make it a video" redirect.
- **A single effective frame** (or barely moves) -> treat as a still, [`../raster/procedure.md`](../raster/procedure.md).

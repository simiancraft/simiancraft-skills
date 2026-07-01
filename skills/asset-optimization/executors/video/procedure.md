---
title: Video (MP4, WebM, MOV) - procedure
status: draft
sources:
  - "tools: ../../tools.md (Video). Curated commands: cookbook.md."
---

# Video: procedure

A moving-image asset. Optimization is transcoding to an efficient codec at a quality target, plus
container hygiene (faststart) and dimension/frame-rate fit.

## Prerequisites

From the manifest ([`../../tools.md`](../../tools.md)): ffmpeg + ffprobe (workhorse + inspect),
encoders x264 / x265 / SVT-AV1 / rav1e / libaom, HandBrakeCLI (presets), MP4Box / MKVToolNix / Bento4
/ AtomicParsley (containers, no re-encode), libvmaf and MediaInfo (quality + reports).

## Steps

1. **Inspect** (ffprobe): codec, bitrate, duration, dimensions, fps, pixel format, color transfer, streams.
2. **HDR branch:** if `color_transfer` is PQ/HLG, decide by target: preserve HDR when the target supports it; tonemap to SDR (a deliberate lossy conversion, see `cookbook.md`) only when SDR delivery is explicitly chosen.
3. **Pick codec + quality** for the target ([`targets.md`](targets.md)); prefer CRF over fixed bitrate.
4. **Encode** ([`cookbook.md`](cookbook.md)); for a size ceiling, use two-pass target-bitrate.
5. **Validate + gate:** ffprobe the output; VMAF-gate quality rather than trusting a CRF label.
6. **Keep only if smaller AND valid;** record in [`expectations.md`](expectations.md).

## When another kind is preferred

- **Very short, low-color loop** -> animated WebP or optimized GIF; [`../animation/procedure.md`](../animation/procedure.md).
- **Only a still is needed** (thumbnail, inline preview) -> extract a poster, [`../raster/procedure.md`](../raster/procedure.md).

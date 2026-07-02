---
title: Raster (bitmap) stills - procedure
status: draft
sources:
  - "tools: ../../tools.md (Raster sections). Curated commands: cookbook.md."
---

# Raster: procedure

A single-frame raster image: a grid of pixels. Format and lossy-vs-lossless are decided by content
(photographic vs flat, alpha vs none) and by the target ([`../../surface.md`](../../surface.md), then
[`targets.md`](targets.md)).

## Prerequisites

From the manifest ([`../../tools.md`](../../tools.md)):
- **Orchestrate / inspect:** ImageMagick (`convert` / `identify` / `compare`), libvips, ExifTool.
- **PNG:** oxipng (lossless default), pngquant (lossy palette), pngcheck (validate); optipng, zopflipng optional.
- **JPEG:** jpegli/`cjpegli` or MozJPEG `cjpeg`, jpegtran, jpegoptim.
- **WebP / AVIF / JXL:** cwebp/dwebp/webpinfo, avifenc/avifdec, cjxl/djxl.
- **HEIC / other input:** libheif (`heif-convert`) to decode an Apple HEIC or HEIF source to PNG/JPEG before re-encoding.

Detect first (`command -v oxipng`); acquire if missing; prefer the modern tool (oxipng over optipng).

## Steps

1. **Inspect:** `identify` and ExifTool for dimensions, alpha, color profile, bit depth, and **EXIF orientation**.
2. **Fidelity intent + content class:** photographic vs flat, alpha vs none.
3. **Format for the target:** [`targets.md`](targets.md).
4. **Encode / optimize** with the format tool: [`cookbook.md`](cookbook.md).
5. **Validate:** pngcheck / webpinfo / `avifdec --info` or `djxl`; `compare` if fidelity matters.
6. **Keep only if smaller AND valid;** record before/after in [`expectations.md`](expectations.md).

> Two silent footguns. Stripping EXIF can drop the **orientation** tag and rotate the image, so bake
> rotation in first (`convert -auto-orient`) or keep the tag. And a wide-gamut **Display-P3** source shown
> on an sRGB-assuming surface shifts color, so convert to sRGB for the web (and embed or assume sRGB).

## When another kind is preferred

- **Photographic content, no alpha** -> do not keep PNG-24; encode JPEG, WebP, or AVIF (still raster; see `targets.md`).
- **Flat art / logo / icon that is actually vector** -> [`../vector/procedure.md`](../vector/procedure.md).
- **The image is animated** -> [`../animation/procedure.md`](../animation/procedure.md).

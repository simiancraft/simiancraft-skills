---
title: Vector (SVG) - procedure
status: draft
sources:
  - "tools: ../../tools.md (Vector). Curated commands: cookbook.md."
---

# Vector: procedure

An SVG is instructions, not pixels: paths, shapes, and text that scale losslessly. Optimization is
minification (drop what does not affect rendering), not lossy compression.

## Prerequisites

From the manifest ([`../../tools.md`](../../tools.md)): svgo (primary), scour (alt), Inkscape CLI
(convert/rasterize), resvg or rsvg-convert (render for regression refs), potrace (bitmap to vector).

## Steps

1. **Inspect:** open the SVG; note `viewBox`, referenced ids, embedded rasters, editor metadata.
2. **Minify:** svgo `--multipass` (see [`cookbook.md`](cookbook.md)).
3. **Protect rendering:** keep `viewBox` (never `removeViewBox`); keep ids referenced by CSS/JS; keep
   title/desc that carry accessibility; round path precision only as far as the render tolerates.
4. **Validate:** render before and after with resvg or rsvg-convert and compare.
5. **Keep only if smaller AND visually identical;** record in [`expectations.md`](expectations.md).

## When another kind is preferred

- **The SVG embeds a raster** (`<image>` with base64 PNG/JPEG) -> it is not really vector; extract and
  optimize the raster in [`../raster/procedure.md`](../raster/procedure.md), or rasterize if scaling is not needed.
- **Enormous path count / photographic illustration** -> a raster (WebP/AVIF) may be smaller; compare.
- **Complex frame-by-frame animation** -> [`../animation/procedure.md`](../animation/procedure.md) or `../video/`.

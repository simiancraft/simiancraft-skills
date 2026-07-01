---
title: Vector - targets
status: draft
---

# Vector: targets

SVG renders on the web and most modern surfaces and scales losslessly, so it is usually its own best
target ([`../../surface.md`](../../surface.md)). A few caveats:

- **A surface that cannot render SVG** (some email clients, certain native image contexts) -> ship a
  rasterized PNG/WebP fallback at the needed size; see [`../raster/procedure.md`](../raster/procedure.md).
- **GitHub inline** renders SVG in Markdown but sanitizes it (scripts and interactivity stripped); do
  not rely on embedded script or external references.
- **Transport compression.** Prefer server gzip or brotli over shipping a `.svgz`; a gzipped SVG on the
  wire is smaller without a new file type to manage.

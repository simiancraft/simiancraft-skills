---
title: Raster - size expectations
status: draft
---

# Raster: size expectations

Data-driven. Populate from real runs (spine loop step 8). Do not record an unmeasured number.

| Source | Tool + settings | Before | After | Savings | Fidelity | Notes |
|--------|-----------------|--------|-------|---------|----------|-------|
| _e.g. UI screenshot, PNG-24_ | `oxipng -o max` | _TBD_ | _TBD_ | _TBD_ | lossless | record measured only |
| _e.g. photo, PNG-24_ | `cwebp -q 82` | _TBD_ | _TBD_ | _TBD_ | lossy | |
| … | | | | | | |

Qualitative expectation (confirm with data): a lossless PNG pass changes no pixels and its savings
depend on how the PNG was written; a photographic PNG-24 re-encoded to JPEG/WebP/AVIF shrinks far more,
because PNG is the wrong container for photos.

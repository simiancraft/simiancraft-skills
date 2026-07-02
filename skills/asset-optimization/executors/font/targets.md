---
title: Font - targets
status: draft
---

# Font: targets

Font format is largely fixed (WOFF2 for the web), so the surface picks a **format tier and subset
depth**. Once the surface is known ([`../../surface.md`](../../surface.md)):

| Surface | Preferred | Notes |
|---------|-----------|-------|
| Web (2026) | **WOFF2 only** | universal support; drop TTF/OTF/EOT/WOFF1 fallbacks |
| Web, legacy-browser support | WOFF2 + WOFF1 | only if analytics show pre-2016 browsers |
| App or desktop bundle | TTF or OTF | platform toolchains expect sfnt, not WOFF2 |
| Design handoff | keep the source TTF/OTF | do not subset a source |

A **variable font** replaces several static weights with one file; prefer it when the design uses a
range of weights, and pin or drop unused axes with `fonttools varLib.instancer` (see `cookbook.md`)
when some are unused.

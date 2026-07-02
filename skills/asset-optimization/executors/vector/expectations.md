---
title: Vector - size expectations
status: draft
---

# Vector: size expectations

Data-driven. Populate from real runs. Do not record an unmeasured number.

| Source | Tool + settings | Before | After | Savings | Notes |
|--------|-----------------|--------|-------|---------|-------|
| _e.g. Figma-exported icon_ | `svgo --multipass` | _TBD_ | _TBD_ | _TBD_ | editor cruft dominates |
| … | | | | | |

Qualitative expectation (confirm with data): SVGs exported from design tools carry heavy editor
metadata and over-precise coordinates, so the first minify pass often removes a lot; a hand-authored,
already-tight SVG has little left to give.

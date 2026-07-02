---
title: Document - size expectations
status: draft
---

# Document: size expectations

Data-driven. Populate from real runs. Do not record an unmeasured number.

| Source | Tool + settings | Before | After | Savings | Fidelity | Notes |
|--------|-----------------|--------|-------|---------|----------|-------|
| _e.g. image-heavy report_ | `gs /ebook` | _TBD_ | _TBD_ | _TBD_ | lossy | images downsampled |
| _same source_ | `qpdf --recompress-flate` | _TBD_ | _TBD_ | _TBD_ | lossless | structure only |
| … | | | | | | |

Qualitative expectation (confirm with data): qpdf's content-preserving pass gives modest savings; the
large reductions come from Ghostscript downsampling image-heavy PDFs, at the cost of image fidelity.

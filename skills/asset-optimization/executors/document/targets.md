---
title: Document - targets
status: draft
---

# Document: targets

Once the surface is known ([`../../surface.md`](../../surface.md)), the surface sets how far you may
downsample:

| Surface | Preferred | Notes |
|---------|-----------|-------|
| Web download / email | Ghostscript **/screen** or **/ebook** | smallest; images downsampled to 72-150 dpi |
| On-screen reading, retained quality | Ghostscript **/printer**, or qpdf only | 300 dpi, less aggressive |
| Print master / contract / legal | **qpdf only** (content-preserving) | never downsample a master |

Fidelity intent gates the tool here more than the surface does: a lossless-required PDF gets qpdf and
nothing more, whatever the surface.

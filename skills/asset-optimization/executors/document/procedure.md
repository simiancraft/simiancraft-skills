---
title: Document (PDF) - procedure
status: draft
sources:
  - "tools: ../../tools.md (Document). Curated commands: cookbook.md."
---

# Document: procedure

A PDF is a container of vector and raster content plus fonts. Two very different optimizations apply:
**content-preserving** structural cleanup (qpdf: recompress streams, linearize) that changes no
rendered content, and **lossy** rewriting (Ghostscript: downsample embedded images, subset fonts) that
materially alters the document. Choose by fidelity intent.

## Prerequisites

From the manifest ([`../../tools.md`](../../tools.md)): qpdf (content-preserving), Ghostscript
(lossy rewrite/downsample), Inkscape (per-graphic conversion).

## Refuse gate (check before rewriting)

Do NOT rewrite a PDF that is any of these; report why and skip it, because a rewrite reorganizes the
file and breaks the guarantee:
- **digitally signed or certified** (a byte-range signature does not survive a rewrite);
- **PDF/A** or otherwise archival;
- **encrypted or permission-locked**;
- carrying **forms (AcroForm/XFA), attachments, or important annotations**.
Detect them first (see [`cookbook.md`](cookbook.md)).

## Steps

1. **Inspect:** page count, embedded image resolution, fonts, current size.
2. **Fidelity intent:** lossless-required (contract, print master) -> qpdf only; lossy-acceptable
   (web download, email) -> Ghostscript downsample is allowed.
3. **Optimize** ([`cookbook.md`](cookbook.md)).
4. **Validate:** `qpdf --check`; render pages and compare to the source; confirm forms, links, page boxes, attachments, and any signatures survived. Ghostscript can silently degrade images, so a page-through alone is not enough.
5. **Keep only if smaller AND the content a reader needs is intact;** record in [`expectations.md`](expectations.md).

## When another kind is preferred

- **A single-page vector graphic wrapped in a PDF** -> it may belong as an SVG; [`../vector/procedure.md`](../vector/procedure.md).
- **A scanned-image PDF** is really raster pages; optimize the images ([`../raster/procedure.md`](../raster/procedure.md)) before repacking.

---
title: Document - cookbook
status: draft
---

# Document: cookbook

Entries follow the rubric in [`../../cookbook.md`](../../cookbook.md). Commands unverified until measured.

### Detect blockers before rewriting (no change)
**For** deciding whether a PDF is safe to rewrite at all (see the refuse gate in `procedure.md`). **Validate** n/a. **Gains** none.
```sh
qpdf --show-encryption IN.pdf                       # encryption and permission flags
exiftool -a -PDF:all IN.pdf | grep -iE 'signature|pdf-?a|form|encrypt'   # signatures, PDF/A, forms
```
> If any is present, skip the file: a rewrite breaks the signature, archival conformance, or form/permission state. (`pdfinfo` or `mutool info` report the same.)

### Structurally optimize a PDF (lossless)
**For** a master, contract, or any PDF whose rendered content must not change. **Validate** reopen and page through. **Gains** est modest.
```sh
qpdf --linearize --object-streams=generate --recompress-flate --compression-level=9 IN.pdf OUT.pdf
```

### Downsample an image-heavy PDF (lossy)
**For** a web download or email attachment where image fidelity can drop. **Validate** reopen; check image legibility. **Gains** est large on image-heavy PDFs.
```sh
gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.7 -dPDFSETTINGS=/ebook -dNOPAUSE -dBATCH -dQUIET -sOutputFile=OUT.pdf IN.pdf
```
> Caveat: Ghostscript materially alters the document (downsamples images, subsets fonts); never treat it
> as lossless. For a master use qpdf only. PDFSETTINGS: /screen 72dpi, /ebook 150dpi, /printer 300dpi, /prepress quality.

### Extract and optimize a scanned PDF's pages (lossy)
**For** a scanned-image PDF that is really raster pages. **Validate** reopen. **Gains** est large.
```sh
# rasterize to images, optimize each (see raster), then repack
gs -sDEVICE=png16m -r150 -o page-%03d.png IN.pdf
```
> See also [`../raster/cookbook.md`](../raster/cookbook.md) for the per-page optimization.

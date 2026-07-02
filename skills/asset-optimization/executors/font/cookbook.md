---
title: Font - cookbook
status: draft
---

# Font: cookbook

Entries follow the rubric in [`../../cookbook.md`](../../cookbook.md). The Latin-subset `pyftsubset --flavor=woff2` path is smoke-tested (see [`expectations.md`](expectations.md)); the rest are unverified until measured.

### Convert a font to WOFF2 (lossless)
**For** shipping an existing full font to the web without dropping glyphs. **Validate** `fonttools ttLib IN` parses; load in a browser. **Gains** est ~30-50% vs TTF/OTF (confirm).
```sh
woff2_compress IN.ttf                                          # writes IN.woff2; byte-faithful full-font conversion
# fonttools variant (re-subsets everything; may drop default tables, so not byte-faithful):
pyftsubset IN.ttf --output-file=OUT.woff2 --flavor=woff2 --glyphs='*' --layout-features='*'
```
> Use `woff2_compress` for a truly complete font; the `pyftsubset --glyphs='*'` path still runs the subsetter's default table pruning, so it is not strictly lossless.

### Discover the glyphs a site actually uses (no change)
**For** finding the character set before subsetting. **Validate** n/a. **Gains** none (analysis).
```sh
glyphhanger ./dist --subset=fonts/*.ttf --formats=woff2
```

### Subset a font to a character set (lossy)
**For** a web font used for a known, limited set of characters. **Validate** render the needed text. **Gains** est large; unused glyphs dominate big fonts.
```sh
pyftsubset IN.ttf --unicodes="U+0000-00FF,U+2018-2019,U+201C-201D" --flavor=woff2 --output-file=OUT.woff2
# or drive it from the actual copy:
pyftsubset IN.ttf --text-file=used-text.txt --flavor=woff2 --output-file=OUT.woff2
```
> Caveat: subsetting drops glyphs; a character you cut later renders as fallback or tofu. Keep the full font as the source.

### Drop hinting and unused tables for extra bytes (lossy)
**For** squeezing a web font where native hinting is not needed. **Validate** render across target OSes. **Gains** est moderate.
```sh
pyftsubset IN.ttf --unicodes="*" --no-hinting --desubroutinize --flavor=woff2 --output-file=OUT.woff2
```

### Pin or drop unused axes of a variable font (lossy)
**For** a variable font where the design uses only part of an axis range. **Validate** render each used instance. **Gains** est moderate.
```sh
fonttools varLib.instancer IN.ttf wght=400:700 --output=OUT.ttf     # keep the 400-700 weight range; pin or drop other axes
```
> Note: `pyftsubset` cannot reduce axes; `varLib.instancer` is the tool for that.

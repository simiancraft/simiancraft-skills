---
title: Font (TTF, OTF, WOFF, WOFF2) - procedure
status: draft
sources:
  - "tools: ../../tools.md (Font). Curated commands: cookbook.md."
---

# Font: procedure

A font file (TTF, OTF, WOFF, WOFF2) is glyph outlines plus tables (hinting, features, kerning). Two
wins: **format** (WOFF2 compresses the sfnt container) and **subsetting** (drop glyphs the project never
uses). Subsetting is usually the larger by far, and it is lossy.

## Prerequisites

From the manifest ([`../../tools.md`](../../tools.md)): fonttools / pyftsubset (subset and convert),
woff2 tools (`woff2_compress`), glyphhanger (discover used glyphs), fontforge (inspect or convert fallback).

## Steps

1. **Inspect:** family, glyph count, tables, whether it is variable, current size.
2. **Fidelity intent:** subsetting is lossy (it drops glyphs); a full-coverage delivery font is
   lossless-only (WOFF2 conversion, no glyph drop).
3. **Discover the used glyphs** (glyphhanger over the built site, or a known charset) when subsetting.
4. **Subset and convert** to WOFF2 ([`cookbook.md`](cookbook.md)).
5. **Validate:** the output parses (`fonttools ttLib`), and the subset still renders the needed text.
6. **Keep only if smaller AND the needed glyphs render;** record in [`expectations.md`](expectations.md).

## When another kind is preferred

- **An icon font used for a handful of glyphs** is usually better as inline SVGs or an SVG sprite; see
  [`../vector/procedure.md`](../vector/procedure.md). Subset the font only if it must stay a font.

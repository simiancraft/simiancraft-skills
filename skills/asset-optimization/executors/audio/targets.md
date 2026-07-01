---
title: Audio - targets
status: draft
---

# Audio: targets

Audio format is largely fixed, so the surface picks a **codec and bitrate** (a reach axis) rather than
a format. Once the surface is known ([`../../surface.md`](../../surface.md)):

| Surface | Preferred | Fallback |
|---------|-----------|----------|
| Web / app (2026) | **Opus** | AAC where Opus is unsupported |
| Maximum compatibility (embeds, old players) | **AAC** or **MP3** | none |

Opus wins on quality-per-byte where it is supported; fall back to AAC or MP3 only for reach.

Bitrate starting points (confirm by ear and by size):

| Use case | AAC | MP3 | Opus |
|----------|-----|-----|------|
| Speech / podcast | 64-96k | 96-128k | 48-64k |
| Music (standard) | 128-192k | 192-256k | 96-128k |
| Music (high) | 256-320k | 320k | 160-256k |

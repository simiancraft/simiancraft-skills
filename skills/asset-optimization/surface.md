---
title: Surface assessment
summary: determine which surface an asset will be presented on (web, GitHub inline, mobile app bundle, Apple-native, print) by reading the codebase or asking when vague; each executor's targets.md maps that surface to its own output
status: draft
sources:
  - "GitHub docs: attaching images and video to issues and pull requests (supported inline types)"
  - "caniuse.com format support tables (WebP, AVIF, HEIC, JXL, Opus) as of the run date"
---

# Surface assessment

Format choice is decided by the **surface area of presentation**, not the source format: the best
output is the smallest one the consumer can actually render. That decision has two halves, and this
file owns only the kind-agnostic one, **which surface**. The kind-specific half, **what output for
this kind on that surface**, lives in each executor's `targets.md` (raster, vector, animation, video,
audio, model, document, font), next to the tool that emits it. For raster, animation, and video the
surface selects the format; for vector, audio, font, document, and model the format is largely fixed
and `targets.md` chooses the tuning depth instead. Determine the surface once here; then read the
`targets.md` of the kind you are optimizing.

## Determine the surface

1. **Read the codebase.** Framework and config signal where the asset is shown:
   - Expo / React Native (`app.config.*`, `metro.config.js`) -> **mobile app bundle**.
   - Next / Vite / a web app, `<picture>` or `<img>` usage -> **web**.
   - A README, a PR body, an issue comment, `docs/` -> **GitHub inline** (or a static docs site).
   - Native iOS/macOS asset catalogs (`.xcassets`) -> **Apple-native**.
   - A print or design deliverable (PDF, high-DPI export) -> **print / design master**.
2. **Ask when too vague.** If the surface cannot be inferred, ask one plain question ("where does
   this get shown: a website, the app, a GitHub README, or something else?") rather than guessing.

## The surfaces

Each executor's `targets.md` maps the relevant surfaces to its output:

| Surface | What it renders well | The reach constraint |
|---------|----------------------|----------------------|
| **Web (2026)** | WebP everywhere, AVIF widely, Opus in modern browsers | formats with thin browser support (HEIC, JXL) |
| **GitHub inline** (README, PR, issue) | PNG, JPEG, GIF, WebP; MP4 upload as an inline player | HEIC, JXL, AVIF render inconsistently |
| **Mobile app bundle** (Expo/RN) | what the media stack bundles; keep it small | bundle bloat |
| **Apple-native** (iOS/macOS) | HEIC natively, plus the web set | HEIC does not travel off Apple |
| **Print / design master** | lossless masters | any lossy re-encode of a master |

**Print / design master** is the one surface that also fixes the fidelity axis: it pins fidelity to
lossless-required, so a master is never re-encoded lossy whatever else is true.

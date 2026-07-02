---
name: optimize-assets
description: >-
  Lifecycle stage 3, storage preparation: how a proof artifact is optimized before it enters the
  Evidence Locker. Defers the how of shrinking a media asset to the asset-optimization skill, and
  keeps only the proof-specific overlay: GitHub sizing, oversized-artifact routing, and
  pin-after-optimize.
role: lifecycle-stage
stage: 3
---

# Optimize Assets

Before an artifact enters the Evidence Locker, this stage shrinks it to the smallest bytes that
still carry the proof. Optimizing a media asset is the `asset-optimization` skill's job, keyed on
asset kind and on the presentation target. Use that
skill for tool selection, the fidelity pass, format conversion, and before-and-after measurement.
This file adds only what is specific to proof on GitHub.

## Proof maps onto the asset-optimization inputs

| asset-optimization input | Proof value |
|---|---|
| **Fidelity intent** | A design-fidelity artifact (a pixel-perfect design pass, a visual diff) is lossless-required. A walkthrough, a flow capture, or a delivery screenshot is lossy-acceptable. When compression would change what the evidence shows, it is lossless-required by definition. |
| **Presentation target** | The GitHub pull request or issue comment. That surface selects web-friendly formats (WebP or AVIF over PNG when visually identical and smaller) and inline-render sizing. |
| **Asset kind** | Whatever `acquire.md` captured: a screenshot or design pass is raster, a walkthrough is animation or video, and so on. |

## The proof-specific overlay

- **GitHub size gates.** Keep each artifact under GitHub's per-file push limits: a warning at 50 MiB
  and a hard block at 100 MiB. Downscale a full-screen or 4K capture to the size it renders at
  inline; a proof image rarely needs its native resolution.
- **Oversized-artifact routing.** If an artifact cannot be brought under the limit without losing the
  proof it carries (lossless-required and still too large), route that one file to a provided backend
  (S3 or similar) instead of degrading it; see `evidence-locker.md`. This is a per-artifact escape
  hatch, not a whole-locker migration.
- **Optimize before you pin.** The optimized bytes are the artifact of record: run the optimization
  pass first, then hash and pin. The SHA-pinned URL is what keeps the reference from silently
  changing; the manifest records the hash of the optimized file (never the raw capture) as the
  independent anchor a reader recomputes to verify; see `artifact-manifest.md`.

If the `asset-optimization` skill is unavailable, fall back to the smallest sensible in-format pass
(downscale, drop to a web-friendly format, and re-measure) and note that the artifact was optimized
by hand rather than by the skill.

## Consumes and produces

- Consumes: raw artifacts from `acquire.md`.
- Produces: GitHub-sized, pinned artifacts for `evidence-locker.md`, with the post-optimization
  content hash recorded in the manifest.

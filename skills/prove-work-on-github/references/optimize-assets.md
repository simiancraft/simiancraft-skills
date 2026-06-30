---
name: optimize-assets
description: >-
  Pattern 2, the asset-type strategy: keyed on artifact type, decide format conversion,
  compression, sizing, and how the asset renders inline, so artifacts stay under GitHub's
  limits and read cleanly.
role: lifecycle-stage
stage: 3
---

# Optimize Assets

Before an artifact enters the Evidence Locker it is optimized. This is **Pattern 2**: a
lookup keyed on the artifact's type that decides format, compression, dimensions, and inline
presentation. The goal is the smallest artifact that still carries the proof.

> Deep asset optimization could be split into a dedicated step; for now this file points at
> canonical tools and basic sizing constraints.

## Canonical tools (for now)

- PNG → **OptiPNG** (lossless) or convert to **WebP** when it looks identical and is smaller.
- GIF → **Gifsicle** (basic optimization).

## The per-type strategy (to specify)

| Artifact type | Typical treatment |
|---------------|-------------------|
| PNG-24 screenshot | OptiPNG; convert to WebP if visually identical and smaller |
| 4K / full-screen capture | downscale to a logically sized GitHub image |
| GIF walkthrough | Gifsicle; cap frame rate and palette |
| Video | (future) first-frame inline, click to open |
| PDF | keep only if a flatter artifact won't do |

> TODO: concrete size/dimension constraints. Principle: a proof image should never be larger
> than a fairly large web page; mobile flow walkthroughs do not need full resolution, but a
> pixel-perfect design pass does. Sizing is proof-purpose-dependent (walkthrough vs fidelity).

## The decay-tolerant rule of thumb

Optimize for "looks exactly the same to a reader judging the claim." If compression would
change what the evidence shows (a design-fidelity artifact), do not compress past fidelity.

## Consumes / produces

- Consumes: raw artifacts (`acquire.md`).
- Produces: GitHub-sized artifacts for `evidence-locker.md`, with the content hash recorded
  in the manifest after optimization (the optimized bytes are what gets pinned).

---
name: asset-optimization
description: >-
  Shrink a media asset to the smallest bytes that still serve its purpose, keyed on asset kind
  (raster, vector, animation, video, audio, model, document, font) and on where it will be presented.
  Detects and acquires the right binary from a central tool manifest, runs a lossless-or-lossy pass
  decided by fidelity intent, measures before and after, validates the output, and keeps the result
  only if it is smaller AND still valid, redirecting to a better format or a different kind when the
  source is wrong for the job (a no-alpha PNG-24 wants JPEG or WebP; an over-long GIF wants video).
  Optimizes one file or walks a whole repository. Use for "optimize/compress this image, gif, svg,
  video, audio, 3D model, or web font", "shrink a PNG", "which format should this asset be", or "make
  these assets smaller". Skip when the asset is already minimal, when the bytes must stay bit-exact for
  a reason other than size, or when a build-time plugin (a bundler image loader, expo-optimize) already
  optimizes it in the pipeline.
status: draft
sources:
  - "per-tool docs are linked once in tools.md; each executor's cookbook carries the curated commands"
---

# Asset Optimization

> The smallest asset that still serves its purpose. Measure the bytes, not the intent.

An asset is a media file whose bytes we shrink without changing what it is for. This skill is a
lookup keyed on the asset's **kind** that decides format, tool, and whether the pass may lose
information, so the file ends up as small as it can be while still doing its job on the surface it
will be presented on.

**Structure.** Each kind is an executor under `executors/<kind>/`, a folder of standardized organs:
`procedure.md` (the how-to, including prerequisites and cross-kind redirects), `cookbook.md` (curated
verbatim recipes), `targets.md` (surface to format), and `expectations.md` (measured size data). The
cross-cutting references at the root are [`tools.md`](tools.md) (the tool manifest, defined once because
one tool serves many kinds), [`surface.md`](surface.md) (which surface), [`classify.md`](classify.md) (how
to detect a file's kind), [`batch.md`](batch.md) (repository operation, originals, idempotence, report),
and [`cookbook.md`](cookbook.md) (the recipe rubric and an index of every kind's cookbook). This
two-level structure is deliberately heavier than the flat `references/` layout of the repo's other
skills, because this skill has more orthogonal axes than any sibling: kind, surface, fidelity intent,
and tool.

## Fidelity intent (decide first; it gates every tool)

| Intent | Meaning | Consequence |
|--------|---------|-------------|
| **Lossless-required** | a pixel, sample, path, or vertex is load-bearing (design fidelity, a diff, evidence) | only lossless tools; never quantize or re-encode lossy |
| **Lossy-acceptable** | the asset carries an impression, not exact bytes (walkthrough, delivery, thumbnail) | lossy tools are in play, tuned to "looks the same to the viewer who judges it" |

If compression would change what the asset is *for*, it is lossless-required by definition. Optimize
for "looks exactly the same to the person who will judge it."

## Surface decides format

The presentation surface, not the source format, decides the output. Determine the surface once
([`surface.md`](surface.md)); then each kind's `targets.md` maps that surface to its own output. For the
**alternative-format** kinds (raster, animation, video) the surface genuinely selects the format; for
the **fixed-format** kinds (vector, audio, font, document, model) the format is largely pinned and
`targets.md` instead chooses the tuning depth (dpi, subset, decoder, bitrate) on that kind's own axis.

## Detect and acquire

Executor posture: probe for the binary, install it if missing, and select the best available tool.
Tools, install hints, and their gotchas live once in [`tools.md`](tools.md); each executor's
`procedure.md` names its prerequisites and links there. Never fail because a tool is absent when it
can be acquired; never silently skip a tool and claim success. Installing a system package is a
consequential action; when a tool is missing, prefer detection and a clear ask before a global or
`sudo` install, and record what was installed.

## Measure, validate, and never regress

Record `before` and `after` bytes, and validate the output decodes and preserves what fidelity intent
requires (structure, alpha, color profile, animation, dimensions). **Keep the result only if it is
smaller AND passes validation;** otherwise keep the original. An optimization that grows the file, or
degrades a lossless-required asset, or produces a file that will not decode, is a failure. Reported
numbers are observed bytes, never estimates.

**Originals.** Write results to a new path; do not edit the source in place, and keep the original
whenever the result is not smaller and valid. In-place replacement is only safe for a same-format pass
(PNG to PNG); a format or kind redirect changes the extension, so it must emit a new file and leave
rewiring the references (`<img src>`, `url()`, imports) to the caller, never silently deleting the
source (see [`batch.md`](batch.md)).

**Idempotence.** Do not re-optimize an already-optimized asset; a second lossy pass loses quality for
no size win. In batch, skip inputs whose content hash is unchanged since the last run
([`batch.md`](batch.md)).

## Batch

Optimizing a repository is the point, not a special case. Walk the tree, skip build output and
dependency trees, classify each file ([`classify.md`](classify.md)), route it through the same per-file
decision, and emit a report. The full walk, skip-list, originals policy, idempotence guard, and report
format live in [`batch.md`](batch.md).

## Dispatch: asset kind to executor

| Kind | Members | Executor |
|------|---------|----------|
| **raster** | PNG, JPEG, WebP, AVIF, JXL (HEIC/TIFF/BMP as input) | [`executors/raster/`](executors/raster/procedure.md) |
| **vector** | SVG | [`executors/vector/`](executors/vector/procedure.md) |
| **animation** | GIF, animated WebP, APNG | [`executors/animation/`](executors/animation/procedure.md) |
| **video** | MP4/H.264, HEVC, VP9, AV1, WebM, MOV | [`executors/video/`](executors/video/procedure.md) |
| **audio** | WAV, AIFF, MP3, AAC, Opus, Ogg, FLAC | [`executors/audio/`](executors/audio/procedure.md) |
| **model** | glTF, GLB (embedded textures) | [`executors/model/`](executors/model/procedure.md) |
| **document** | PDF | [`executors/document/`](executors/document/procedure.md) |
| **font** | TTF, OTF, WOFF, WOFF2 | [`executors/font/`](executors/font/procedure.md) |

## The source kind may be wrong

The kind you were handed is not always the kind the asset should be. Each executor's `procedure.md`
ends with a redirect section: a photographic PNG-24 with no alpha belongs in raster as a JPEG or WebP,
not a PNG; a long, photographic GIF belongs in video; a rasterized icon belongs in vector; an icon font
used for a few glyphs belongs in vector. Follow the redirect before optimizing the wrong thing well.

## The loop

1. Assess the **surface** ([`surface.md`](surface.md)); ask when too vague.
2. Classify the asset's **kind** ([`classify.md`](classify.md)); follow a cross-kind redirect if the
   source is wrong for the job.
3. Pick **fidelity intent** (lossless-required vs lossy-acceptable).
4. **Inspect** the source (ffprobe / identify / MediaInfo / ExifTool) to record its starting shape.
5. **Acquire** the tool for that kind and format (`tools.md`).
6. **Run** the pass to a new output, never over the source (the kind's `procedure.md` and `cookbook.md`).
7. **Validate** the output decodes and preserves what fidelity intent requires.
8. **Keep** the result only if it is smaller AND valid; **record** before/after (this extends the
   kind's `expectations.md` with real data).

## When something is missing or wrong

This skill is a draft that grows by use. While optimizing, if you find a **command that no longer
works** (a tool changed or dropped a flag) or you discover a **recipe, tool, or kind the skill lacks**,
you may open an issue against the skill's repository (`simiancraft/simiancraft-skills`) to report it.
**Ask the user's permission first**, and only then file a terse issue: the tool and its version, the
exact command, and what failed or what is missing. Do not open an issue unprompted, and do not file a
duplicate for a gap already reported. Maintainers turn these into fixes (see [`AGENTS.md`](AGENTS.md)).

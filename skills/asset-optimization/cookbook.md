---
title: Cookbook
summary: what a recipe is in this skill, the rubric every cookbook entry follows, and an index of the per-kind cookbooks
status: draft
---

# Cookbook

A cookbook is a growing set of **recipes**: concrete, copy-paste commands for one optimization task.
Recipes live per kind in `executors/<kind>/cookbook.md`; this file defines the shared format they all
follow and indexes them. New recipes arrive by PR (see [`AGENTS.md`](AGENTS.md)).

## The entry rubric

Every entry answers the same questions, so a reader can decide whether to reach for it, run it, and
trust the result.

| Field | What it captures |
|-------|------------------|
| **Task** | one imperative line naming what the recipe does, tagged `(lossless)`, `(lossy)`, `(no change)` for an inspect or verify recipe, or a qualified variant such as `(lossy-metadata)` |
| **For** | when to reach for this over a sibling: content class, fidelity intent, target surface |
| **Command** | the verbatim command with `IN`/`OUT` or `${VAR}` placeholders; the tool is visible in it |
| **Validate** | the check that proves it worked (a decode, a structural check, a perceptual metric) |
| **Gains** | expected savings, marked **measured** (a number and its source run) or **est** (a rule of thumb); never a fabricated number |
| **Caveat** | the footgun, only when there is one (a flag that silently degrades, a lossy step, an in-place edit) |

Optional **See also** for a sibling recipe or a cross-kind redirect.

### Format

```
### Shrink a PNG-24 screenshot (lossless)
**For** flat UI or screenshots where a pixel is load-bearing. **Validate** `pngcheck`. **Gains** est modest; measure and record in expectations.md.
​```sh
oxipng -o max --strip safe IN.png --out OUT.png
​```
> Caveat: `--strip all` can drop a needed color profile, gamma, or DPI chunk; `--strip safe` keeps them.
```

## Honesty

A **Gains** number is measured or it is labeled `est`; `expectations.md` holds only observed
before/after bytes, never an estimate. A command that has not been run in this environment is
unverified, and the skill stays `status: draft` until its recipes are run and measured. Keep a result
only if it is smaller AND valid.

## Portability

Recipes use ImageMagick's `convert`/`identify` form, which runs on both v6 and v7; v7's unified command
is `magick`. In two-pass video recipes, `/dev/null` is `NUL` on Windows.

## Index

| Kind | Recipes |
|------|---------|
| raster | [`executors/raster/cookbook.md`](executors/raster/cookbook.md) |
| vector | [`executors/vector/cookbook.md`](executors/vector/cookbook.md) |
| animation | [`executors/animation/cookbook.md`](executors/animation/cookbook.md) |
| video | [`executors/video/cookbook.md`](executors/video/cookbook.md) |
| audio | [`executors/audio/cookbook.md`](executors/audio/cookbook.md) |
| model | [`executors/model/cookbook.md`](executors/model/cookbook.md) |
| document | [`executors/document/cookbook.md`](executors/document/cookbook.md) |
| font | [`executors/font/cookbook.md`](executors/font/cookbook.md) |

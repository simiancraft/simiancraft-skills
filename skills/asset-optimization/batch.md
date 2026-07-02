---
title: Batch (repository operation)
summary: optimize a directory or repository safely: walk, skip, classify, route, decide per file, keep or revert, and emit a report, with the originals policy and idempotence guard a build tool needs
status: draft
---

# Batch

Optimizing one file is the inner loop; optimizing a repository is the point of this skill. The batch
path walks a tree, classifies each file ([`classify.md`](classify.md)), routes it to its executor, and
applies the same keep-only-if-smaller-and-valid decision, then reports.

There is deliberately no shipped runner binary. The per-file decision needs judgment a static script
cannot encode: infer the target, pick fidelity intent, follow a cross-kind redirect, and decide
keep-or-revert. The batch is the documented loop below, which the driving agent executes with the tools
in [`tools.md`](tools.md); a project that wants a fixed pipeline can wrap these steps in its own script.

## Walk and skip

Walk the target directory. **Skip by default:** `.git`, `node_modules`, `dist` / `build` / `.next` /
other build output, `vendor`, generated caches, and any path the project marks ignored. Never descend
into a dependency tree; those assets are not yours to rewrite.

## Policy and roles

Honor a project policy when one is given: the target surface, a max dimension, whether to replace
originals, quality floors, and extra skip globs. A caller may also tag an asset with a **role** that
sets its fidelity: a hero image is quality-lean, an icon or thumbnail is size-lean, a looping background
video can strip its audio and take a heavy CRF. With no policy, infer the target
([`surface.md`](surface.md)) and default to lossy-acceptable for delivery assets and lossless-required for
anything that reads as a design master or evidence.

## The per-file decision

For each candidate file:
1. **Classify** ([`classify.md`](classify.md)); if the kind is unknown or unsupported, skip and log it.
2. **Idempotence guard** (below); skip if already optimized.
3. **Route** to the kind's `procedure.md`; pick fidelity intent and target.
4. **Run to a new output,** never over the source (see Originals).
5. **Measure and validate;** keep the output only if it is smaller AND valid, else discard it and keep
   the source.
6. **Record** the outcome for the report.

## Originals (never clobber the source)

Write every result to a new path; do not edit the source in place. In-place tools (`mogrify`,
`oxipng IN`, `metaflac IN`, `exiftool -overwrite_original`) are for a single, deliberate, backed-up use,
not for a batch over someone's repository. Replace an original only after the keep decision passes and
only when the caller explicitly asked to replace in place.

In-place replacement is only ever a **same-format** pass (PNG to PNG, a smaller WAV). A format or kind
redirect changes the extension (`hero.png` -> `hero.webp`), so it must emit a new file and leave
rewiring the references (`<img src>`, CSS `url()`, bundler imports) to the caller. Never delete a source
whose references you have not rewired; that passes the keep-or-revert gate and still breaks the site.

## Idempotence (do not re-optimize)

A second lossy pass can be smaller AND worse: re-encoding an already-optimized lossy asset loses
another generation of quality while still passing skip-if-not-smaller. So the two guards are not
interchangeable:
- **Skip-if-not-smaller** (always on, but not sufficient for lossy): if a prior pass already hit the
  floor, the new result is not smaller and the keep decision discards it. This catches lossless re-runs;
  it does NOT prevent lossy generation loss.
- **A content-hash manifest** (MANDATORY for any lossy kind, and for any input that might already be an
  optimized derivative): record `.asset-optimization/manifest.json`, mapping a source path to
  `{inputHash, outputHash, tool, before, after}`. Skip an input when its current hash equals a recorded
  `inputHash` OR `outputHash` (the latter catches a prior output re-fed as input). For a lossy asset,
  only a hash match is a safe skip; a smaller size is not.

## The report

Emit a per-file table and a total: path, kind, tool and settings, before bytes, after bytes, savings,
kept or reverted, and any skip reason. Write it to stdout, and for a build also to
`.asset-optimization/report.md`. This is the build artifact a reviewer reads, and it is what
`prove-work-on-github` renders as evidence. Never report a byte number that was not observed.

Measure bytes with `stat -c%s FILE` (or `wc -c < FILE`); savings is `1 - after/before`.

## Untrusted input

These tools assume your own repository's assets. If you point the batch at untrusted uploads, sandbox
it: ImageMagick, Ghostscript, and some SVG and font parsers have had memory-safety and XXE issues.
Restrict the accepted formats, run in a container or with resource limits, and do not auto-install
tools from an untrusted source.

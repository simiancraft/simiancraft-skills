---
name: evidence-locker
description: >-
  Where and how artifacts are stored: the __evidence_locker__ branch, the two branch
  protections (targeting a dynamically resolved release branch), the pluggable backend,
  GitHub size limits, the append-only/pinning rule, and the artifact naming convention.
role: lifecycle-stage
stage: 3
---

# Evidence Locker

The store stage. Artifacts go to a blessed, never-merged branch and are referenced inline
from the PR/issue comment.

## The branch

- `__evidence_locker__` (double underscores both sides; chosen to never collide).
- It is a pile of artifacts in a folder; it **never merges** into any release branch.
- Comments reference locker files **inline** via branch-hosted raw URLs. This is chosen over
  GitHub's drag-drop attachment uploads for durability, addressability, and greppability:
  a branch-hosted file has a stable path you can pin, diff, and migrate.

## Two protections, both required

The release branch is resolved dynamically (see `acquire.md`); it is not assumed to be `main`.

1. **Protect locker integrity**: disallow deletion and force-push on `__evidence_locker__`,
   so pinned artifacts cannot vanish or be rewritten. This also backs the append-only rule below.
2. **Guard the release branch against locker contamination**: a single branch-protection
   rule on the locker does NOT do this, because a merge into the release branch is gated by
   *that* branch's rules and by review/status, not by source branch. Use the ladder:
   - a **push ruleset on the release branch** with a file-path restriction blocking the
     evidence folder, or
   - a **required status check** on PRs into the release branch that fails when the head ref
     is `__evidence_locker__` or the diff touches the evidence dir, or
   - the floor: **never open that PR.**

> TODO: the exact `gh api` calls for ruleset and classic protection, and the minimal
> required-check workflow YAML.

## Three-tier consent before the first artifact push

Repo-settings changes are durable and outward-facing, so confirm before acting:

1. **Author with consent**: "I'm about to use `__evidence_locker__` as an artifact store.
   Want me to add protection so it can't be force-pushed or accidentally merged into
   `<release-branch>`? I have admin; here is what I'd add."
2. **Instruct if you can't**: no admin / no scope: hand the user the exact `gh api` calls or
   the Settings → Rules path.
3. **At minimum, warn**: never silently pile artifacts onto an unprotected branch.

## Pluggable backend

One interface: "give me a durable, addressable URL for these bytes." Two adapters:

- **Default = the GitHub branch.** Zero setup; clone the skill and it works.
- **Opt-in = a user/team-provided backend** (S3 bucket or similar). Also serves as the
  per-artifact overflow valve when a single artifact cannot be brought under GitHub's
  per-file limit.

## Size, growth, and limits

Compress before upload; see `optimize-assets.md` (OptiPNG, Gifsicle, format conversion, sizing).

GitHub has two different limits, and only one is a migration trigger:

- **Per-file hard block at ~100 MiB** (warning ~50 MiB). This can reject a single oversized
  artifact at push time. It is a per-artifact problem: compress or downscale it, or route that
  one artifact to the provided backend. It is not a reason to migrate the whole locker.
- **Repo-size soft threshold** (GitHub recommends under ~1 GiB and reaches out by email in the
  multi-GiB range; no silent hard stop). This is the only whole-locker migration trigger, and
  it arrives gradually, with warning.

LFS is opt-in and is never auto-forced.

Storage lifetime stance: **keep indefinitely, no GC.** Evidence on old PRs stays valuable, and
never-delete also means pinned references never 404. The cost is gradual clone-size growth (a
full clone fetches all branch objects), bounded by compression.

When the repo-size threshold is genuinely hit, the escape hatch is a one-time migration, not
routine deletion: move the artifacts to a provided backend, rewrite the inline URLs across the
affected PRs and issues, then delete the locker branch. Deleting the branch stops growth but
does not instantly reclaim storage; GitHub's GC runs on its own schedule, and forks or the repo
network may retain objects. This migration is a separate, larger task.

If pruning is ever forced before a backend is available, prune by validity-staleness, not age
(see `freshness-and-reproof.md`): the oldest proof that no longer reflects the application is
the first to cull.

## Append-only and pinned

Never overwrite a locker file. Each artifact is content-addressed (its content hash lives in
the manifest), so an inline reference cannot silently change. Superseded proof is replaced
*inline in the comment* by a fresh artifact; the old bytes remain as audit history.

## Artifact naming convention

```
NNNNN-YYYY-MM-DD-kebab-description[-disambiguator].ext
```

- `NNNNN`: zero-padded issue/PR number. Issues and PRs share one monotonic number space per
  repo, so this is globally unique and chronological; padding makes a plain file listing sort
  in creation order and keeps a single PR's artifacts contiguous (prefix scan).
- `YYYY-MM-DD`: capture date.
- `kebab-description`: what the evidence is.
- Disambiguator, **only** when a set shares the base:
  - ordered series (a `flow`: step 1 → 2 → 3) → zero-padded **sequence** `-01`, `-02`.
  - unordered set (parallel captures) → short **content-hash** `-a1b9f3c`.

Example: `00128-2026-06-29-login-flow-walkthrough.gif`. Collisions are effectively impossible:
number + description + (sequence or content-hash) is unique.

## Consumes / produces

- Consumes: optimized artifacts (`optimize-assets.md`) + their manifest entries.
- Produces: durable, pinned URLs for stage 4 (present) to embed.

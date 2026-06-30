---
name: artifact-manifest
description: >-
  The per-artifact metadata schema that ties the lifecycle together: scope tags, covered
  paths, capture commit SHA, capture method, and content hash. Powers decay-detection,
  partial reproof, and second-agent evaluation.
role: cross-cutting
---

# Artifact Manifest

The connective tissue. Every artifact carries a small record of what it is and what it
claims. This one structure is what makes three later stages tractable instead of guesswork.

## The schema (fields)

| Field | Purpose |
|-------|---------|
| `scope_tags` | the tags this artifact provides proof for (`db`, `frontend`, `flow`, ...) |
| `covered_paths` | the files/surface this artifact's claim depends on |
| `capture_commit` | the full SHA the artifact was captured at (the immutable referent) |
| `capture_method` | how it was produced (which harness/tool, which command) |
| `content_hash` | hash over the (optimized) bytes; the pin that makes the artifact verifiable |

## Why it exists (its three consumers)

- **Decay-detection** (`freshness-and-reproof.md`): `covered_paths` ∩ incoming-change = stale or not.
- **Partial reproof** (`freshness-and-reproof.md`): reacquire only artifacts whose covered paths changed.
- **Evaluation** (`evaluate.md`): tells a second agent what each artifact claims and lets it re-check.

Without the manifest, "did the critical path change" and "is this proof still valid" are vibes.

## Open

> TODO: where the manifest is serialized and stored. Candidates: a sidecar file in the locker
> alongside the artifact, a fenced block in the proof comment, or both. Decide before fleshing
> stages 5 and 6.

## Consumes / produces

- Produced incrementally: a draft entry at `acquire.md`, finalized (content hash) after `optimize-assets.md`.
- Consumed by: `present.md`, `freshness-and-reproof.md`, `evaluate.md`.

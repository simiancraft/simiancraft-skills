---
name: artifact-manifest
description: >-
  The per-artifact metadata schema that ties the lifecycle together: scope tags, covered paths,
  capture commit SHA, capture method, and content hash, serialized as a write-once sidecar. Powers
  decay-detection, partial reproof, and second-agent evaluation.
role: cross-cutting
---

# Artifact Manifest

The connective tissue. Every artifact carries a small record of what it is and what it claims. This
one structure is what makes three later stages tractable instead of guesswork.

## The schema (fields)

| Field | Purpose |
|-------|---------|
| `scope_tags` | the tags this artifact provides proof for (`db`, `frontend`, `flow`, ...) |
| `covered_paths` | the files/surface this artifact's claim depends on |
| `capture_commit` | the full SHA of the **code** the artifact was captured against; the repo state the proof is about |
| `capture_method` | how it was produced (which harness/tool, which command) |
| `content_hash` | hash over the (optimized) bytes; the anchor a reader recomputes to verify the artifact |

Three distinct referents meet here, and blurring them is the easy mistake:

- `capture_commit` is the **repo** commit the proof is *about*: what state of the code it
  demonstrates.
- The **locker** commit SHA is where the artifact bytes were appended on `__evidence_locker__`; that
  SHA is embedded in the inline raw URL (see `evidence-locker.md`) and is what makes the reference
  immutable. It is a property of storage, not of the claim, so the manifest does not repeat it.
- `content_hash` identifies the **bytes** independent of any URL, so a reader can re-verify the
  artifact even if it were ever re-hosted to another backend.

## Serialization: a write-once sidecar

Each artifact gets a sidecar JSON next to it in the locker, `evidence/<artifact-filename>.json`,
written once in the **same append commit** as the artifact and never edited.

Example, `evidence/00128-2026-06-29-login-flow-walkthrough.gif.json`:

```json
{
  "scope_tags": ["frontend", "flow"],
  "covered_paths": ["src/auth/login.tsx", "src/auth/session.ts"],
  "capture_commit": "9f2c1ab3d4e5f6789012345678901234567890ab",
  "capture_method": "playwright-gif-capture: flows/login.spec.ts",
  "content_hash": "sha256:3b1e0c...c7"
}
```

The `content_hash` carries its algorithm as a prefix so the verification method is self-describing.

Why a sidecar and not a per-PR log:

- **Nothing here mutates.** Every field is a capture-time fact; staleness is *derived* later from
  repo state (`freshness-and-reproof.md`), not stored, so there is no update to serialize. A
  write-once file is the exact shape of the data.
- **Zero write-contention.** One artifact, one sidecar, one commit; two artifacts captured in
  parallel never touch the same file. A per-PR JSONL would need read-modify-append, reintroducing
  the contention a never-overwritten locker exists to avoid.
- **Atomic with the bytes.** Sidecar and artifact land in one commit, so a manifest entry can never
  point at bytes that are not there, and the bytes never arrive without their record.

To read a PR's whole manifest, glob its sidecars by the shared number prefix
(`evidence/NNNNN-*.json`); the naming convention (`evidence-locker.md`) keeps one PR's artifacts and
sidecars contiguous.

## Why it exists (its three consumers)

- **Decay-detection** (`freshness-and-reproof.md`): `covered_paths` intersected with the incoming
  change decides stale or not.
- **Partial reproof** (`freshness-and-reproof.md`): reacquire only artifacts whose covered paths
  changed.
- **Evaluation** (`judgement.md`): tells a second agent what each artifact claims and lets it
  re-check.

Without the manifest, "did the critical path change" and "is this proof still valid" are vibes.

## Consumes / produces

- Produced incrementally: a draft entry at `acquire.md` (scope tags, covered paths, capture commit,
  and capture method), finalized with `content_hash` after `optimize-assets.md`, and serialized as
  the sidecar when the artifact is pinned in `evidence-locker.md`.
- Consumed by: `render.md`, `freshness-and-reproof.md`, and `judgement.md`.

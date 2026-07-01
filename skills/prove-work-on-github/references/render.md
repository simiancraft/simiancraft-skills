---
name: render
description: >-
  The show-it stage: compose and render proof inline in a PR or issue comment so a reader
  sees it top to bottom, sized by the change shape.
role: lifecycle-stage
stage: 3
---

# Render

The proof exists in the locker; now make it legible where the claim is made. A reader,
human or agent, should scroll the PR/issue comment top to bottom and see the evidence in
context, not chase links.

## Inline from the locker

Embed each artifact by its commit-SHA-pinned raw URL (see `evidence-locker.md`); the embedded
commit SHA fixes the bytes, so the reference cannot silently change. The inline image or GIF
renders in the comment.

## Where proof goes

- **Pull request** when the claim is "this should merge because of this evidence."
- **Issue** when the claim is "this can be closed because of this evidence."
- The leading number in each artifact's name matches the PR or issue number, so a reader
  can confirm the evidence belongs to the thing they are reading.

## Atomic and asynchronous presentation

Proof may span multiple comments. Working back to front, prove the backend atomically in
one comment, then the frontend later, either when it is built or as a second step. This is
acceptable and preferred: a merge-gating agent reads *all* the proof on the thread, and
smaller atomic comments mean a stale piece can be invalidated and reacquired without
redoing the rest (see `freshness-and-reproof.md`).

> TODO: the canonical comment template (claim, scope tags, inline artifacts, the immutable
> referent each artifact was captured at, and a one-line "how to re-check").

## Consumes / produces

- Consumes: pinned URLs (`evidence-locker.md`) and manifest entries (`artifact-manifest.md`).
- Produces: the human- and agent-readable proof comment that stage 4 evaluates.

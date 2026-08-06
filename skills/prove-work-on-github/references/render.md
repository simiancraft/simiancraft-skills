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

## The canonical comment

One comment (or the first of an atomic series), in a fixed shape, so a reader or a merge-gating
agent finds every part in the same place. Most fields come from the artifact's manifest entry
(`artifact-manifest.md`); the claim is the narrative itself, and each image is the SHA-pinned raw
link from the locker.

```markdown
**Claim:** <the one-line narrative this proves>
**Scope:** `frontend`, `flow`, `db`
**Captured at:** `<capture-commit>` (the code state this proof is about)

### <what this artifact shows>
![<alt text>](https://raw.githubusercontent.com/<owner>/<repo>/<locker-sha>/evidence/00128-2026-06-29-login-flow-walkthrough.gif)
Covers `src/auth/login.tsx`, `src/auth/session.ts`. Re-check: `bun run flows/login.spec.ts`.

### <what the next artifact shows>
![<alt text>](https://raw.githubusercontent.com/<owner>/<repo>/<locker-sha>/evidence/00128-2026-06-29-db-after.png)
Covers `db/schema.sql`. Re-check: open the pinned URL and diff against the migration.

**Not covered here (device-only):** push delivery, real camera.
```

- **Claim** is the narrative being turned into a receipt; everything under it is the receipt.
- **Scope** is the artifact set's `scope_tags`. **Captured at** is the `capture_commit`, the
  immutable code-state referent a reader resolves the proof against; it is distinct from the
  locker commit in each inline URL, which pins the stored bytes (see `artifact-manifest.md`).
- **Each artifact** renders inline from its SHA-pinned raw URL, names the `covered_paths` it backs,
  and gives a one-line **Re-check** (the `capture_method`, or the command or click that reproduces
  it), so a second reader can verify without the presenter's context.
- **Byte identity** is not restated in the comment; a reader verifies it from the sidecar's
  `content_hash` (`artifact-manifest.md`).
- **Not covered here** carries a producer's honest gaps forward (a flow-evidence bundle's
  `deviceOnly`, for instance), so the comment never implies coverage it does not have.

## Consumes / produces

- Consumes: pinned URLs (`evidence-locker.md`) and manifest entries (`artifact-manifest.md`).
- Produces: the human- and agent-readable proof comment that stage 4 evaluates.

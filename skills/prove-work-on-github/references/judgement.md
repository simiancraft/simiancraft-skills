---
name: judgement
description: >-
  The interpreter of the three aspects: judge whether the evidence is adequate for the
  change's physical scope, split adequacy from confidence, and map the score to an action
  (merge, gather more, or block).
role: rubric-interpreter
---

# Judgement

Proof exists to be judged. A merge-gating agent decides, from the proof on the thread,
whether the work can land. The presenting agent self-evaluates first, but the design target
is that a **second** agent, without the presenter's context, can evaluate the proof already
in the PR.

> Evaluating proof could stand on its own; it lives here for now because judging proof and
> producing it are tightly coupled.

## Two evaluation modes

- **Vision** for design and visual-fidelity claims: does the screenshot/flow actually look
  right against the spec.
- **Reasoning** for correctness claims: does the over-the-wire capture, DB shape, or log
  actually show the call was done correctly.

## What the evaluator needs

- The proof comment (`present.md`), read top to bottom.
- Each artifact's **manifest** entry (`artifact-manifest.md`): what it claims (scope tags),
  what it covers (paths), and the commit it was captured at.
- The ability to re-check: an immutable referent it can resolve, and an artifact whose content
  hash it can verify.

If the proof cannot be re-checked by someone without the presenter's context, the evaluator
should treat it as unproven and request reacquisition, not approve on trust.

## Relationship to freshness

Before evaluating, confirm the proof is fresh against current repo state (`freshness-and-reproof.md`).
Evaluating stale proof gates the wrong artifact.

## Consumes / produces

- Consumes: the proof comment, the manifest, current repo state.
- Produces: a merge verdict with reasons, and (if stale or insufficient) a reacquire request.

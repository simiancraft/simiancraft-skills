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

- The proof comment (`render.md`), read top to bottom.
- Each artifact's **manifest** entry (`artifact-manifest.md`): what it claims (scope tags),
  what it covers (paths), and the commit it was captured at.
- The ability to re-check: an immutable referent it can resolve, and an artifact whose content
  hash it can verify.

If the proof cannot be re-checked by someone without the presenter's context, the evaluator
should treat it as unproven and request reacquisition, not approve on trust.

## The adequacy scorecard

**Adequacy** answers one question: does the evidence cover what this change owes, at the depth its
physical size demands? The bar comes from `physical.md` (how much is owed) and `correctness.md`
(what must be proven); this scorecard is how the evaluator checks the evidence against that bar.

Score each **load-bearing claim** in the proof; a claim is load-bearing when the merge decision
would change if it were false. Every load-bearing claim must pass every row:

| Check | Pass condition |
|---|---|
| Receipted | The claim is paired with evidence, not narrative. "I ran it" with no output fails. |
| Pinned | The receipt cites an immutable referent: a full commit SHA, a content-addressed artifact, a hash-carrying permalink. A branch ref or "latest" fails. |
| Resolvable | Every cited referent resolves for a second reader: the SHA exists **on the remote**, not only in the author's local repository, and the artifact link opens. An amended or rebased commit leaves a SHA whose first nine characters still look right while nobody else can resolve it. |
| Fresh | Captured at the head under judgement. Proof captured before the last push gates an artifact that no longer exists; compare the SHAs, and consult `freshness-and-reproof.md` when the repo has moved since capture. |
| Re-checkable | A reader without the author's machine or context can re-run, re-open, or re-verify it. Evidence verifiable only by trusting the author fails. |
| Clean | The receipt leaks no secret, token, or private detail. A leaking receipt fails adequacy outright, whatever else it proves. |

Two checks apply to the change as a whole rather than to any one claim:

- **The deciding command is covered.** Whatever else is captured, one receipt must exercise the
  command the pipeline itself uses to gate the change, not only a focused invocation the author
  chose. A proof can be sound, pinned, and reproducible and still miss the gate that determines
  the outcome; a merge gate can refuse on exactly this after reproducing every other
  receipt. Read the CI configuration to learn what runs, and expect proof of that.
- **Nothing load-bearing rests on narrative alone.** If any claim that would change the decision
  has no receipt, adequacy fails no matter how strong the rest is.

A decorative claim failing a row does not fail adequacy; note it and move on. Spending the
author's revision budget on ornament is its own kind of judgement error.

## Confidence

**Confidence** answers a different question: how sure is the merge decision, given anything the
evaluator could not cover? Adequacy scores the evidence presented; confidence scores the decision,
including what is absent.

Keep a register of blind spots: each thing that could not be re-checked, and why. Then weigh each
by what it sits under. A blind spot on a decorative detail costs little; a blind spot on whether a
mutation writes twice undercuts the decision regardless of how well everything else scored. An
honestly named blind spot (a check that would have required mutating shared state, hardware the
evaluator lacks, a paid external service) is worth more than a verdict bought by pretending the
check happened. Name the blind spot; never discount it.

## The action map

Return exactly one action:

| Action | When |
|---|---|
| **Merge** | Adequacy passes for every load-bearing claim, and no blind spot in the confidence register sits under a load-bearing claim. |
| **Gather more** | The change looks right but the proof does not carry it: an adequacy row failed, the deciding command is uncovered, or a load-bearing claim rests on narrative. Name precisely what to acquire; the author cannot ask what you meant. |
| **Block** | The change itself is wrong, out of scope, or incomplete against what it claims to resolve, independent of how good the proof is. Name precisely what must change. |

Tie-breakers, in order:

1. **When adequacy and confidence disagree, follow confidence.** Complete-looking evidence with a
   load-bearing blind spot is not a merge; approving proof you could not re-check is the failure
   this gate exists to prevent.
2. **Distinguish the change being short from the proof being short.** Block is about the work;
   gather-more is about the evidence. Sending a correct change back as blocked wastes a revision
   fixing nothing.
3. **A rejection is a work order, not a verdict on the author.** Write each item as the concrete
   thing to do, file and case named. Where review rounds are budgeted, reject on what actually
   stands between the change and merging, not on everything you would have done differently.
4. **An uncheckable load-bearing blind spot maps to gather-more when a checkable receipt could
   exist in another form**; ask for that form. Only when no receipt could exist for the claim does
   it become block, because a change whose correctness cannot be evidenced at all is not mergeable
   through this gate.

## Relationship to freshness

Before evaluating, confirm the proof is fresh (`freshness-and-reproof.md`); evaluating stale proof
gates the wrong artifact. Two freshness questions have two owners, and conflating them charges the
author for upstream churn: the **evaluator** confirms the proof was captured at the head under
judgement, while the **integration step** (whoever merges) answers whether the base has since
moved into the work's covered paths. Where a pipeline separates the roles, the evaluator does not
spend its verdict on base movement; the merger's answer is usually cheaper than a re-review, and a
gather-more issued for base movement asks the author to fix something that is not a defect in the
change.

## Consumes / produces

- Consumes: the proof comment, the manifest, current repo state.
- Produces: a merge verdict with reasons, and (if stale or insufficient) a reacquire request.

## Provenance

The scorecard rows and both change-level checks are shared with the merge gate of the
`burn-down-github-issues` skill, which applies them as its review rubric; the deciding-command
and remote-resolvable rows exist because each names a way a proof can look complete and still
fail the gate.

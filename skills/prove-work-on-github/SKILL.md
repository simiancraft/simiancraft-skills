---
name: prove-work-on-github
description: >-
  Prove that work claimed on a pull request or issue actually landed and is sound, with
  verifiable evidence a reader can independently re-check. A claim is narrative; a receipt
  is proof. Use when deciding what evidence a change owes, capturing it (screenshots, GIFs,
  logs, database shape, over-the-wire results, test and coverage output), storing it in a
  durable evidence branch, rendering it inline in a PR or issue comment, judging whether the
  evidence is adequate to merge, or checking whether existing proof has gone stale. Triggers:
  "prove this works", "what evidence does this PR need", "attach proof to the PR", "is this
  enough to merge", "evidence locker", "is this proof still valid". Skip for trivial changes
  whose proof is the diff itself, and for work that never touches GitHub.
---

# Prove Work on GitHub

> A claim is narrative; a receipt is proof. The remote is the witness, not your intent to push.

A statement about a change ("the fix works", "CI is green", "the screen looks right", "it is
ready to merge") is narrative until it is paired with a **receipt**: verifiable evidence that you
observed and that a reader can independently re-check. "I ran the command" is not "the remote
advanced." A green checkmark is not "the feature is correct." This skill is the discipline that
turns claims into receipts, sizes how much proof a change owes, stores the receipts durably on the
pull request, and judges whether they are enough to merge.

## Proof is asymptotic

Proof is never perfect; it only approaches the asymptote of perfection. The categories below are
open sets, not closed enums: when you find a new signal that makes a change more provable, add it
(extend your copy, or propose it upstream). The rubric ships incomplete by design and improves by
contribution. A skill that claims a finished, total account of proof is lying.

## When proof is owed

Proof is owed when a claim about a change would change what a reviewer or a merge gate does, and
the claim is not self-evident from the diff. Match the rigor to the change (see
`references/physical.md`); a typo and a schema migration do not earn the same receipt. Skip when
the diff is its own proof, or when the work never reaches GitHub.

## The model: three aspects and a judgement

Three measured aspects of a change, and a judgement that interprets them. Judgement is last.

| Aspect | Question |
|--------|----------|
| **Physical** | what is the change, and how much does it therefore owe (surface area, complexity, and reversibility)? |
| **Correctness** | is the change sound (alignment, verifiability, durability, and security)? |
| **Evidence** | what receipts does that change require, by type, and at what fidelity? |
| **Judgement** | is the evidence adequate, and how confident are you to merge? |

Physical sizes the bar; Correctness names what must be proven; Evidence supplies the receipts;
Judgement reads the three and returns an action: merge, gather more, or block.

## The lifecycle (what you do)

| # | Step |
|---|------|
| 1 | Size the change (Physical) and name what it must prove (Correctness) |
| 2 | Acquire the evidence the change owes, by type |
| 3 | Store it in the evidence branch and render it inline |
| 4 | Judge adequacy and confidence, and act |
| 5 | Re-judge when the repo moves and the proof goes stale |

## Cross-cutting non-negotiables

- **Pin to an immutable referent.** Cite a full commit SHA, a content-addressed artifact, or a
  permalink with the commit hash; never a moving target. Evidence is append-only and never
  overwritten, so an inline reference cannot silently change.
- **Never let a receipt leak.** A pasted log can dump a token; a screenshot can catch a secret.
  Redact before you store or present.
- **Keep capture read-only.** Acquiring proof of a change must not alter the system under proof.
- **Make every receipt re-checkable by someone else.** If a second reader cannot click it, re-run
  it, or verify its hash, it is not proof.

## Reference index

| Need | Read |
|------|------|
| Size the change: surface area, complexity, reversibility, and the metrics behind them | `references/physical.md` |
| Is the change sound: alignment, verifiability, durability, and security | `references/correctness.md` |
| Judge adequacy versus confidence and map the score to an action | `references/judgement.md` |
| Capture the evidence a change type owes | `references/acquire.md` |
| The evidence branch: storage, protection, naming, and fidelity | `references/evidence-locker.md` |
| Prepare an artifact for GitHub: format, compression, and sizing | `references/optimize-assets.md` |
| Compose and render proof inline in the comment | `references/render.md` |
| The per-artifact metadata that ties it together | `references/artifact-manifest.md` |
| When proof has gone stale and what to reacquire | `references/freshness-and-reproof.md` |
| Worked examples of strong and fake proof | `references/catalog.md` |

## Extending this skill

A living document; the categories grow as you find new ways to prove. Every new fact has one home:

| A new fact is... | Home |
|---|---|
| a sizing signal for the change | `references/physical.md` |
| a soundness signal (alignment, verifiability, durability, or security) | `references/correctness.md` |
| a judgement element or a scoring rule | `references/judgement.md` |
| a capture method for a change type | `references/acquire.md` |
| a storage, protection, or naming rule for the evidence branch | `references/evidence-locker.md` |
| an artifact format or optimization | `references/optimize-assets.md` |
| a rule for rendering proof inline | `references/render.md` |
| an attribute of an artifact | `references/artifact-manifest.md` |
| a staleness or reproof rule | `references/freshness-and-reproof.md` |
| a cross-cutting non-negotiable | this `SKILL.md` |
| a worked example of strong or fake proof | `references/catalog.md` |

When the signal is genuinely new, extend the rubric (in your copy, or propose it upstream); see
"Proof is asymptotic."

## Acceptance: a claim is proven when

- Every load-bearing claim about the change has a receipt; nothing rests on narrative alone.
- Each receipt cites an immutable referent and is re-checkable by a second reader.
- The evidence covers what the change owes (its Correctness claims) at the depth its Physical size demands.
- Judgement returns merge: adequacy clears the bar, and confidence is not undercut by an uncoverable blind spot on a load-bearing claim.
- No receipt leaks a secret, and no capture mutated the system under proof.

If any item fails, you have a story, not proof.

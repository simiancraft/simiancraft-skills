---
name: prove-github-issue
description: >-
  The Proving lane of the fix pipeline: one headless agent turn, on a fresh context, that proves a
  commit a coder pushed for a GitHub issue and hands it to review as a ready pull request carrying
  that proof, per `prove-work-on-github`. It changes no code and pushes nothing to the branch; a
  change it cannot prove goes back to the coder with what is missing. Run by `fix-github-issue`
  (and so by `burn-down-github-issues`) after every push it announces, after a reviewer asks for
  more evidence, and after the base moves beneath an existing proof. Skip it for writing the change
  or for judging someone else's proof.
---

# Prove GitHub Issue

One seat, one lane: Proving (D2). The prover's turn ends at a **ready pull request whose head is the
proven commit**. It starts from durable state alone (the issue, the pushed branch, and the coder's
announcement on the thread), so it never inherits a coder's long transcript, and a prover that is
killed costs only the proof: the coded commit stands, and the next attempt proves it again rather
than coding it again.

This feature is about a **proof**; its children are **receipts**: artifacts pinned to commits the
remote holds, each covering one thing the change claims.

| Verdict | What it means | What happens next |
|---|---|---|
| `proved` | a ready pull request, `pr`, whose head is `sha`, the lane's head | the card goes to review |
| `unprovable` | the change does not do what the issue asks, or what it claims cannot be shown; `brief` says what | the driver announces it (`<!-- loop-step unproved ... -->`), spends an attempt, and a coder fixes it on the same branch |
| `needs-decision`, `needs-human` | proof needs a ruling, or access an agent lacks | the issue is held with the question stated |
| `failed` | anything else | the attempt is counted; the coded commit stands |

## What a prover is told, and what it is not

The prompt is `prompts/prove.md`. Its brief is the coder's hand-off on a first proof, the
reviewer's points when a review asked for more evidence, or the catch-up that moved the base
beneath an existing proof. It loads `prove-work-on-github` for the definition of proof.

The prover reruns the repository's gate only when the head it proves differs from the commit the
coder gated (the driver merged the base in at the seam); otherwise the coder's gate stands and CI is
the second opinion. Like the coder, it never chases the base itself.

## How the driver checks the answer

`lib/prove.ts` exports `runProve(ctx, issue, cwd, coded, brief)`. It runs the seat and returns its
answer, or `failed` when the answer cannot be believed: a crash, a kill at the cap, an unknown
verdict, a `proved` that names no pull request or is pinned to a head other than the lane's, or an
`unprovable` that tells the coder nothing to fix. The control file is `loop-proof.json`.

## Hard dependencies

- The sibling `fix-github-issue` skill, imported for the agent runner, the context, the prompt
  renderer, and the Work markers. It ships in the same collection and is what runs this seat.
- The sibling `prove-work-on-github` skill, which the prover loads.
- `gh` authenticated with pull-request rights, and the CLI the `worker` seat names, on `PATH`.

## The ceiling, named

A proof is evidence an independent reviewer can re-check, not a verdict; the reviewer, on another
engine, still decides whether it is enough. The prover runs on the same engine as the coder by
default: a fresh context stops proof-by-memory, and engine independence is the reviewer's job.

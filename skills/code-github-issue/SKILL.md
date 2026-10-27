---
name: code-github-issue
description: >-
  The Coding lane of the fix pipeline: one headless agent turn that makes the smallest change for
  a sized GitHub issue in its own git worktree, runs the repository's own gate on it, commits it,
  and pushes it, then stops. It proves nothing and opens no pull request; `prove-github-issue` does
  that next, on a fresh context. Its answer is believed only when the remote holds the commit it
  names. Run by `fix-github-issue` (and so by `burn-down-github-issues`) for a first attempt, a
  code revision after a reviewer's objection, and a recode after a refused proof. Skip it for
  proving, reviewing, or anything that is a product decision rather than a change.
---

# Code GitHub Issue

One seat, one lane: Coding (D1), and Sent back (D4) for a revision. The coder's turn ends at a
**pushed commit**, which is a fact on the remote and the only thing that makes the lane finished.
Everything after it belongs to another seat, so a coder that is killed costs at most the change
it was making, and work it pushed survives.

This feature is about a **change**; its children are **pushes**: commits on the issue's branch
that the remote holds, the last of them gated by the repository's check command.

| Verdict | What it means | What happens next |
|---|---|---|
| `coded` | the change is pushed; `sha` is the remote head of `branch`, `gated` is where the check passed | the driver announces it on the issue (`<!-- loop-step coded ... -->`, with the hand-off) and starts the prover |
| `already-fixed`, `obsolete` | the code disagrees with the appraisal; a close carrying a re-checkable receipt | a second engine confirms the close before it is made |
| `needs-decision`, `needs-human` | a ruling nobody has made, or access an agent lacks | the issue is held with the question stated |
| `out-of-band` | the real work is larger than the appraisal said, with the coder's own points | the issue goes to carving |
| `answered` | a `spike` issue's questions, answered with evidence | confirmed by a second engine, then closed |
| `failed` | anything else | the attempt is counted |

## What a coder is told, and what it is not

The prompt is `prompts/code.md`. Its brief says why the turn exists: a first attempt from the base,
a revision with the reviewer's objection, a recode with what the prover could not show, or the
continuation of a branch that moved past its last announcement. In every case but the first it
names the branch to continue; the coder never starts a second one.

The coder is told **not** to chase the base. The driver hands it a lane that holds the current base
and catches the lane up again at the seam before the prover starts. A seat that merges the base
mid-turn doubles its gate and crosses the cap; the seams are where staying current is cheap.

## How the driver checks the answer

`lib/code.ts` exports `runCode(ctx, issue, cwd, maxPoints, brief)`. It runs the seat and returns
its answer, or `failed` when the answer cannot be believed:

- the agent crashed, or was killed at the cap (`agentTimeoutMinutes`, the `worker` seat's);
- the verdict is not one the driver knows, names another issue, or has no reason;
- `coded` names a commit that is not the lane's head, a branch the remote does not hold at that
  commit, the base branch itself, or carries no hand-off for the prover.

The control file is `loop-code.json` in the worktree root.

## Hard dependencies

- The sibling `fix-github-issue` skill, imported for the agent runner, the context, the prompt
  renderer, and the Work markers. It ships in the same collection and is what runs this seat.
- The CLI the `worker` seat names, on `PATH`.

## The ceiling, named

A pushed, gated commit is a statement that the change exists and passes the repository's own
checks, not that it does what the issue asks; that is the prover's to show and the reviewer's to
judge. The hand-off is the coder's own account, so a prover reads it as a claim to check, never as
proof.

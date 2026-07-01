---
name: freshness-and-reproof
description: >-
  When existing proof has gone stale against the state of the repo and must be
  reacquired: the two-factor decay formula, partial reproof scoped by covered paths,
  asynchronous proof across comments, and the two distinct half-lives.
role: lifecycle-stage
stage: 5
---

# Freshness & Reproof

Proof is true as of the commit it was captured at. As the repo moves, some proof stays
valid and some goes stale. This stage decides which, and reacquires only what it must.

## Two distinct half-lives, kept separate

- **Validity decay** (this stage): repo-state-driven; proof goes stale and must be reacquired.
- **Storage lifetime** (`evidence-locker.md`): whether bytes are ever deleted. Current stance: never.

They coexist: superseded proof is replaced inline by fresh proof; the old bytes remain as
audit history. Stale does not mean deleted.

## The decay formula (two-factor)

Half-life is **not** primarily time; pure-time decay causes eternal reproving. It is a
function of repo state:

```
decay = f(distance from the release branch) * f(fraction of incoming change
          that intersects this artifact's covered paths)
```

- If a PR is far behind the release branch *and* the catch-up changes touched the paths an
  artifact covers, that artifact is stale; reacquire it.
- If CI is failing and the fix pulled files on your critical path, reacquire.
- Time is at most a backstop, not the primary signal.

## Partial reproof

Reacquire only proof whose covered paths the incoming change actually touched. A full-stack
operation where only the CSS changed does not need the backend transactions reproven, if the
manifest shows those covered paths were untouched. This is why each artifact records its
covered paths in `artifact-manifest.md`: "did the critical path change" becomes a set
intersection, not a guess.

## Asynchronous reproof shrinks the surface

Because proof is presented atomically across comments (`render.md`), a stale artifact can be
invalidated and reacquired on its own, leaving the rest of the proof standing. Smaller atomic
units mean a smaller reproof surface area.

## If pruning is ever forced

Should storage pressure ever force a rolling window, **prune by validity-staleness, not age**:
the best cull candidate is proof so far back it no longer reflects the current application.

> TODO: how to compute the covered-paths intersection from a diff; thresholds for "far behind."

## Consumes / produces

- Consumes: the manifest (covered paths, capture commit SHA), repo state (distance from release branch, CI).
- Produces: a reacquire list (which artifacts are stale), fed back into `acquire.md`.

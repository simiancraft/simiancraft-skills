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

## Computing the covered-paths intersection

Covered paths are the **import closure** of the files the change touches, not the touched files
themselves. A test receipt or a rendered frame depends on the whole module graph beneath the
component; a base change to a shared chassis module or a generated type invalidates the proof
while touching nothing the diff touched, and comparing filenames alone calls that fresh.

The working method, field-run by the merge gate in the `burn-down-github-issues` skill:

1. **Incoming**: `git diff --name-only <captureSha>...<remote>/<base>`, the base's movement since
   capture. Empty means fresh, however long ago the capture was; time is a backstop, not a signal.
2. **Global invalidators short-circuit.** Some paths sit outside any import graph and everything
   depends on them: the lockfile, the package manifest, type and lint config, build config, the
   schema and its migrations, generated output, CI workflows. If the incoming set touches one,
   the proof is stale, full stop.
3. **Closure**: from the change's own files, follow `import`/`from`/`require` (including dynamic
   imports with literal specifiers) transitively, resolving the project's path aliases, until the
   graph is exhausted or a size cap is hit. At the cap, stop computing and call the proof stale;
   the conservative answer is the cheap one.
4. **Intersect** incoming against the closure. A non-empty intersection means reacquire; an empty
   one means the movement did not reach what this proof covers.

Honest limits: a static walk does not see reverse consumers, string-built import paths, CSS and
asset coupling outside explicit imports, or coupling through a database. The global-invalidator
list is the blunt instrument covering what the walk cannot; a repository with heavy non-import
coupling should widen that list rather than trust the closure. And the intersection gates
freshness only; it never substitutes for CI on the merged result.

There is no useful numeric threshold for "far behind." Distance matters only through the
intersection: a branch hundreds of commits back whose closure the base never entered is fresh,
and a branch one commit back whose shared chassis moved is stale.

## If pruning is ever forced

Should storage pressure ever force a rolling window, **prune by validity-staleness, not age**:
the best cull candidate is proof so far back it no longer reflects the current application.

## Consumes / produces

- Consumes: the manifest (covered paths, capture commit SHA), repo state (distance from release branch, CI).
- Produces: a reacquire list (which artifacts are stale), fed back into `acquire.md`.

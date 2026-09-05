# Adopting carve-github-issue

The knife reads a config file at the root of the repository it works: its own
`carve-github-issue.config.ts`, or `burn-down-github-issues.config.ts` when the repository has
adopted the burndown (the usual case; the burndown invokes the knife itself). Everything true of the
repository lives there; nothing in this skill is copied into the repository.

## The config

The burndown's config template (in `burn-down-github-issues/references/adopting.md`) plus one
optional block and two optional seats:

```ts
export default {
  project: { /* as the burndown's template */ },
  maxPoints: 2,                       // the ceiling; an issue sized above it is the knife's
  carve: {
    maxDepth: 3,                      // the root is 0; an issue at depth d is carvable iff d < maxDepth
    maxChildren: 8,                   // pieces per cut
    maxCarveRounds: 5,                // carver-confirmer pairs before a dispute hands off
    maxCarveAttempts: 3,              // failed carves before the issue goes to a person
    maxGenerations: 5,                // amends per epoch before the trunk goes to a person
    maxRevisitsPerGeneration: 10,     // still-good revisits per epoch before the trunk goes to a person
  },
  seats: {
    worker: 'codex:gpt-5.6-sol',
    reviewer: 'claude:claude-opus-5',
    carver: 'codex:gpt-5.6-sol',           // defaults to seats.worker
    carveConfirmer: 'claude:claude-opus-5', // defaults to seats.confirmer, then seats.reviewer
  },
};
```

Every number is validated as a positive integer; the carver and its confirmer must be different
engines. `pointScale` (the burndown's, default the Fibonacci rungs) is the scale every size is on.

**One account per tracker.** Every machine that runs the knife, the worker, or the appraiser
against one tracker authenticates as the same GitHub account, and their clocks agree to within a
minute. Claims and markers are meaningful only under that assumption.

## The labels

Created on first run, alongside the burndown's:

| Label | Meaning |
|---|---|
| `loop/carved` | a trunk; worked by closing its children |
| `loop/carve-gen: N` | the trunk's current generation while unreleased |
| `loop/carving` | a knife holds it; other runs wait |
| `loop/working` | a worker holds it; other runs wait |
| `loop/paused` | paused by its parent while a question is open; owned by trunks only |
| `loop/released` | the carving is exhausted; the burndown's release appraisal finishes it |
| `loop/handed-off` | the knife handed it off before carving it; found by the sweep when the hold lifts |
| `loop/carves: N` | failed carve attempts, cleared by a confirmed verdict |
| `spike` | a child that answers a question with evidence; no pull request |

A person who wants a leaf held uses `loop/skip` or a `needs-*` label, never `loop/paused`.

## What lands on the tracker

On a confirmed carve: sub-issues created in delivery order under the trunk (each body starting
with a marker and a pointer at the record), `blocked-by` edges where the cut says a later piece
cannot land first, references attached or depended on, superseded children with no work started
closed not planned with a pointer, the `applying` then the `live` carving record on the trunk's
thread, `loop/carve-gen: N` and `loop/carved` on the trunk.

On a hand-off: the reason on the thread with both opinions when disputed, the hold label
(`needs-human` or `needs-decision`), pause markers and `loop/paused` on the leaves the question
touches, a `live` record with the verdict.

On `exhausted`: a `released` record, the size and trunk labels off, `loop/released` on; the
burndown then appraises the remainder.

## Guards

Depth (`maxDepth`), fan-out (`maxChildren`, and GitHub's 100 sub-issues per parent), the floor (no
authored child under the scale's smallest rung or without its own acceptance and proof), the
counters (`loop/carves: N`, `maxGenerations`, `maxRevisitsPerGeneration`, each tripping a hand-off
at its cap), claims (thirty minutes, renewed every five), and time (every agent turn has the
runtime's 45-minute cap and rounds are capped, so a carve terminates by construction).

## Boundaries

Named rather than claimed closed; the full list is `lifecycle.md`. A hold, blocker, pause, or
child added between a run's last read and its write; two claim comments briefly coexisting before
the loser reads the winner; read-after-write lag on the tracker; two trunks authoring one missing
piece in the same instant; a person changing tracker state during a multi-write transition (the
finisher honours what it can see and abandons the write it can no longer justify); a person who
deletes records, markers, or `loop/*` labels is acting, and the knife does not defend against
deliberate removal of every trace.

# Diagnose a failed walk for {{PROJECT}}

A walk of the running environment failed. You have one turn to say why, as far as the evidence
supports, and to write it down so an issue can be filed and a fix attempted. You are not fixing
anything here. Do not touch the environment.

## What failed

```json
{{ENTRY}}
```

## The last clean walk

```json
{{LAST_GOOD}}
```

## What landed between the two revisions

Every merge into `{{BASE_BRANCH}}` between the last clean revision and the one that failed, newest
first, from the forge rather than from anyone's memory:

{{SUSPECTS}}

A read-only checkout at the failing revision is at `{{CHECKOUT}}`; use `git show <sha>` there to
read any suspect's diff.

## What the environment says

Output of the configured logs command, most recent last:

```
{{LOGS}}
```

## How to reason

1. If the log names a symbol, a route, a file, or an error class, search the suspects' diffs for
   it. A suspect whose diff introduces the named thing is the culprit; say so and quote both.
2. If the log is silent, order the suspects by how plausibly each reaches the failed surface: the
   item's own touched paths first, then anything touching startup, configuration, dependencies,
   or generated code, then the rest. Name the most plausible and say plainly that it is a guess.
3. If nothing landed between the two revisions, the cause is outside the repository (the host, a
   dependency, data) and you say so; do not invent a culprit.
4. Say whether the fix should be forward (a small change that keeps the culprit's intent) or a
   revert (the culprit's intent cannot be kept safely right now). Prefer forward when the failure
   is a narrow mistake inside an otherwise sound change.

## What to write

Write `{{DIAGNOSIS_FILE}}` as JSON:

```json
{ "culprit": { "pullRequest": 1234, "sha": "<sha>" } | null,
  "confidence": "certain|likely|guess|none",
  "error": "<the exact line or symbol from the log, or empty>",
  "remedy": "fix-forward|revert|outside-repository",
  "summary": "<two to five sentences a person can act on; name what to look at first>" }
```

`confidence` is honest: `certain` only when the log names something the culprit's diff introduces.

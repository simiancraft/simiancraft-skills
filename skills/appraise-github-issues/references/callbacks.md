# Size callbacks

What happens after an issue is sized is not the appraiser's decision. A producer (the issue
burndown, a person, another skill) puts files into a directory, and the appraiser looks one up for
the points it just applied and runs it, knowing nothing about what it does. This is the same slot
mechanism `walk-the-floor` uses for `on-pass` and `on-fail`, keyed by size instead of by verdict.

## The directory

`callbacksDir` in the config (default `<worktreeRoot>/appraisal-callbacks`, relative to the
repository root), or `--callbacks <dir>` for one run. The burndown writes the callbacks it ships
into that directory on every start, overwriting its own file names and leaving any others alone,
so an adopter can add a local callback beside the shipped ones.

## The ladder

A Fibonacci scale does not need a file per rung. For an issue sized at N points, the first slot
that exists wins:

| Slot | Matches |
|---|---|
| `on-size-<N>` | exactly N |
| `on-size-over-<M>` | the file with the largest M below N |
| `on-size` | any size |

So `on-size-over-8.md` and `on-size-over-21.md` together mean: 13 runs the first, 34 and up run the
second, and nothing runs for 8 or less unless `on-size` exists.

## The two forms

Each slot name may exist as an executable, as a Markdown prompt (`<name>.md`), or both.

- **The executable** runs first, with the appraisal payload as one line of JSON on stdin, its own
  process group, a timeout of `sizeCallbackTimeoutMinutes` (default 0: no timer, since a callback
  that runs agents cannot be bounded by a minute), and its exit code logged. This is the form for anything load-bearing: a
  label, a pause, a notification. An executable never depends on an agent following prose.
- **The prompt** is one agent turn on the callback seat (`seats.callback`, by default the
  appraiser's own seat), in a scratch directory that is not a checkout. It is rendered with the
  project vocabulary plus `{{ISSUE}}`, `{{TITLE}}`, `{{POINTS}}`, `{{PRIOR_POINTS}}`,
  `{{REASON}}`, and `{{CALLBACK_FILE}}`. It may load another skill by name; that is how a producer
  reaches for work the appraiser does not do, such as breaking a large issue into smaller ones.

The payload on stdin:

```json
{ "issue": 1234, "title": "…", "points": 13, "priorPoints": null, "verdict": "valid",
  "reason": "…", "repo": "owner/repo", "baseBranch": "main", "repoRoot": "/abs/path/to/checkout" }
```

## What a prompt may report

A prompt that writes `loop-callback.json` in its scratch directory has its outcome recorded in the
log and returned to the caller:

```json
{ "outcome": "split", "reason": "three sub-issues opened; see the parent's thread" }
```

Both fields are free text. A prompt that writes nothing is logged as finished without an outcome.
Nothing a callback does can fail the appraisal: the size is already on the issue by the time the
callback runs, and a callback that exits non-zero or crashes is logged and the appraisal continues.

## Rules the appraiser keeps

- A callback runs only for `valid` verdicts, after the size is on the issue. Closes and hand-offs
  have no callback; a close is confirmed instead, and a hand-off is already a person's.
- A callback prompt runs on a seat with the same trust as the appraiser: read-only against the
  repository, able to write to the tracker. Whatever it writes to the tracker is the producer's
  responsibility, and an issue it creates is appraised on a later pass like any other.
- `--dry-run` runs neither form.

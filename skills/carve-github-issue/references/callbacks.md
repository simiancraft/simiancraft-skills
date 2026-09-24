# Callbacks

Two slots, on the shared slot mechanism in `fix-github-issue/lib/callbacks.ts`, in the same
directory the appraiser's size callbacks live (`callbacksDir`, by default
`<worktreeRoot>/appraisal-callbacks`):

| Slot | When |
|---|---|
| `on-carve-pass` | a confirmed `carve`, `amend`, `still-good`, or `exhausted` |
| `on-carve-fail` | a confirmed hand-off (`small-enough`, `indivisible`, `nothing-left`, `too-uncertain`), or a dispute that reached the round cap |

Each may exist as an executable (run by the knife with the payload as one line of JSON on stdin,
its own process group, no timeout, exit code logged) and as a Markdown prompt `<name>.md` (left
for a producer that wants one; the knife does not run it).

## The payload

```json
{
  "key": { "issue": 1282, "generation": 1, "epoch": 1, "revisits": 0, "verdict": "carve" },
  "issue": 1282, "title": "...", "mode": "carve", "verdict": "carve",
  "generation": 1, "seam": "domain", "relation": "layers",
  "children": [1301, 1302], "superseded": [], "paused": [],
  "reason": "...", "repo": "owner/repo", "baseBranch": "main", "repoRoot": "/abs/path"
}
```

## When a callback replays

A callback runs before the write that completes its intent (the `live` record, `loop/released`),
so a run that dies between the two replays the callback when the next run finishes the intent.
That is the only way a callback runs twice. A callback with a side effect keys on `key`: the same
`{issue, generation, epoch, revisits, verdict}` is the same event. A callback's exit code is logged
and a non-zero exit is not retried; the knife cannot tell a failed side effect from a completed
one, and nothing a callback does can fail the carve.

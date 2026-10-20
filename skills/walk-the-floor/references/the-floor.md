# The floor

The directory contract between the walker and whoever feeds it. Everything the walker reads or
writes lives in one directory, the floor, passed as `--dir`. Anything that can write a file can
put work on the floor: a person with an editor, the issue burndown, another skill, or the walker's
own forge producer. The walker never reads anything else about the caller.

## Files

| File | Written by | Read by | Shape |
|---|---|---|---|
| `list.jsonl` | anyone | the walker | one list item per line, append only |
| `ledger.jsonl` | the walker | anyone | one ledger entry per line, append only |
| `on-pass`, `on-pass.md` | whoever started the walker | the walker | callbacks; see below |
| `on-fail`, `on-fail.md` | whoever started the walker | the walker | callbacks; see below |
| `evidence/` | the walker | anyone | screenshots and captures, named by item id and time |
| `floor.lock` | the walker | the walker | pid of the running walker; released on exit |

Nothing edits or removes a line in either `.jsonl` file. "Done" is a ledger entry, not a change to
the list, so two processes never race on a rewrite and a crash mid-write loses at most one line.

## A list item

```json
{ "id": "pull-request:1234", "addedAt": "2026-01-01T00:00:00Z", "source": "burndown",
  "text": "fix(search): return an empty result set as a page, not an error",
  "ref": { "pullRequest": 1234, "sha": "<merge commit>", "mergedAt": "2026-01-01T00:00:00Z",
           "paths": ["src/search/results.tsx"] } }
```

- `id` is the only required field besides `text`. Two items with the same id are one item; the
  walker keeps the first and ignores the rest, so a producer may append without checking.
- `ref` is optional. With it the walker can classify the item against the deployed revision and
  pick standing walks by the paths it touched. Without it the item is free text and the walker
  reads it as an instruction: "the header now shows the new logo" is a valid item.
- `source` is free text naming the producer. The walker's own forge producer writes `forge`.

## A ledger entry

```json
{ "itemId": "pull-request:1234", "checkedAt": "2026-01-01T00:10:00Z",
  "deployedRevision": "<sha>", "rung": "look", "verdict": "present",
  "reason": "the form now refuses submission with an empty postal code",
  "evidence": "evidence/pull-request-1234-2026-01-01T00-10-00Z.png" }
```

`rung` says how far the walker got; `verdict` says what it found. Both come from closed
vocabularies, and the walker refuses to write an entry outside them.

### Rungs

| Rung | Meaning |
|---|---|
| `liveness` | the in-process probe of the base URL and health paths; no agent involved |
| `classify` | the driver compared the merge to the deployed revision; no agent involved |
| `look` | navigated to the surface the change lives on and read it |
| `exercise` | performed the ordinary user action that runs through the change |
| `fallback` | an endpoint call, a database read, or a file check, because no surface exists |
| `exists-in-git` | the change is a file nothing renders; confirmed present on the base |

### Verdicts

| Verdict | Kind | Meaning |
|---|---|---|
| `present` | terminal | the change is observable where it should be |
| `intact` | terminal | the surface works; the change itself is not observable from outside |
| `not-checkable` | terminal | observing it would need an external side effect or credentials the config does not provide; the reason says which |
| `absent` | pending repair | the deployed revision includes the merge and the change is not there |
| `down` | pending repair | liveness failed |
| `not-yet-deployed` | pending | the merge is not an ancestor of the deployed revision; walked again next wake |
| `unverified` | pending | no revision signal and inside the grace window; walked again next wake |

The split matters. A terminal verdict retires the item. A pending verdict leaves it on the walk
list. `absent` and `down` are verdicts, not pending states: the walker knows the environment is
wrong, files an incident, attempts the fix, and walks the item again on the next wake; a second
failure while that incident is open files nothing new. `not-checkable` is a
known unknown, kept honest by its reason, and never the default; an item the walker cannot classify
gets no entry and is walked again next wake.

## Callbacks

After every terminal or repair-pending entry, the walker looks for a callback by name:

- `on-pass` after `present`, `intact`, and `not-checkable`
- `on-fail` after `absent` and `down`, **before** any incident is filed or fix attempted

Nothing runs after `not-yet-deployed` or `unverified`, and neither callback runs inside a
configured quiet window, where a `down` is expected rather than evidence.

A callback is either or both of:

- **an executable** (`on-fail`, mode `+x`): the walker runs it with the ledger entry as JSON on
  stdin and a sixty-second timeout, logs its exit code, and continues whatever it returned;
- **a prompt** (`on-fail.md`): the walker appends its text to the agent's next turn verbatim.

The executable form exists because a safety interlock must not depend on an agent following a
prompt. The issue burndown uses an `on-fail` executable to pause its own merge queue and an
`on-fail.md` prompt to ask for narrative it does not need to trust. Anything that starts the
walker can do the same; the walker does not know what either file does.

## An incident

When a verdict is `absent` or `down`, the walker files an issue on the configured repository with
the label `floor/incident`, carrying the ledger entry, the last clean entry, the merges between
their revisions, and a log excerpt, then hands that issue to the `fix-github-issue` skill. Filing is
intrinsic rather than a callback because the fix pipeline is issue-shaped and needs one to work.
An open `floor/incident` issue naming the same item suppresses a second filing.

# The floor

Checks run before a merge; the floor checks after the deploy. Every merge the loop makes goes up
onto the floor, and on a cadence the loop goes and looks at the running environment the base
branch deploys to, to the standard **would a user notice**. When the environment is down or a
change is absent, the walk pauses the line, files an incident, and hands it to the fix pipeline.
A run is done when its merges are verified there, not when they land.

Sanity, not integration. Go to the thing and look. If the change is a label, read it; if it is
behind a surface, do the ordinary user action that runs through it; if there is no surface, hit
the endpoint or read the database and say so. A site that boots, renders, and returns nothing for
every search has no data, and only searching tells you. A walk proves a user would not hit a wall;
it does not prove the change is correct.

## The parts

| Part | Where | Replace it by |
|---|---|---|
| Cadence | `floor.every` | minutes, or a function of the floor's state |
| Merge-up | the pipeline's `afterMerge` hook, plus other merges read from the forge each walk | `forge: false`, or appending your own items to `list.jsonl` |
| The walk | `prompts/walk.md`, one agent turn on the walker seat | `walks` in the config, and `--walker` |
| The ledger | `ledger.jsonl`, append only | nothing; it is the floor's memory |
| The readout | an emoji readout (`emoji-readout`) after every walk with news | an `on-walk` callback that sends it somewhere |
| On a walk | the `on-walk` slot | an executable, a prompt, or both |
| On a failure | pause the line, the `on-walk-fail` slot, an incident | an executable, a prompt, or both |
| The drain | `floor.drainMinutes` at the end of a run | `loop.ts --floor drain` later |

## The config block

In `burn-down-github-issues.config.ts`, beside `project`. Absent means no floor.

```ts
floor: {
  // Minutes between walks, or a function of { pending, wrong, paused, draining }.
  // A function that throws or returns nonsense falls back to 10.
  every: ({ pending, wrong }) => (wrong ? 2 : pending > 0 ? 5 : 20),
  drainMinutes: 60, // at the end of a run, how long to keep walking until every merge is verified
  forge: true, // also walk merges this loop did not make (a person's, another tool's)
  environment: {
    kind: 'web', // 'web' | 'ios' | 'android'; picks the driver skill the walk prompt loads
    // driverSkill: 'expo-ios-simulator', // a stack-specific driver in place of the kind's default
    baseUrl: 'https://staging.example.com',
    healthPaths: ['/', { path: '/graphql', method: 'POST', body: '{"query":"{__typename}"}', headers: { 'content-type': 'application/json' } }],
    probeTimeoutMs: 10000,
    revisionCommand: 'curl -s https://staging.example.com/version', // optional; prints the running SHA
    logsCommand: 'your-host logs --tail 200', // optional; read when a walk fails
    login: { url: 'https://staging.example.com/login', userEnv: 'FLOOR_USER', passwordEnv: 'FLOOR_PASSWORD' },
    safeEndpoints: [], // paths the walker may POST to; default none
    graceMinutes: 15, // with no revisionCommand, how long after a merge an item stays `unverified`
    quietWindows: [{ start: '02:00', end: '02:30' }], // UTC; a nightly rebuild is not an incident
  },
  walks: [
    { name: 'search returns records', paths: ['src/search/'], steps: 'Sign in, search for a term you know has results, and confirm at least one record renders.' },
  ],
},
```

The walker seat is `seats.walker` (`--walker` for one run); an `on-walk.md` or `on-walk-fail.md`
prompt runs on `seats.callback`. Login fields are environment variable **names**; the loader refuses
anything that looks like a value, and the values live only in the shell that starts the loop.

| `kind` | Default driver | "Go and look" means |
|---|---|---|
| `web` | `playwright-harness` | navigate, read, click, screenshot in headless Chromium |
| `ios` | `ios-simulator` | boot the simulator, launch the app, drive by accessibility |
| `android` | `android-emulator-harness` | boot the emulator, install the build, drive with Maestro |

## One walk, in order

1. **Liveness.** The driver fetches the base URL and every health path itself, no agent. A path
   that does not answer 2xx or 3xx is `down`, and nothing else is walked this time.
2. **Classify.** Each pending item with a merge SHA is checked against the deployed revision:
   `not-yet-deployed` when it is not an ancestor, `unverified` inside the grace window when there
   is no revision signal. Recorded only when the verdict changes.
3. **Walk.** One agent turn for every remaining item, in a read-only checkout at the deployed
   revision, with the standing walks whose paths match the item's. The driver validates each
   verdict against the vocabulary below before it reaches the ledger. A passing item's card moves
   to **Verified on the floor**.
4. **On a failure.** An item that has just turned `down` or `absent` pauses the line and runs
   `on-walk-fail`; an item that stays wrong does neither again on later walks, so a notifier in
   `on-walk-fail` hears about an outage once, not every walk. Then each wrong item is diagnosed and its
   incident filed (or found) and worked; see below.
5. **Release.** When nothing on the floor is wrong, the floor releases a pause it wrote.
6. **Readout.** A walk with news (any item verdict, liveness changing, a note) prints its readout
   and runs `on-walk`. A walk that found nothing new (still up, nothing to walk) is silent.

```
14:20 CDT · floor walk

- ✅ Verified: PR #812 fix(search): return an empty page: present (look)
- 🔄 Pending: PR #815 feat(export): add CSV: not yet deployed
- 🩺 Health: up: / 200 120ms; /api/health 200 41ms; deployed 9f3c2a1b7e
- ⛔ Nothing waiting on you.
```

Inside a quiet window a walk still probes, records, and prints its readout, so the ledger stays
honest, but it pauses nothing, runs no callback, files nothing, and leaves item walks to the next
one. An outage that outlasts the window is handled on the first walk after it.

## The floor directory

`<worktreeRoot>/floor/`. Anything that can append a line can put work on it.

| File | Written by | Shape |
|---|---|---|
| `list.jsonl` | the loop, a person, anything | one item per line, append only |
| `ledger.jsonl` | the walk | one entry per line, append only |
| `evidence/` | the walker | screenshots named by item id and time |

Nothing edits or removes a line in either file. "Done" is a ledger entry, not a change to the
list, so a crash mid-write loses at most one line and the next walk re-derives it.

```json
{ "id": "pull-request:812", "addedAt": "…", "source": "burndown", "text": "fix(search): return an empty page",
  "ref": { "issue": 640, "pullRequest": 812, "sha": "<merge commit>", "mergedAt": "…", "paths": ["src/search/results.tsx"] } }
```

`id` and `text` are required; the first item with an id wins, so producers append blindly. Without
`ref` an item is free text the walker reads as an instruction ("the header now shows the new
logo"). The ledger entry carries `itemId`, `checkedAt`, `deployedRevision`, `rung`, `verdict`,
`reason`, and optionally `evidence`, plus `quiet` on an entry recorded inside a quiet window.

| Rung | Meaning |
|---|---|
| `liveness` | the in-process probe; no agent |
| `classify` | the merge compared to the deployed revision; no agent |
| `look` | navigated to the surface the change lives on and read it |
| `exercise` | performed the ordinary user action that runs through the change |
| `fallback` | an endpoint call, a database read, or a file check, because no surface exists |
| `exists-in-git` | the change is a file nothing renders; confirmed on the base |

| Verdict | Kind | Meaning |
|---|---|---|
| `present` | terminal | the change is observable where it should be |
| `intact` | terminal | the surface works; the change itself is not observable from outside |
| `not-checkable` | terminal | looking would need a side effect or credentials the config does not give; the reason says which |
| `absent` | wrong | the deployed revision includes the merge and the change is not there |
| `down` | wrong | liveness failed |
| `not-yet-deployed` | pending | walked again next time |
| `unverified` | pending | walked again next time |

`not-checkable` is a known unknown kept honest by its reason, never a default; an item the walker
did not reach gets no entry and is walked again.

## The callbacks

Two slots in the loop's `callbacksDir`, beside the size callbacks. Each may be an executable
(run with JSON on stdin, sixty seconds, exit code logged) and a `.md` prompt (one agent turn on
the callback seat, in a scratch directory, rendered with the project vocabulary). Neither can stop
a walk; a callback that fails is logged. A prompt is awaited, so it delays the walk's end, and a
drain's, by as long as its turn takes.

| Slot | Runs | Payload / prompt variables |
|---|---|---|
| `on-walk` | after every walk with news | the walk (`entries`, `wrong`, `pending`, `incidents`, `readout`) / `{{READOUT}}`, `{{WALK}}`, `{{FLOOR_DIR}}` |
| `on-walk-fail` | when an item turns wrong, before its incident | `entry`, `item` / `{{ITEM}}`, `{{VERDICT}}`, `{{REASON}}`, `{{ENTRY}}`, `{{FLOOR_DIR}}` |

Both payloads also carry `repo`, `baseBranch`, `repoRoot`, and `floorDir`. Paging someone is an
`on-walk-fail` executable; posting each readout to a channel is an `on-walk` executable; asking an
agent to comment on the culprit pull request is an `on-walk-fail.md` prompt. A prompt that writes
`{{CALLBACK_FILE}}` as `{ "outcome": "…", "reason": "…" }` has that recorded in the log. The pause
itself is not a callback: an interlock never depends on a file an adopter might delete.

## The line

A wrong walk writes `pause` and a reason beginning `floor:` to `<worktreeRoot>/runs/line-switch`,
naming everything on the floor that is wrong. It never overwrites a pause a person set, and it
releases only its own, on the first walk that finds nothing on the floor wrong. After an incident's
fix merges, that is the next walk, so a cadence like `wrong ? 2 : …` keeps the wait short. An item
whose incident a person owns holds the pause until it walks clean or someone clears the switch. A
person who writes `go` while the floor is still wrong is obeyed: the floor pauses again only when
another item turns wrong. What a paused
line holds is listed once in `operating.md`, "When the line is paused".

## Incidents

For each wrong item, one diagnosis turn on the walker seat reads the failing entry, the last clean
one, the pull requests merged between their revisions, and the logs, then names a culprit with an
honest confidence. The floor files an issue labelled `floor/incident` with all of that (or finds the
open one for the item) and hands it to `fix-github-issue` like any other issue. Its fix merges
through the floor's own pause (it is the merge that makes the next walk come back clean) but still
waits on a pause a person set; it lands through a pull master of its own, since the lanes' one may
be held by a lane waiting at that very pause, and its merge goes up onto the floor too. The readout lists an incident the floor is
repairing under 🔄, and under ⛔ only once a person owns it.

A diagnosis whose remedy is outside the repository (a reindex, a config value, a vendor outage)
parks the incident for a person instead. An incident with a person, parked or dead-lettered or
held, is not worked again, and neither is one still open in the pipeline; the item is still
walked every time, so the ledger notices when it comes right, and the drain does not wait on it.
Only a new failure, or a failure whose incident has closed, is diagnosed and worked again, and not
while the fix that closed it is still waiting to deploy.

## Run it alone

`--floor` walks without working the backlog, under the instance lock, so it never races a run.
A walk that finds something wrong still pauses the line and runs the callbacks, and every mode but
`liveness` files and fixes its incident. A dry run, or a walk of another URL with `--base-url`, is
a rehearsal: it probes, classifies, and prints its readout, and writes nothing (ledger, line,
callbacks, incidents), since another URL is not the environment the ledger describes:

```bash
bun run <this-skill-dir>/loop.ts --floor liveness          # probe once (a down still pauses the line); the first thing to run
bun run <this-skill-dir>/loop.ts --floor once              # one full walk; exits 1 if anything is wrong
bun run <this-skill-dir>/loop.ts --floor once --dry-run    # probe and classify; no agent, no write, nothing filed
bun run <this-skill-dir>/loop.ts --floor drain             # walk until every merge on the floor is verified
bun run <this-skill-dir>/loop.ts --floor watch             # walk on the cadence until Ctrl+C
bun run <this-skill-dir>/loop.ts --floor once --base-url http://localhost:9   # rehearse the down path against a dead port
```

First-run order: `liveness`; then three items appended by hand (one visible change, one
behavioural, one file nothing renders) and `once`, reading every reason in the ledger as something
you could repeat; then `watch` for an hour in a terminal you can see; only then a full run.

## Standing walks and safe endpoints

A standing walk is a paragraph an agent can follow, keyed to path prefixes (`src/search/`) or bare
suffixes (`.schema.ts`); the loader refuses globs. Name what to open, what to do, and what working
looks like. A handful covering what a user touches daily (sign in, the main list, one record, one
search) beats dozens covering everything.

`safeEndpoints` says: posting here has no external side effect, bills nobody, reaches no third
party, and anything it creates can be soft-deleted. Anything touching payment, email, or a partner
system does not qualify, and items behind it are `not-checkable`. Every write a walk makes is
additive, tagged `inspector-<timestamp>`, and reverted, by contract rather than by sandbox: run the
floor only against an environment where a stray tagged record is tolerable.

## The ceiling, named

The drain at the end of a run waits on the merges that run made, walking first and then on the
cadence; `--floor drain` waits on everything on the floor. Its window bounds when a walk may start,
not how long one runs: a walk under way when the window closes, an incident fix among its steps,
finishes first, so the lock can outlive the window by one walk, and by as long as a person's pause
holds that fix at its merge.

The walker's sense of "the change is there" is agent judgement: sharp on visible changes, blunt on
behavioural ones, honest only while it says `not-checkable` rather than `intact` for what it did not
reach. A change with no surface a driver can reach stays unverified. And a walk is a sample:
something that breaks between two walks is caught on the next one, which is what a programmable
cadence is for.

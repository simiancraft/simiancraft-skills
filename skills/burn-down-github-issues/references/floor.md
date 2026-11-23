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
    deployWorkflow: 'Deploy', // optional; the workflow that deploys the base, read when there is no running SHA
    deployCapMinutes: 180, // how long a merge waits for deploy evidence before it is `deploy-unconfirmed`
    logsCommand: 'your-host logs --tail 200', // optional; read when a walk fails
    login: { url: 'https://staging.example.com/login', userEnv: 'FLOOR_USER', passwordEnv: 'FLOOR_PASSWORD' },
    safeEndpoints: [], // paths the walker may POST to; default none
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
2. **Classify.** Each pending item with a merge SHA is walked only on evidence that its merge is
   deployed (see "Deploy evidence" below); without it the item is `not-yet-deployed`, and
   `deploy-unconfirmed` once `deployCapMinutes` have passed since the merge. Recorded only when the
   verdict changes. An item `owed-by-sibling` is not
   walked while that sibling is open, or merged with its own floor item not yet verified.
3. **Walk.** One agent turn for every remaining item, in a read-only checkout at the deployed
   revision, with the standing walks whose paths match the item's. An item whose issue is known
   carries that issue's body, and the walker judges the item against that acceptance, not against
   the outcome of the trunk it was carved from; a carved child also carries the trunk's open
   children. The driver validates each verdict against the vocabulary below before it reaches the
   ledger. A passing item's card moves to **Verified on the floor**.
4. **On a failure.** A carved child that has just turned `absent` while its trunk has open
   children is diagnosed first, before anything pauses (see "Owed by a sibling" below). Then an
   item that has just turned `down` or `absent` pauses the line and runs
   `on-walk-fail`; an item that stays wrong does neither again on later walks, so a notifier in
   `on-walk-fail` hears about an outage once, not every walk. Then each wrong item is diagnosed and its
   incident filed (or found) and worked; see below.
5. **Release.** When nothing on the floor is wrong, the floor releases a pause it wrote.
6. **Readout.** A walk with news (any item verdict, liveness changing, a note) prints its readout
   and runs `on-walk`. A walk that found nothing new (still up, nothing to walk) is silent.

```
14:20 CDT · 40m in · floor walk

- ✅ Verified: PR #812 fix(search): return an empty page: present (look)
- 🔄 Pending: PR #815 feat(export): add CSV: not yet deployed
- 🩺 up: / 200 120ms; /api/health 200 41ms; deployed 9f3c2a1b7e
- 🟢 Nothing needs you.
```

Inside a quiet window a walk still probes, records, and prints any news, so the ledger stays
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
`reason`, and optionally `evidence`, plus `quiet` on an entry recorded inside a quiet window and
`sibling` on an `owed-by-sibling` entry.

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
| `deploy-failed` | wrong | the deploy run for the merge failed, timed out, or never started, or was cancelled with no later run containing the merge; the reason carries the run's URL |
| `not-yet-deployed` | pending | walked again next time |
| `deploy-unconfirmed` | pending | still no deploy evidence `deployCapMinutes` after the merge; named under ⚠️ on every readout, never an incident, and the drain does not wait on it; walked once evidence arrives |
| `unverified` | pending | no longer assigned; read in older ledgers only |
| `owed-by-sibling` | pending | the missing effect belongs to the open sibling issue in `sibling`; walked again once that sibling lands |

`not-checkable` is a known unknown kept honest by its reason, never a default; an item the walker
did not reach gets no entry and is walked again.

## Deploy evidence

A merge is deployed when there is evidence of it, never because time has passed:

- **`revisionCommand`** prints the running commit: the merge is deployed when that commit
  contains it. When the command prints one, it decides alone.
- **`deployWorkflow`**, read when there is no running commit to compare: the merge is deployed once
  a run of that workflow (its name or file, as `gh run list --workflow` takes it) for the merge
  commit has completed successfully. A run that is queued, pending, waiting, requested, or in
  progress has not deployed it yet. When none is, and the newest run failed, was cancelled, timed
  out, or never started, the merge is `deploy-failed`: a wrong verdict, with the run's URL in its
  reason, that pauses the line and files an incident diagnosed like any other (a broken build or
  bundle is a fault in the repository). A later successful run clears it. A cancelled run is
  judged against the workflow's later runs on the base branch first: a workflow that cancels in
  progress cancels each back-to-back merge's run for the next, so a later run for a commit that
  contains the merge carries it (deployed once that run succeeds, `not-yet-deployed` while it has
  not), and the merge is `deploy-failed` only when nothing later contains it.

A merge without evidence is `not-yet-deployed` and is not walked, so a backend change whose deploy
is still running is never judged `absent` or `intact` against the build before it. After
`deployCapMinutes` (default 180) with still no evidence it is `deploy-unconfirmed`: the floor looked
and cannot tell. That is shown in the readout, files no incident, and pauses nothing; the item is
classified again every walk and walked as soon as evidence appears. With neither knob set, no merge
can be shown deployed, so every merge ends `deploy-unconfirmed`, and the floor says so when it
starts; set one. `graceMinutes` is still accepted but decides nothing, and the floor says that when
it starts too.

## Owed by a sibling

A trunk carved into children has its outcome spread across them: one child changes what new
installs create while its sibling migrates the rows that already exist. The first child's merge
can be correct while the trunk's outcome is still missing, and that missing part is the open
sibling's work, not a failure. Two checks keep it that way.

- **The walker.** It sees the item's own acceptance and the trunk's open children, and records
  `owed-by-sibling` with `sibling` set when what it finds missing is an effect an open sibling
  owns. The driver keeps that verdict only when `sibling` names a child open under the same trunk;
  naming anything else leaves the effect with nobody coming to supply it, so it is recorded
  `absent`.
- **The diagnosis.** A carved child that turns `absent` with open siblings is diagnosed before the
  line pauses. A diagnosis whose remedy is `owed-by-sibling` and names an open sibling is recorded
  as that verdict after the `absent`, so the item is not wrong: nothing pauses, `on-walk-fail` does
  not run, and no incident is filed or fixed. Any other diagnosis is the one the incident uses.

An item owed by a sibling is not walked again while that sibling is open, or while the sibling's
own merge is on the floor and not yet verified; then it is walked again against its acceptance.
The drain does not wait on it, since the sibling's merge, not this run's, is what settles it.

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

A wrong walk writes `pause` and a reason beginning `floor:<cause>:` to
`<worktreeRoot>/runs/line-switch`, naming everything on the floor that is wrong. The cause says
what the floor knows about where the remedy lies, so the kind of pause is readable from the switch
and survives a restart:

| Cause | What the floor knows |
|---|---|
| `undiagnosed` | something is wrong and no diagnosis has answered yet; the walk writes this at once |
| `cause-unknown` | a diagnosis ran and could not say (it failed, or gave no usable answer) |
| `in-repository` | the diagnosis places the remedy in this repository (`fix-forward` or `revert`) |
| `outside-repository` | the diagnosis places the remedy outside it: a vendor or host outage, a reindex, a config value |

Each diagnosis restates the pause as soon as it answers. With several items wrong the pause is
`outside-repository` only when every one is; any item that is the repository's, or not known to be
anyone's, makes it the stricter cause. A bare `floor:` reason from an earlier version reads as
`undiagnosed`. It never overwrites a pause a person set, and it
releases only its own, on the first walk that finds nothing on the floor wrong. After an incident's
fix merges, that is the next walk, so a cadence like `wrong ? 2 : …` keeps the wait short. An item
whose incident a person owns holds the pause until it walks clean or someone clears the switch. A
person who writes `go` while the floor is still wrong is obeyed: the floor pauses again only when
another item turns wrong.

The cause decides what the pause holds. Every cause but `outside-repository` is a repair: the
floor's own fault, or one nobody can yet say is not, so merges wait, no new lane starts, and the
incident's fix runs first. Lanes already under way finish their turn and wait at the merge; nothing
is stopped. `outside-repository` is an outage: the remedy is not code, so the pause holds only the
merge (merging is what deploys into the downed environment). Appraisal, carving, coding, proving,
and review go on, new lanes start, and approved pull requests stack in the landing line. The floor
keeps walking on its cadence; the first walk that finds the floor right lifts the pause, and the
stacked pull requests land one at a time through the pull master, each caught up to the one before,
each walked as it deploys. The readout shows an outage under ⚠️ with the count of pull requests
waiting at the merge. What a paused line holds, seam by seam, is listed once in `operating.md`,
"When the line is paused".

## Incidents

For each wrong item, one diagnosis turn on the walker seat reads the failing entry, the last clean
one, the pull requests merged between their revisions, and the logs, then names a culprit with an
honest confidence. The floor files an issue labelled `floor/incident` with all of that (or finds the
open one for the item) and hands it to `fix-github-issue` like any other issue. Its fix merges
through the floor's own pause (it is the merge that makes the next walk come back clean) but still
waits on a pause a person set; it lands through a pull master of its own, since the lanes' one may
be held by a lane waiting at that very pause, and its merge goes up onto the floor too. A fix that
repairs forward lands without a person, as any change `autoMerge` allows does. A fix that undoes a
recently merged pull request (the culprit the incident names, or any merge still on the floor)
parks at the merge boundary whatever `autoMerge` says, on every path that lands it (the floor's, a
resumed lane, an ordinary one), because its premise is a walk of a live environment and a walk can
be wrong (a deploy still running reads as absent). The fix undoes a merge when it is a `git revert`
of it, deletes a file the merge added, restores one it deleted, puts back a line the merge removed,
or only removes lines the merge added from a file; a change that rewrites the merge's lines into
new ones is a forward repair. A person confirms a parked one with `fix.ts --land`. The readout lists an incident the floor is
repairing under 🔄, and under ⛔, on every walk until it is resolved, once a person owns it. Its ⛔
line names the item's newest verdict and the way out: an approved fix parked at the merge boundary
is landed with `fix.ts --land <n>` (lifting its label would only hand it to a run that parks it
again); any other park is handed back by lifting its label.
Resolved is read fresh on every walk, not remembered from when the incident was filed. Each walk
reads once who owns every wrong item: the floor while its incident is open with the fix pipeline, a
person once a label hands it to one, nobody when no incident is open. The readout, the line's
cause, the drain, and the landing hint all read that one snapshot. The ⛔ line
stays only while the item's newest ledger verdict is still wrong and its incident is still open with
a person, including an incident an earlier run left parked. An item that walks right, or whose incident is closed or handed back, leaves it (and the
drain stops treating it as a person's); a tracker that cannot be read leaves the line standing.

A diagnosis whose remedy is `owed-by-sibling` files nothing; see "Owed by a sibling" above.
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

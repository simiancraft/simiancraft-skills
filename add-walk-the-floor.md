# Add `walk-the-floor`, a list checker and fixer for a running environment

**Status:** Draft
**Scope:** cross-stack
**Date:** 2026-09-01
**Last reviewed:** 2026-09-01
**Context:** A merged change can take a deployed base branch down without any gate in the burndown seeing it: every gate is a build, a type check, or a test, and none of them boots the result.
**Depends on:** `extract-fix-github-issue.md` fully shipped; `fixIssue(ctx, issue)` importable from `skills/fix-github-issue/lib/pipeline.ts`.

## Goal

The burndown proves each change before it merges, and that proof has a ceiling: it never runs the deployed result. A change that passes every check and then crashes the environment on boot, or renders the site wrong, or empties the search index, goes unnoticed until a person looks, and every merge after it lands on a broken base.

This plan adds a second skill, `walk-the-floor`: a machine that wakes on a cadence, reads a list of things that should now be true in a running environment, goes and looks at each one to a sanity standard (would a user notice), records what it found in a ledger, and when something is wrong files an incident and fixes it through `fix-github-issue`. It knows nothing about the burndown. Two conventional callback slots, `on-pass` and `on-fail`, let whoever started it add behavior; the burndown uses `on-fail` to pause its own line.

Done looks like: the walker runs alone against any configured environment from a hand-written list, and the burndown, when configured with a floor directory, starts it, feeds it every merge, and stops merging the moment a walk fails.

## Domain context

- **The floor.** A directory the walker is pointed at. This feature is about the floor; its children are **walks**. It holds the list, the ledger, the two callbacks, and a lock. Anyone can write the list: a person, the burndown, another skill, or the walker's own forge producer.
- **List item.** One thing that should now be true. Free text with an optional reference (a pull request number, its merge SHA, its touched paths). Append-only; nothing edits or removes an item.
- **Ledger entry.** The walker's record of one check of one item: the rung it reached, the verdict, the evidence, the deployed revision, the time. Append-only. "Done" is a ledger entry with a terminal verdict; the list never shrinks.
- **Rung.** How far the walker could get: `look` (navigate to the surface and read it), `exercise` (perform the ordinary user action that runs through the change), `fallback` (an endpoint, a database read, or a file check), `exists-in-git` (the file landed on the base; nothing renders it). Plus `liveness`, the in-process probe that needs no agent.
- **Verdict.** `present` (the change is observable), `intact` (the surface still works; the change itself is not observable), `absent` (deployed revision includes the merge and the change is not there), `down` (liveness failed), `not-yet-deployed` (merge SHA is not an ancestor of the deployed revision; pending), `unverified` (no revision signal and inside the grace window; pending), `not-checkable` (observing it would require an external side effect or credentials the config does not provide; terminal, with the reason).
- **Callback.** `on-pass` and `on-fail`, found by name in the floor. Either an executable, run by the driver with the ledger entry as JSON on stdin before anything else happens, or a Markdown prompt, handed to the walker verbatim. Both may exist; the executable runs first. The executable form exists because a safety interlock must not depend on an agent following a prompt.
- **Incident.** An issue the walker files when a verdict is `down` or `absent`: the ledger entry, the last clean entry, the suspect merges between them from the forge, and a log excerpt. Filing it is intrinsic, not a callback, because the fix pipeline is issue-shaped and needs one to work.
- **Standing walk.** A named, prose-described sanity walk in the config, keyed to path globs: "log in, open global search, search a known term, confirm at least one record renders". The driver picks walks by the item's touched paths; the walker improvises the `look` rung on top.

## Current surface area

| Thing | State today |
|---|---|
| `skills/fix-github-issue/lib/pipeline.ts` `land()` | merges after green checks; no hook to refuse a merge from outside, no boot of the branch before merging |
| `skills/fix-github-issue/lib/context.ts` | no `mayMerge` predicate |
| `skills/fix-github-issue/lib/config.ts` `ProjectConfig` | no `smokeCommand` |
| `skills/burn-down-github-issues/loop.ts` `main()` | claims issues and dispatches `fixIssue` with no external stop; no post-merge hook |
| `skills/burn-down-github-issues/references/adopting.md` config template | no `floor` section |
| `skills/playwright-harness`, `skills/expo-ios-simulator`, `skills/android-emulator-harness` | the drivers the walker loads by name per environment kind; unchanged by this plan |
| `README.md` | no row for the walker |

## File structure: before

**Legend:** ✏️ rewritten

```
simiancraft-skills/
├── ✏️ README.md
└── skills/
    ├── fix-github-issue/
    │   └── lib/
    │       ├── ✏️ config.ts                      // adds smokeCommand
    │       ├── ✏️ context.ts                     // adds mayMerge and afterMerge hooks
    │       └── ✏️ pipeline.ts                    // land() honors both, runs smokeCommand before merging
    └── burn-down-github-issues/
        ├── ✏️ loop.ts                            // reads the switch, feeds the floor, starts the walker
        └── references/
            ├── ✏️ adopting.md                    // floor section in the template
            ├── ✏️ architecture.md                // the line and the walker
            └── ✏️ operating.md                   // what pause looks like
```

## File structure: after

**Legend:** 🆕 new · ✏️ rewritten

```
simiancraft-skills/
├── ✏️ README.md
└── skills/
    ├── 🆕 walk-the-floor/
    │   ├── 🆕 SKILL.md
    │   ├── 🆕 walk.ts                            // CLI: --dir <floor> [--once | --every <min>] [--liveness-only] [--walker engine:model] [--dry-run]
    │   ├── 🆕 lib/
    │   │   ├── 🆕 floor.ts                       // list, ledger, pending, lock; the directory contract
    │   │   ├── 🆕 config.ts                      // WalkConfig and loader; re-exports ProjectConfig from the fix skill
    │   │   ├── 🆕 liveness.ts                    // in-process probe
    │   │   ├── 🆕 revision.ts                    // deployed revision and ancestry
    │   │   ├── 🆕 callbacks.ts                   // on-pass / on-fail, executable or prompt
    │   │   ├── 🆕 forge.ts                       // merged-since producer
    │   │   └── 🆕 incident.ts                    // file the issue, hand it to fixIssue, re-walk
    │   ├── 🆕 prompts/
    │   │   ├── 🆕 walk.md                        // one turn, every pending item, three rungs, one verdict file
    │   │   └── 🆕 diagnose.md                    // down or absent: suspects, logs, culprit, fix-forward or revert
    │   └── 🆕 references/
    │       ├── 🆕 the-floor.md                   // directory contract, schemas, verdict vocabulary, callbacks
    │       ├── 🆕 adopting.md                    // config template, environment kinds, authoring walks, preconditions
    │       └── 🆕 operating.md                   // once vs forever, reading the ledger, what an incident looks like
    ├── fix-github-issue/
    │   └── lib/
    │       ├── ✏️ config.ts
    │       ├── ✏️ context.ts
    │       └── ✏️ pipeline.ts
    └── burn-down-github-issues/
        ├── ✏️ loop.ts
        └── references/
            ├── ✏️ adopting.md
            ├── ✏️ architecture.md
            └── ✏️ operating.md
```

## Commits

Gate vocabulary: **typecheck** is `bunx tsc --noEmit -p .`; **dry run** is the burndown's `--dry-run` from the first adopter's tooling worktree; **scratch floor** is a temporary directory created for the gate and removed after it.

### Commit 1: give the pull master a smoke gate and two hooks

**Goal:** The fix pipeline can boot a branch before merging it and can be told not to merge, without learning why.

**Files rewritten:**
- `skills/fix-github-issue/lib/config.ts`: `ProjectConfig.smokeCommand?: string`, documented as "run in the lane after checks are green and before the merge; a non-zero exit parks the pull request with the command's tail as the reason. Boot the thing here; a build is not a boot."
- `skills/fix-github-issue/lib/context.ts`: `mayMerge?: () => { ok: true } | { ok: false; reason: string }` and `afterMerge?: (event: { issue: number; pr: number; sha: string; mergedAt: string; paths: string[] }) => void`.
- `skills/fix-github-issue/lib/pipeline.ts` `land()`: after `awaitGreenChecks` succeeds and before `gh pr merge`, run `smokeCommand` in the lane if set, park on failure; then consult `ctx.mayMerge` and return `'park'` with its reason when refused, without spending a review round; after a confirmed `mergedAt`, call `ctx.afterMerge`.
- `skills/fix-github-issue/references/pipeline.md`: the smoke gate paragraph, and the two hooks under "Embedding the pipeline".

**Gate:** typecheck. A `fix.ts --issue N` run with `smokeCommand: 'false'` in a scratch copy of the adopter config parks with the reason naming the smoke command; with `smokeCommand` unset, behavior is unchanged from the extraction plan's final run.

### Commit 2: create the floor contract and the liveness probe

**Goal:** The smallest useful walker: point it at a directory and a URL, and it tells you whether the environment is up.

**Files created:**
- `skills/walk-the-floor/lib/floor.ts`: file names (`list.jsonl`, `ledger.jsonl`, `on-pass`, `on-pass.md`, `on-fail`, `on-fail.md`, `floor.lock`), `ListItem` and `LedgerEntry` types, `readList`, `readLedger`, `appendItem`, `appendEntry`, `pending(list, ledger)` (items whose latest entry is missing or non-terminal), `claimFloorLock`.
- `skills/walk-the-floor/lib/config.ts`: `WalkConfig = { project: ProjectConfig; environment: { kind: 'web' | 'ios' | 'android'; baseUrl?: string; healthPaths: string[]; revisionCommand?: string; logsCommand?: string; login?: { url: string; userEnv: string; passwordEnv: string; restrictedUserEnv?: string; restrictedPasswordEnv?: string }; safeEndpoints: string[]; graceMinutes: number }; walks: Array<{ name: string; paths: string[]; steps: string }>; cadenceMinutes: number; notifyCommand?: string; seats: { walker: string } }`, defaults, and `loadWalkConfig(invokeRoot)` reading `walk-the-floor.config.ts` via the fix skill's loader. Credentials are environment variable *names*; the loader refuses a value that looks like a literal secret.
- `skills/walk-the-floor/lib/liveness.ts`: `probe(baseUrl, healthPaths)` fetching each path with a short timeout, returning `{ up: boolean; results: Array<{ path; status; ms }> }`.
- `skills/walk-the-floor/walk.ts`: argv (`--dir`, `--once`, `--every`, `--liveness-only`, `--walker`, `--dry-run`), loads config, claims the lock, runs the probe, appends a `liveness` ledger entry with verdict `intact` or `down`, prints it, exits non-zero on `down`. `--every` is parsed but only `--once` runs in this commit.
- `skills/walk-the-floor/SKILL.md`: frontmatter and a two-paragraph body; the full description lands in Commit 9.

**Gate:** typecheck. `walk.ts --dir <scratch floor> --once --liveness-only` against the first adopter's deployed environment appends one `intact` entry; the same against an unroutable `baseUrl` appends one `down` entry and exits non-zero.

### Commit 3: run the callbacks

**Goal:** Behavior added by whoever started the walker, without the walker knowing what it is.

**Files created:**
- `skills/walk-the-floor/lib/callbacks.ts`: `runCallback(dir, name, entry)`: if `<dir>/<name>` exists and is executable, spawn it with the entry as JSON on stdin and a 60-second timeout, log its exit code, never throw; return the text of `<dir>/<name>.md` if present so the caller can hand it to the agent.

**Files rewritten:**
- `skills/walk-the-floor/walk.ts`: after every ledger entry, `on-pass` for `present`, `intact`, `exists-in-git`, and `not-checkable`; `on-fail` for `down` and `absent`; nothing for pending verdicts.

**Gate:** typecheck. In a scratch floor, an `on-fail` script that writes its stdin to a file: a `down` probe produces that file with the entry in it; an `on-pass` script is not run. Reverse for `intact`.

### Commit 4: produce items from the forge and read the deployed revision

**Goal:** Merges the burndown did not make still get walked, and the propagation race is a state rather than a guess.

**Files created:**
- `skills/walk-the-floor/lib/forge.ts`: `mergedSince(ctx, sinceIso)` via `gh pr list --state merged --base <baseBranch> --search "merged:>=<since>"` with number, title, merge SHA, `mergedAt`, and files; `appendFromForge(dir, ctx)` appends one item per pull request not already in the list (keyed on `pull-request:<number>`), with `source: 'forge'`. The "since" is the newest forge-sourced item's `mergedAt`, or the walker's first run time.
- `skills/walk-the-floor/lib/revision.ts`: `deployedRevision(ctx)` running `revisionCommand` and parsing a SHA from its stdout; `includes(ctx, deployed, mergeSha)` via `git merge-base --is-ancestor` after a fetch; and the pending classification: no `revisionCommand` and inside `graceMinutes` of `mergedAt` gives `unverified`, no `revisionCommand` and outside it gives "walk it", a `revisionCommand` that does not include the merge gives `not-yet-deployed`.

**Files rewritten:**
- `skills/walk-the-floor/walk.ts`: `--from-forge` (default on when `project.repo` is set) runs `appendFromForge` after liveness; pending items are classified by revision before any agent runs, and pending verdicts are appended without a walk.

**Gate:** typecheck. Against the first adopter, a scratch floor fills with the pull requests merged since a chosen timestamp, none walked yet, each with a `not-yet-deployed` or `unverified` entry as the environment dictates.

### Commit 5: walk the pending items

**Goal:** The agent part: one turn per wake, every walkable item, three rungs, one verdict file.

**Files created:**
- `skills/walk-the-floor/prompts/walk.md`: the sanity standard stated as "would a user notice"; the rung ladder; the rule that writes are additive, tagged with an `inspector-` prefix and a timestamp, soft-deleted on the way out, and only ever posted to a `safeEndpoints` entry; the standing walks matched to each item's paths, rendered in; the environment driver to load by kind (`playwright-harness` for web; `expo-ios-simulator` or `android-emulator-harness` otherwise); the verdict file contract: `walk-verdict.json` with one entry per item (`itemId`, `rung`, `verdict`, `reason`, `evidence` path under the floor's `evidence/`), and the rule that an item the walker cannot classify honestly is `not-checkable` with the reason, never `intact` by default.

**Files rewritten:**
- `skills/walk-the-floor/walk.ts`: builds the walker turn from the pending walkable items and runs it through the fix skill's `runAgent` with the walker seat, in a scratch checkout of the base at the deployed revision so the agent can read the diffs it is checking; validates the verdict file (every pending item present, every verdict in the vocabulary), appends ledger entries, runs callbacks per entry. An item missing from the verdict file gets no entry and is walked again next wake.

**Gate:** typecheck. Against the first adopter with a list of five recent merges spanning a visible change, a server-only change, and a docs-only change, the ledger shows `present` or `intact` for the first two kinds with screenshots under `evidence/`, and `exists-in-git` for the third. Every entry names its rung.

### Commit 6: file incidents and fix them

**Goal:** A failed walk becomes an issue, the issue becomes a fix, and the item is walked again.

**Files created:**
- `skills/walk-the-floor/prompts/diagnose.md`: given the failing entry, the last clean entry, the suspect merges between the two revisions, and the output of `logsCommand`, name the culprit merge if the evidence supports one, quote the error, and say whether to fix forward or revert; write `diagnosis.json`.
- `skills/walk-the-floor/lib/incident.ts`: `fileIncident(ctx, entry, diagnosis)` creates the issue with label `floor/incident` and a body carrying the ledger entry, the diagnosis, and a SHA-pinned link to the evidence, skipping creation when an open `floor/incident` issue already names the same item; then `fixIssue(ctx, issue)` from the fix skill; then re-probe or re-walk that one item and append the result. An incident whose fix parks or fails leaves the ledger at `down` or `absent` and the walker exits non-zero in `--once` mode.

**Files rewritten:**
- `skills/walk-the-floor/walk.ts`: `down` and `absent` route through diagnose and `fileIncident` after their `on-fail` callback has run.

**Gate:** typecheck. A scratch environment made to fail liveness (a config pointing at a port with nothing listening, `logsCommand` echoing a canned error naming a symbol in a recent merge) produces one `floor/incident` issue with the suspect named, one `fix.ts`-shaped attempt, and no duplicate issue on the next wake.

### Commit 7: run forever, and say so

**Goal:** The cadence mode and the notification hook.

**Files rewritten:**
- `skills/walk-the-floor/walk.ts`: `--every <minutes>` loops a wake on the cadence, holding the lock for the process lifetime, trapping signals to release it; a wake that finds the environment still `down` after an incident is filed does not re-file, it re-probes and re-notifies at most once an hour. `notifyCommand`, when set, is spawned with the `on-fail` entry on stdin.

**Gate:** typecheck. `walk.ts --every 1` against the first adopter runs three wakes in a scratch floor, appends three liveness entries, and exits cleanly on SIGTERM with the lock released.

### Commit 8: connect the burndown to the floor

**Goal:** The burndown starts the walker, feeds it, and stops merging when a walk fails.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: reads `runs/line-switch` (`go` or `pause` on the first line; absent means `go`; an unknown word means `pause`) before the appraisal batch, before every `fixIssue` dispatch, and through `ctx.mayMerge` inside the pull master; a paused seam polls every 30 seconds and logs once. When the config's `floor` section is set: on start, creates `<worktreeRoot>/floor/`, writes `on-fail` (an executable that writes `pause` and the entry's reason, prefixed `floor:`, to `runs/line-switch`) and `on-pass` (an executable that writes `go` only if the current reason starts with `floor:`), spawns `walk.ts --dir <floor> --every <cadence>` as a child, and kills it on exit; `ctx.afterMerge` appends a list item with the pull request reference. The burndown never reads the ledger.
- `skills/burn-down-github-issues/references/adopting.md`: the `floor: { cadenceMinutes }` section in the template, and a paragraph on the switch.
- `skills/burn-down-github-issues/references/architecture.md`: "The line": the switch, the floor, and why the walker is a separate process that knows nothing about the burndown.
- `skills/burn-down-github-issues/references/operating.md`: what a paused run looks like in the log, how to flip the switch by hand, and how to tell a floor pause from a manual one.

**Gate:** typecheck, dry run. A real burndown run with `floor` configured and `--limit 1`: the walker starts, the merge appends an item, the next wake walks it. Then, mid-run, `echo pause > runs/line-switch` by hand: no further dispatch or merge until `echo go`, and the log says so once.

### Commit 9: write the walker's references and its SKILL.md

**Files created:**
- `skills/walk-the-floor/references/the-floor.md`: the directory contract, both schemas, the verdict vocabulary with its pending versus terminal split, the callback rules, and the incident shape.
- `skills/walk-the-floor/references/adopting.md`: the config template with placeholder values, environment kinds and the driver each loads, how to author a standing walk (one paragraph of prose, path globs, what "at least one record renders" means), which endpoints are safe to post to and why the default is none, credentials as environment variable names, the revision command per common host, preconditions (`gh`, the walker CLI, Playwright or a simulator harness), and first-run order: `--liveness-only` first, then `--once` with a hand-written list, then `--every`.
- `skills/walk-the-floor/references/operating.md`: once versus forever, reading the ledger (`jq` one-liners), what an incident looks like on the forge, and stopping.

**Files rewritten:**
- `skills/walk-the-floor/SKILL.md`: full body: what it is (a list checker and fixer), when to use it (alone against a hand-written list; forever as a sanity heartbeat; as the floor of a burndown), the two callbacks, the standard ("would a user notice"), hard dependencies (`fix-github-issue`, and one environment driver skill), and the ceiling (agent judgment decides what "the change is there" means; a walk proves a user would not hit a wall, not that the change is correct; writes touch shared state and are tagged and reverted, which is a contract, not a sandbox).
- `README.md`: a row and a paragraph for `walk-the-floor`.

**Gate:** every relative link in the new files resolves; no em dashes; no project name, path, or issue number from any adopter anywhere in the skill.

### Commit 10: configure the first adopter

**Goal:** One real floor, in the adopting repository's tooling worktree, not in this repository.

**Files created (in the adopter's tooling worktree):**
- `walk-the-floor.config.ts`: re-exports `project` from the burndown config; `environment.kind: 'web'`, its deployed base URL and health paths, `revisionCommand` if the host can answer it, `logsCommand`, login as environment variable names, `safeEndpoints: []` until a webhook is confirmed side-effect free, four standing walks (sign in and open the landing screen; search returns records; open one record; open one print or export view), `cadenceMinutes: 10`.

**Files rewritten (in the adopter's tooling worktree):**
- `burn-down-github-issues.config.ts`: `floor: { cadenceMinutes: 10 }` and `project.smokeCommand` set to a command that boots the server and exits on the first request served.
- the adopter's operator handoff: the floor, the switch, and the launch line.

**Gate:** `walk.ts --dir <floor> --once` from the adopter's tooling worktree completes a full wake against the deployed environment with a hand-written three-item list; every entry has a rung and a verdict; the evidence directory holds one screenshot per `look`.

### Commit 11: delete this plan

- Delete `add-walk-the-floor.md`.
- The convention worth keeping, "a safety interlock is an executable callback, never only a prompt", goes into `walk-the-floor/references/the-floor.md` in Commit 9.

**Gate:** typecheck; `grep -rn add-walk-the-floor` over the repository is empty.

## Verification checklist

- [ ] `bunx tsc --noEmit -p .` passes at every commit.
- [ ] The walker runs alone: `--liveness-only`, then `--once` with a hand-written list, then `--every`, each against the first adopter's deployed environment.
- [ ] An `on-fail` executable runs before any fix begins, and an `on-pass` executable runs after every terminal passing verdict; neither runs for a pending verdict.
- [ ] A forced liveness failure files exactly one incident, attempts one fix through `fix-github-issue`, and re-probes.
- [ ] With `floor` configured, the burndown starts and stops the walker with itself, appends one item per merge, and honors `runs/line-switch` at all three seams.
- [ ] `smokeCommand: 'false'` parks a pull request; unset leaves the pipeline unchanged.
- [ ] Every ledger entry carries a rung and a verdict from the vocabulary; no entry says `intact` for an item the walker did not reach.
- [ ] No adopter's name, path, URL, credential, or issue number appears anywhere under `skills/walk-the-floor/`.
- [ ] Every relative link resolves; no em dashes.
- [ ] Plan file deleted (Inspector Gadget Rule: no orphan plans).

## References

- `extract-fix-github-issue.md`, the prerequisite plan.
- `skills/fix-github-issue/lib/pipeline.ts`, where the smoke gate and the two hooks land.
- `skills/burn-down-github-issues/references/architecture.md`, where the line is described after Commit 8.
- `skills/playwright-harness/SKILL.md`, `skills/expo-ios-simulator/SKILL.md`, `skills/android-emulator-harness/SKILL.md`, the drivers the walker loads by environment kind.
- `skills/prove-work-on-github/references/evidence-locker.md`, the pinned-link form the incident body uses for evidence.

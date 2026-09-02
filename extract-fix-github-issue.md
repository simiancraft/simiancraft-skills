# Extract the fix pipeline into `fix-github-issue`

**Status:** Draft
**Scope:** cross-stack
**Date:** 2026-09-01
**Last reviewed:** 2026-09-01
**Context:** The worker, reviewer, and pull master live inside `burn-down-github-issues/loop.ts` as module-level functions reading module-level globals; a second skill that needs to fix an issue cannot import them without importing the whole burndown.

## Goal

The burndown is about to get a sibling, a heartbeat that checks a running environment and fixes what it finds broken. That sibling needs exactly the machinery the burndown already has for turning an issue into a merged pull request: a worker in a worktree, a second-engine reviewer, and a serial pull master with staleness checks. Today that machinery is 2,260 lines of one file reading globals, so it can only be used by the process that defined them.

This plan lifts the fix pipeline out into its own skill, `fix-github-issue`, with an explicit context object in place of the globals, and makes the burndown its first consumer. Behavior does not change: the same prompts, the same verdict files, the same labels, the same merge rules.

Done looks like: `bun run skills/fix-github-issue/fix.ts --issue N` fixes one issue end to end from any adopting repository, and `loop.ts` is selection, appraisal, and a pool that calls `fixIssue`.

## Domain context

- **Fix pipeline.** One issue in, one terminal outcome out: `merged`, `parked`, `handed-off` (needs-decision or needs-human), `closed` (already-fixed or obsolete), `dlq`, or `failed`. Internally: worker, then review, then land, revising up to the review budget.
- **Context.** The object that replaces the module globals: the project config, the knobs the pipeline needs, the seats, the repository roots, the run directory, the dry-run flag, and the loggers. Every extracted function takes it as its first parameter. This is the refactor idea in one phrase: **from module globals to an explicit context**.
- **Seat.** An `engine[:model]` spec resolved against the engine registry. The pipeline needs two, worker and reviewer; the burndown keeps a third, appraiser, that the pipeline never sees.
- **Lane.** One issue's worktree plus the control files an agent writes into it. Lane lifecycle (create, reset, remove, sweep strays) belongs to the pipeline because the pipeline is what runs agents in it.
- **Skill as import target.** Skills sync individually into `~/.claude/skills/`, so a shared module must live inside a skill directory; a bare `lib/` at the repository root would not be present at runtime. `burn-down-github-issues/SKILL.md` already depends on `../prove-work-on-github/` by relative path, which is the precedent this plan follows.

## Current surface area

Everything is in `skills/burn-down-github-issues/loop.ts` (2,260 lines) plus three prompts. Grouped by what it is, with the line of each declaration as of the plan date.

| Group | Declarations | Destination |
|---|---|---|
| Knobs and config | `LoopKnobs` :36, `DEFAULTS` :49, `ProjectConfig` :195, config discovery `INVOKE_ROOT` :249 through `CONFIG` :366, `PROJECT`/`REMOTE`/`BASE`/`RUN_DIR` :367-371 | `fix-github-issue/lib/config.ts` (project and pipeline knobs); burndown keeps its own knobs |
| Engines and seats | `ENGINES` :129, `Seat` :154, `parseSeat` :157, `seatLabel` :165 | `lib/engines.ts` |
| Logging and shell | `log` :565, `step` :566, `CONTENTION` :572, `sh` :582, `mutate` :605 | `lib/shell.ts` |
| Agent process | `children` :395, timeouts :398-414, `RETRYABLE_UPSTREAM` :421, `retryableFailure` :429, `SETSID` :439, `killAgent` :447, `pump` :1283, `agentCommand` :1297, `runAgent` :1308, `runAgentOnce` :1329, `logTail` :1399, `readResult` :1414, `parseJsonFile` :1435, `renderPrompt` :1247, control-file names :374-384 | `lib/agent.ts` |
| Lanes | `dirtyPaths` :387, `resetLane` :932, `worktreeFor` :953, `removeWorktree` :981, `removeStrayWorktrees` :1005, `inFlight` :1034, `claimSingleInstance` :1041, `updateFromBase` :1088, `assertNotMainCheckout` :1237 | `lib/lane.ts` |
| Staleness | `matchesPath` :1119, `MAX_BASE_REFRESHES` :1124, `CLOSURE_CAP` :1126, `resolveSpecifier` :1129, `importClosure` :1160, `isVersionOnlyPackageJsonBump` :1198, `staleAgainstBase` :1204 | `lib/staleness.ts` |
| Labels and issue state | `ensureLabels` :723, `reviewCount` :751, `recordReview` :766, `sendToDlq` :791, `repairDurableState` :822, `closeIssue` :1700 | `lib/labels.ts` |
| Pipeline | types :466-510, `runWorker` :1522, `runReviewer` :1565, `computedTouches` :1594, `effectiveTouches` :1615, `mergeAllowed` :1626, `pullRequestMatchesReview` :1641, `isDraft` :1658, `awaitGreenChecks` :1667, `serializePullMaster` :1715, `review` :1732, `land` :1774, `handleIssue` :1882, `settleTerminalVerdict` :1918, `workIssue` :1980, `reviewAndLand` :2009 | `lib/pipeline.ts` |
| Resume | `reconcile` :862, `findStranded` :2084 | `lib/resume.ts` |
| Selection and appraisal | `pointsFromLabels` :618, `allIssues` :637, `selectForAppraisal` :643, `selectCandidates` :657, `openPullRequestIssueRefs` :706, `appraise` :1450, `prompts/appraise.md` | stay in `loop.ts` |
| Driver | argv parsing :512-563, `main` :2131, `pool` :2244 | `main` stays; `pool` to `lib/pool.ts` |
| Prompts | `prompts/triage-and-fix.md`, `prompts/review.md` | move to `fix-github-issue/prompts/` |

Globals read by the pipeline group and therefore carried by the context: `CONFIG` (`autoMerge`, `maxReviewRounds`, `concurrency` for resume), `PROJECT`, `REMOTE`, `BASE`, `REPO_ROOT`, `INVOKE_ROOT`, `RUN_DIR`, `PROMPTS`, `SEATS.worker`, `SEATS.reviewer`, `DRY_RUN`, `MAX_POINTS` (rendered into the worker prompt only), `integrationQueue`, `children`, `inFlight`.

Documentation that describes the current layout and will need the move reflected: `burn-down-github-issues/SKILL.md`, `references/architecture.md`, `references/adopting.md`, `references/operating.md`, and the repository `README.md` skill table.

## File structure: before

**Legend:** 🪓 split · ✏️ rewritten · 🔀 moved/renamed

```
simiancraft-skills/
├── README.md                                   # skill table; see after-tree
└── skills/
    └── burn-down-github-issues/
        ├── ✏️ SKILL.md                          // declares fix-github-issue as a hard dependency
        ├── 🪓 loop.ts → fix-github-issue/lib/{config,engines,shell,agent,lane,staleness,labels,pipeline,resume,pool}.ts
        ├── prompts/
        │   ├── appraise.md
        │   ├── 🔀 review.md                      # moves; see after-tree
        │   └── 🔀 triage-and-fix.md              # moves; see after-tree
        └── references/
            ├── ✏️ adopting.md                   // config file now imports ProjectConfig from the fix skill
            ├── ✏️ architecture.md               // pipeline sections point at the fix skill
            └── ✏️ operating.md                  // `--issue N` moves to fix.ts
```

## File structure: after

**Legend:** 🆕 new · ✏️ rewritten · 🔀 moved/renamed

```
simiancraft-skills/
├── 🆕 tsconfig.json                            // strict, bun-types, includes skills/**/*.ts
├── ✏️ README.md                                // adds fix-github-issue to the skill table
└── skills/
    ├── 🆕 fix-github-issue/
    │   ├── 🆕 SKILL.md
    │   ├── 🆕 fix.ts                            // CLI: --issue N [--worker] [--reviewer] [--dry-run]
    │   ├── 🆕 lib/
    │   │   ├── 🆕 context.ts                    // Context type and createContext()
    │   │   ├── 🆕 config.ts                     // from 🪓 loop.ts: ProjectConfig, PipelineKnobs, loadProjectConfig
    │   │   ├── 🆕 engines.ts                    // from 🪓 loop.ts
    │   │   ├── 🆕 shell.ts                      // from 🪓 loop.ts
    │   │   ├── 🆕 agent.ts                      // from 🪓 loop.ts
    │   │   ├── 🆕 lane.ts                       // from 🪓 loop.ts
    │   │   ├── 🆕 staleness.ts                  // from 🪓 loop.ts
    │   │   ├── 🆕 labels.ts                     // from 🪓 loop.ts
    │   │   ├── 🆕 pipeline.ts                   // from 🪓 loop.ts; exports fixIssue()
    │   │   ├── 🆕 resume.ts                     // from 🪓 loop.ts
    │   │   └── 🆕 pool.ts                       // from 🪓 loop.ts
    │   ├── 🆕 prompts/
    │   │   ├── 🔀 review.md ← burn-down-github-issues/prompts/review.md
    │   │   └── 🔀 triage-and-fix.md ← burn-down-github-issues/prompts/triage-and-fix.md
    │   └── 🆕 references/
    │       └── 🆕 pipeline.md                   // the verdict-file contract, review rounds, merge boundary, staleness; lifted from architecture.md
    └── burn-down-github-issues/
        ├── ✏️ SKILL.md
        ├── ✏️ loop.ts                           // selection, appraisal, driver, pool over fixIssue (~700 lines)
        ├── prompts/
        │   └── appraise.md
        └── references/
            ├── ✏️ adopting.md
            ├── ✏️ architecture.md
            └── ✏️ operating.md
```

## Commits

Every commit leaves `loop.ts` runnable. The gate for "runnable" in a repository with no test suite is the pair the loop already offers: a dry run from the first adopter's tooling worktree (`bun run <skill>/loop.ts --dry-run`), which loads every module and exercises selection without mutation, and the closure probe (`--closure <entry file>`), which exercises the staleness walk. Commit 1 adds the typecheck that makes the rest safe.

### Commit 1: add a typecheck gate to the skills repository

**Goal:** Give the extraction a compiler, since nothing in this repository currently checks a `.ts` file.

**Files created:**
- `tsconfig.json`: `strict`, `noEmit`, `module` and `moduleResolution` set for Bun, `types: ["bun-types"]`, `include: ["skills/**/*.ts"]`.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: only the annotations needed to pass `strict`; no logic change. Expect a handful of implicit-any parameters and one or two nullable narrowings.

**Gate:** `bunx tsc --noEmit -p .` passes. Dry run and closure probe unchanged.

### Commit 2: create `fix-github-issue` with the context and the leaf modules

**Goal:** Stand up the new skill directory with the modules that depend on nothing but the context.

**Files created:**
- `skills/fix-github-issue/lib/context.ts`: `Context` type (`project`, `knobs: { autoMerge, maxReviewRounds }`, `seats: { worker, reviewer }`, `repoRoot`, `invokeRoot`, `runDir`, `promptsDir`, `dryRun`, `log`, `step`) and `createContext(options)`.
- `skills/fix-github-issue/lib/config.ts`: `ProjectConfig` (moved verbatim with its doc comments), `PipelineKnobs`, `PIPELINE_DEFAULTS` (`autoMerge`, `maxReviewRounds`, `seats.worker`, `seats.reviewer`), and `loadProjectConfig(invokeRoot, fileName)`, which is the discovery logic from `loop.ts` :249-366 parameterized by file name so both skills can use it.
- `skills/fix-github-issue/lib/engines.ts`: `ENGINES`, `Seat`, `parseSeat`, `seatLabel`, moved verbatim.
- `skills/fix-github-issue/lib/shell.ts`: `sh`, `mutate`, `log`, `step`, `CONTENTION`; `mutate` takes `ctx` for `dryRun`, `sh` takes an explicit `cwd`.
- `skills/fix-github-issue/lib/pool.ts`: `pool` generalized over `T` rather than `Issue`.
- `skills/fix-github-issue/SKILL.md`: frontmatter and a two-paragraph body; the full description lands in Commit 8.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: deletes its copies of the above and imports them from `../fix-github-issue/lib/`. Module-level `PROJECT`, `REMOTE`, `BASE` remain for now as reads off a module-level `ctx` built by `createContext`.

**Gate:** `bunx tsc --noEmit -p .` passes. Dry run and closure probe produce the same output as before Commit 1 (diff the two logs; only timestamps differ).

### Commit 3: move the agent runner and the lane lifecycle

**Goal:** Everything that spawns an agent or touches a worktree moves, taking `ctx`.

**Files created:**
- `skills/fix-github-issue/lib/agent.ts`: `children`, `AGENT_TIMEOUT_MS`, `CHECKS_TIMEOUT_MS`, `AGENT_RETRIES`, `RETRY_BACKOFF_MS`, `RETRYABLE_UPSTREAM`, `retryableFailure`, `SETSID`, `killAgent`, `pump`, `agentCommand`, `runAgent`, `runAgentOnce`, `logTail`, `readResult`, `parseJsonFile`, `renderPrompt`, and the control-file names. `renderPrompt` reads `ctx.promptsDir` and builds the project vocabulary from `ctx.project`; the `AGE_DAYS` and `MAX_ROUNDS` variables it currently injects come from the caller's `vars` instead, since age is a burndown concept.
- `skills/fix-github-issue/lib/lane.ts`: `dirtyPaths`, `resetLane`, `worktreeFor`, `removeWorktree`, `removeStrayWorktrees`, `inFlight`, `claimSingleInstance` (renamed `claimLock(ctx, name)` so two drivers sharing a run directory hold distinct locks: `loop.lock` and, later, `floor.lock`), `updateFromBase`, `assertNotMainCheckout`.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: deletes the moved functions; `appraise` now calls the imported `runAgent` and `renderPrompt` with `ctx`.

**Gate:** typecheck, dry run, closure probe. Plus one real appraisal: `bun run loop.ts --issue <a sized open issue> --appraise-limit 1 --dry-run` is not enough here because a dry run spawns no agent, so run `--no-appraise --issue N` against a known `already-fixed` issue and confirm the appraiser log is written under `runs/` and the issue is closed with the receipt comment, exactly as before.

### Commit 4: move staleness and labels

**Goal:** The two pure-function groups the pull master reads.

**Files created:**
- `skills/fix-github-issue/lib/staleness.ts`: `matchesPath`, `MAX_BASE_REFRESHES`, `CLOSURE_CAP`, `resolveSpecifier`, `importClosure`, `isVersionOnlyPackageJsonBump`, `staleAgainstBase`; `ctx` supplies `project.pathAliases`, `sourceExtensions`, `alwaysInvalidates`, `releaseArtifacts`, `remote`, `baseBranch`.
- `skills/fix-github-issue/lib/labels.ts`: `ensureLabels`, `reviewCount`, `recordReview`, `sendToDlq`, `repairDurableState`, `closeIssue`, and a new one-line `parkIssue(ctx, issue, reason)` that labels the issue and comments the reason, which is the first of two hardening fixes from the field (a parked issue currently carries no comment, so the reason lives only in the local log).

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: deletes the moved functions; the `--closure` probe in `main` calls the imported `importClosure`.

**Gate:** typecheck, dry run, and the closure probe output is byte-identical to the Commit 1 capture.

### Commit 5: move the pipeline and the resume path

**Goal:** The load-bearing commit. Worker, reviewer, pull master, and the stranded-PR resume move as one unit because they share the verdict-file contract and the serial queue.

**Files created:**
- `skills/fix-github-issue/lib/pipeline.ts`: the types (`Verdict`, `WorkerResult`, `ReviewResult`, `Reviewed`, `Landing`, `Issue`), `runWorker`, `runReviewer`, `computedTouches`, `effectiveTouches`, `mergeAllowed`, `pullRequestMatchesReview`, `isDraft`, `awaitGreenChecks`, `serializePullMaster` with its queue held on `ctx` rather than the module (two contexts in one process must not share a queue), `review`, `land`, `settleTerminalVerdict`, `workIssue`, `reviewAndLand`, and the new entry point `fixIssue(ctx, issue, options?): Promise<FixOutcome>` which is `handleIssue` returning the terminal outcome instead of `void`. `FixOutcome` is `'merged' | 'parked' | 'handed-off' | 'closed' | 'dlq' | 'failed'`, each with the reason string. The reviewer-crash path that today calls `parkIssue` only labels the issue; it now also labels the pull request `loop/parked`, which is the second hardening fix from the field.
- `skills/fix-github-issue/lib/resume.ts`: `reconcile`, `findStranded`, and `resumeStranded(ctx, issues, concurrency)` which is the resume block from `main` :2177-2196.

**Files moved/renamed:**
- `skills/fix-github-issue/prompts/triage-and-fix.md ← skills/burn-down-github-issues/prompts/triage-and-fix.md`
- `skills/fix-github-issue/prompts/review.md ← skills/burn-down-github-issues/prompts/review.md`

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: `main` calls `reconcile(ctx)`, `repairDurableState(ctx, ...)`, `resumeStranded(ctx, ...)`, then `pool(candidates, concurrency, (issue) => fixIssue(ctx, issue, { maxPoints }))`. Appraisal and selection are untouched. `renderPrompt` for `appraise.md` reads from the burndown's own `prompts/`, so `ctx.promptsDir` is a list searched in order: the caller's directory first, the fix skill's second.

**Gate:** typecheck, dry run, closure probe, and a real run: `bun run loop.ts --limit 1` from the first adopter's tooling worktree against a fresh sized issue in the window (raise `ageDays` in the config if the window is empty). Confirm on the forge: the draft pull request opens, the reviewer verdict file lands, the merge or park matches the log, the worktree is removed. Compare the run log's driver lines against the last pre-extraction run: the same events in the same order.

### Commit 6: add the `fix.ts` command

**Goal:** The fix skill runs standalone.

**Files created:**
- `skills/fix-github-issue/fix.ts`: parses `--issue N` (required), `--worker`, `--reviewer`, `--dry-run`; loads `fix-github-issue.config.ts` from the invoking root if present, else falls back to `burn-down-github-issues.config.ts` and reads only the fields it needs (so an adopter of the burndown gets the fix command for free without a second file); builds the context; fetches the issue from the forge; calls `fixIssue`; prints the outcome; exits non-zero on `failed`.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: `--issue N` now prints "use fix.ts" and exits 2; the flag's remaining role (skip age and size filters for one issue) is gone because that is what `fix.ts` is.

**Gate:** typecheck; `bun run skills/fix-github-issue/fix.ts --issue N --dry-run` from the first adopter's tooling worktree prints the plan and mutates nothing; a real `fix.ts --issue N` on a known `already-fixed` issue closes it with the receipt.

### Commit 7: write the fix skill's reference

**Goal:** The parts of `architecture.md` that describe the pipeline move to the skill that owns it.

**Files created:**
- `skills/fix-github-issue/references/pipeline.md`: the verdict-file contract, the review-round budget as a per-issue high-water mark, the merge boundary (`autoMerge`, computed versus self-reported touches), staleness via import closure and the global-invalidator short-circuit, the resume windows, and the known gaps that belong to the pipeline (the pull master in-process, the closure walk's blind spots). Lifted from `burn-down-github-issues/references/architecture.md` with the loop-shaped material left behind.

**Files rewritten:**
- `skills/burn-down-github-issues/references/architecture.md`: keeps the shape (four roles, appraisal, selection, the pool) and links to `pipeline.md` for the rest. Drops the "import-closure walk has never fired" line from Known gaps; it has since fired in production runs.
- `skills/burn-down-github-issues/references/operating.md`: "Run it" and "Landing a parked pull request by hand" point at `fix.ts` where they said `--issue N`.
- `skills/burn-down-github-issues/references/adopting.md`: the config template imports `ProjectConfig` from `../fix-github-issue/lib/config.ts` for its type; the "two fields that bite" section is unchanged.
- `skills/burn-down-github-issues/SKILL.md`: hard dependencies gain `fix-github-issue`; "Run it" drops `--issue`.
- `skills/fix-github-issue/SKILL.md`: full body: what it does, when to use it (one known issue, headless; or as the fix seat of another loop), the dependency on `prove-work-on-github`, the config it reads, and the ceiling paragraph carried over from the burndown (tracker as untrusted instruction channel; identity-level versus model-level reviewer independence).
- `README.md`: a row for `fix-github-issue` in the skill table and a paragraph in the list.

**Gate:** every relative link in the four SKILL and reference files resolves (`grep -oE '\]\([^)]+\.md[^)]*\)'` over them, then `test -e` each target). No em dashes in any changed file (`grep -rnP '\x{2014}'` over the diff is empty).

### Commit 8: update the first adopter's config for the new layout

**Goal:** The one existing adopter's config typechecks against the moved type, and its operator handoff notes the move. These files live in the adopting repository's tooling worktree, not in this repository.

**Files rewritten (in the adopter's tooling worktree):**
- `burn-down-github-issues.config.ts`: the `ProjectConfig` import path.
- the adopter's operator handoff: "Where things are" gains the fix skill; the launch section gains the `fix.ts` one-liner.

**Gate:** dry run from the adopter's tooling worktree loads the config without error.

### Commit 9: delete this plan

- Delete `extract-fix-github-issue.md`.
- The convention worth keeping, "a shared module lives inside a skill directory because only skill directories sync to the runtime", goes into `CONTRIBUTING.md` in Commit 7 before this one.

**Gate:** typecheck passes; `grep -rn extract-fix-github-issue` over the repository is empty.

## Verification checklist

- [ ] `bunx tsc --noEmit -p .` passes at every commit.
- [ ] Dry run and closure probe from the first adopter's tooling worktree match the pre-extraction capture at every commit.
- [ ] One real burndown run (`--limit 1`) after Commit 5 produces the same driver-line sequence as the last pre-extraction run and the same forge state (draft opened, marked ready, reviewed, merged or parked, worktree removed).
- [ ] One real standalone `fix.ts --issue N` after Commit 6.
- [ ] `loop.ts` is under 800 lines and contains no worker, reviewer, or merge logic.
- [ ] A parked issue now carries a comment with the reason; a parked pull request from the reviewer-crash path now carries `loop/parked`.
- [ ] Every relative link in the touched SKILL and reference files resolves.
- [ ] No em dashes in any file this plan touched.
- [ ] Plan file deleted (Inspector Gadget Rule: no orphan plans).

## References

- `skills/burn-down-github-issues/loop.ts`, the source being split.
- `skills/burn-down-github-issues/references/architecture.md`, the design the extraction must not change.
- `skills/prove-work-on-github/references/freshness-and-reproof.md`, the rule `staleness.ts` implements.
- `add-walk-the-floor.md`, the plan that depends on this one.

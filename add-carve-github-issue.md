# Add `carve-github-issue`: erode oversized issues into sub-issues

**Status:** Draft
**Scope:** cross-stack
**Date:** 2026-09-02
**Last reviewed:** 2026-09-02
**Context:** The appraiser now runs a size callback after every `valid` verdict, but nothing answers it: an issue sized above the burndown's ceiling is labelled and then sits, because no skill turns a 13 into an 8 and a 5.

## Goal

The burndown works issues at or under a ceiling (`maxPoints`, default 5). Everything above it is sized and then ignored forever, so the hardest work in a backlog is precisely the work the loop never touches. The size-callback slot exists so a producer can answer "this is too big" with something; this plan writes that something.

`carve-github-issue` reads one oversized issue, proposes cuts along the highest seam the work actually has (domain before tier before route before folder before file before function before material), has a second engine confirm that the children cover the parent with no gap and no overreach, and only then creates them as GitHub sub-issues of the parent. Nothing closes; the parent stays open as the trunk and is worked by closing its children. Children are appraised on a later pass like any issue, and a child still over the ceiling is carved again, so a 13 erodes into 3s over runs.

Done looks like: `bun run <skill-dir>/carve.ts --issue N` carves one issue end to end from any adopting repository; the burndown ships the callback that invokes it for sizes over its ceiling, skips a parent whose children are open, and re-appraises a parent whose children have all closed.

## Domain context

- **Seam.** A line along which one issue can be cut into children that each stand alone. Seams are ranked; the carver takes the highest seam the work has and drops a rung only when the higher one does not apply or leaves a child still over the ceiling. The ladder is the skill's methodology and lives in `references/seams.md`.
- **Cut.** One candidate decomposition along one seam: a set of proposed children, each with a title, a scope, an acceptance criterion, a proposed size, and its dependencies on siblings. The carver proposes several cuts and chooses one; the alternatives stay in its answer so the confirmer can see what was passed over.
- **Cover.** The confirmer's verdict that the union of the children is the parent: no ask of the parent is missing (`gap`) and no child asks for something the parent did not (`overreach`). Only `cover` creates anything. This is the WBS 100% rule applied to issues.
- **Trunk and leaves.** The parent is the trunk; it stays open, labelled `loop/carved`, and is never handed to a worker while a child is open. Leaves are ordinary issues. Trunk-first (a person doing the whole thing) closes many leaves at once; leaf-first (the loop) erodes the trunk. Neither loses anything, because the tracker holds the tree.
- **Width.** A conceptually single job repeated over many instances with the same acceptance criterion each time (verify every route against a rule). Width is annotated, not split, unless one pass over all instances exceeds the ceiling, in which case the mechanistic seams are the correct cut because the instances are interchangeable.
- **Intractable.** Two hand-offs, kept distinct on the Rumsfeld matrix: `indivisible` (we know it cannot be cut at this ceiling; a migration with no safe intermediate state) goes to `needs-human`; `too-uncertain` (the issue does not say enough to cut) goes to `needs-decision` with the question.

## Current surface area

| Where | What | Change |
|---|---|---|
| `skills/appraise-github-issues/lib/callbacks.ts` | `SizePayload`, `runSizeCallback` | payload gains `repoRoot`; executable form gets a caller-supplied timeout |
| `skills/appraise-github-issues/references/callbacks.md` | ladder, forms, payload | payload field, timeout note |
| `skills/fix-github-issue/lib/callbacks.ts` | `runCallback` with a fixed 60 s timeout | `timeoutMs` option |
| `skills/fix-github-issue/lib/agent.ts` :220 | `clearsByRole` | `carver` entry |
| `skills/fix-github-issue/lib/control-files.ts` | control-file names | `CARVING_FILE` |
| `skills/fix-github-issue/lib/labels.ts` :21 | `ensureLabels` | `loop/carved`, `wide` |
| `skills/fix-github-issue/lib/pipeline.ts` :67 | `Issue` type | optional `parent`, `subIssuesSummary`, `blockedBy` |
| `skills/burn-down-github-issues/loop.ts` :485, :554 | `allIssues`, `selectCandidates` | request the new fields; skip carved trunks and blocked leaves |
| `skills/burn-down-github-issues/loop.ts` `placeSizeCallbacks` | copies `callbacks/on-size*` verbatim | renders `on-size-over-ceiling` as `on-size-over-<maxPoints>` with paths baked in |
| `skills/burn-down-github-issues/callbacks/README.md` | empty slot directory | the shipped callback |
| `skills/burn-down-github-issues/references/{architecture,adopting,operating}.md`, `SKILL.md` | | carving stage, new selection rules, new label |
| `README.md` | skill table | row for `carve-github-issue` |
| adopting repository `burn-down-github-issues.config.ts` | | optional `carve` block |

Forge facts the plan relies on (verified 2026-09-02 against `gh` 2.97.0): `gh issue create --parent N` creates a child already attached; `gh issue edit N --add-blocked-by M` records a dependency; `gh issue list --json` exposes `parent`, `subIssues`, `subIssuesSummary {total, completed, percentCompleted}`, `blockedBy {nodes, totalCount}`, and `blocking`. GitHub allows 100 sub-issues per parent and eight levels of nesting; each issue has one parent.

## File structure: before

**Legend:** ✏️ rewritten

```
simiancraft-skills/
├── ✏️ README.md
└── skills/
    ├── appraise-github-issues/
    │   ├── lib/
    │   │   └── ✏️ callbacks.ts                  // repoRoot in the payload; timeout passthrough
    │   └── references/
    │       └── ✏️ callbacks.md
    ├── burn-down-github-issues/
    │   ├── ✏️ SKILL.md
    │   ├── ✏️ loop.ts                           // selection rules; callback rendering; trunk release
    │   ├── callbacks/
    │   │   └── ✏️ README.md
    │   └── references/
    │       ├── ✏️ adopting.md
    │       ├── ✏️ architecture.md
    │       └── ✏️ operating.md
    └── fix-github-issue/
        └── lib/
            ├── ✏️ agent.ts                      // carver role
            ├── ✏️ callbacks.ts                  // timeoutMs option
            ├── ✏️ control-files.ts              // CARVING_FILE
            ├── ✏️ labels.ts                     // loop/carved, wide
            └── ✏️ pipeline.ts                   // Issue gains tree fields
```

## File structure: after

**Legend:** 🆕 new · ✏️ rewritten

```
simiancraft-skills/
├── ✏️ README.md
└── skills/
    ├── 🆕 carve-github-issue/
    │   ├── 🆕 SKILL.md
    │   ├── 🆕 carve.ts                          // CLI: --issue N [--dry-run] [--ceiling N] [--carver] [--confirmer] [--no-confirm] [--callbacks dir]
    │   ├── 🆕 lib/
    │   │   ├── 🆕 carve.ts                      // carveIssue(ctx, issue, knobs): CarveOutcome; validation; tree reads
    │   │   ├── 🆕 tree.ts                       // depth, open children, blockers, from gh json
    │   │   └── 🆕 callbacks.ts                  // on-carve-pass / on-carve-fail on the shared slot mechanism
    │   ├── 🆕 prompts/
    │   │   ├── 🆕 carve.md                      // the carver turn: seams, candidates, choice
    │   │   └── 🆕 confirm-carve.md              // the confirmer turn: cover / gap / overreach, seam check
    │   └── 🆕 references/
    │       ├── 🆕 seams.md                      // the ladder, the axioms, the floor, width, scoring, literature
    │       ├── 🆕 adopting.md                   // config, labels, what lands on the tracker, boundaries
    │       └── 🆕 callbacks.md                  // the two slots and their payload
    ├── appraise-github-issues/
    │   ├── lib/
    │   │   └── ✏️ callbacks.ts
    │   └── references/
    │       └── ✏️ callbacks.md
    ├── burn-down-github-issues/
    │   ├── ✏️ SKILL.md
    │   ├── ✏️ loop.ts
    │   ├── callbacks/
    │   │   ├── ✏️ README.md
    │   │   └── 🆕 on-size-over-ceiling          // template; placed as on-size-over-<maxPoints> with paths rendered
    │   └── references/
    │       ├── ✏️ adopting.md
    │       ├── ✏️ architecture.md
    │       └── ✏️ operating.md
    └── fix-github-issue/
        └── lib/
            ├── ✏️ agent.ts
            ├── ✏️ callbacks.ts
            ├── ✏️ control-files.ts
            ├── ✏️ labels.ts
            └── ✏️ pipeline.ts
```

## The carver's answer

`loop-carving.json`, written in the scratch directory, validated field by field and rejected whole on any miss (the appraiser's fail-closed rule):

```json
{
  "issue": 1282,
  "verdict": "carve",
  "reason": "two entities end to end; the author side is the smaller leg",
  "chosen": 0,
  "cuts": [
    {
      "seam": "domain",
      "children": [
        { "title": "…", "body": "…", "points": 8, "dependsOn": [] },
        { "title": "…", "body": "…", "points": 5, "dependsOn": [0] }
      ],
      "balance": "8 and 5 out of 13; uneven but each is one thing",
      "independence": "share the migration; second depends on first",
      "why-not": ""
    },
    { "seam": "tier", "children": [], "balance": "", "independence": "", "why-not": "three layers of one entity are not separately provable" }
  ],
  "width": null
}
```

- `verdict` is one of `carve`, `wide`, `small-enough`, `indivisible`, `too-uncertain`.
- `seam` is one of `domain`, `tier`, `route`, `area`, `file`, `unit`, `material`, in ladder order.
- `carve` requires `cuts[chosen].children.length` between 2 and `maxChildren`, every child `points` on the configured scale and at most the ceiling, `dependsOn` indices acyclic, and every child body containing the three headings the template mandates (Scope, Acceptance, Proof).
- `wide` requires `width: { instances: [...], perInstance: "…" }` and allows `cuts` to be empty (annotate only) or one `material`/`route`/`area` cut (chunk it because one pass exceeds the ceiling).
- `small-enough` is the carver disagreeing with the size; it records a comment and stops, because size is the appraiser's.
- `indivisible` and `too-uncertain` require `reason` to state, respectively, what makes the work one thing and what question a person must answer.

## The confirmer's answer

`loop-confirmation.json`: `{ "issue": N, "agree": boolean, "finding": "cover" | "gap" | "overreach", "seam": "agree" | "higher-available", "reason": "…" }`. `agree` is true only for `cover`. A `higher-available` seam note with `cover` still creates the children; the note is posted on the parent so a person can see the road not taken. Any `gap` or `overreach` is a dispute: nothing is created, the parent gets `needs-human` with both opinions, and `on-carve-fail` runs.

## What lands on the tracker

| Verdict | Parent | Children |
|---|---|---|
| `carve`, confirmed | `loop/carved`; comment naming the seam, the children, the alternatives passed over | one issue each via `gh issue create --parent`; body from the template; `blocked-by` edges from `dependsOn`; no size label (the appraiser sizes them) |
| `carve`, disputed | `needs-human`; comment with the carver's cut and the confirmer's objection | none |
| `wide` | `wide`; comment with the instance list and the per-instance criterion; chunks as children when chunked | chunk issues, same as above |
| `small-enough` | comment: the carver's size and why | none |
| `indivisible` | `needs-human`; comment | none |
| `too-uncertain` | `needs-decision`; comment with the question | none |

Comment before label, live re-read before every write, and a parent that gained a hold label or a child since the carver started is left alone: the same ordering rules the appraiser keeps.

## Guards

- **Depth.** The chain of `parent` links from the issue upward is counted; at `maxDepth` (default 3) the carver is not run and the issue is treated as `indivisible` with the depth stated. GitHub's own limit is eight.
- **Fan-out.** `maxChildren` (default 8). A cut that needs more is a sign the seam is too low; the carver is told to pick a higher one or return `wide`.
- **Floor.** No child under 1 point, no child over the ceiling, and no child without its own acceptance and proof. A child that only makes sense after a sibling is a dependency, not a reason to merge them.
- **Idempotence.** A parent that already has open sub-issues is never carved again; a parent labelled `loop/carved` is never handed to a worker.
- **Trunk release.** When every child of a `loop/carved` parent is closed, the burndown strips `loop/carved` and the size label, comments that the children are done, and appraises the remainder in the same run whatever its age. The appraiser then closes it (`already-fixed`, confirmed) or sizes what is left.

## Commits

Gates use the pair the collection already has: `bunx tsc --noEmit -p .` and a dry run from an adopting repository. Real runs are against the adopting repository's tracker with a known oversized issue (as of the plan date, #1282 is sized 8 against a ceiling of 5).

### Commit 1: widen the shared pieces the knife needs

**Goal:** Everything in `fix-github-issue` and `appraise-github-issues` the new skill reads, before the skill exists.

**Files rewritten:**
- `skills/fix-github-issue/lib/callbacks.ts`: `runCallback(dir, name, payload, log, options?: { timeoutMs?: number })`; default stays 60 s.
- `skills/fix-github-issue/lib/control-files.ts`: `CARVING_FILE = 'loop-carving.json'`.
- `skills/fix-github-issue/lib/agent.ts`: `clearsByRole.carver = [CARVING_FILE, LAST_MESSAGE_FILE]`.
- `skills/fix-github-issue/lib/labels.ts`: `ensureLabels` adds `loop/carved` ("Carved into sub-issues; worked by closing them") and `wide` ("One job over many instances; parallel by nature").
- `skills/fix-github-issue/lib/pipeline.ts`: `Issue` gains optional `parent: { number } | null`, `subIssuesSummary: { total, completed }`, `blockedBy: { nodes: Array<{ number, state }> }`.
- `skills/appraise-github-issues/lib/callbacks.ts`: `SizePayload.repoRoot`; `runSizeCallback` passes `ctx.knobs.sizeCallbackTimeoutMinutes` (new pipeline knob, default 30) to the executable.
- `skills/appraise-github-issues/references/callbacks.md`: the field and the timeout.

**Gate:** typecheck; appraise and burndown dry runs unchanged.

### Commit 2: create the skill's library and prompts

**Goal:** `carveIssue` works end to end from a test harness; no command yet.

**Files created:**
- `skills/carve-github-issue/lib/tree.ts`: `readTree(ctx, number)` (one `gh issue view --json` with the tree fields), `depthOf(ctx, issue)`, `openChildren(issue)`, `openBlockers(issue)`.
- `skills/carve-github-issue/lib/carve.ts`: `CarveKnobs { ceiling, maxDepth, maxChildren, confirmCarves, callbacksDir, seats: { carver, confirmer } }`, `CARVE_DEFAULTS`, `validateCarving`, `validateConfirmation`, `renderChildBody`, `createChildren` (create in dependency order so `--add-blocked-by` can name a sibling that exists), `carveIssue(ctx, issue, knobs): Promise<CarveOutcome>` following `appraiseIssue`'s shape: run carver, validate, re-read live, guards, confirm, apply, callbacks.
- `skills/carve-github-issue/lib/callbacks.ts`: `runCarveCallback(dir, 'on-carve-pass' | 'on-carve-fail', payload, log)` on the shared slot; payload `{ issue, title, verdict, seam, children: number[], reason, repo, baseBranch, repoRoot }`.
- `skills/carve-github-issue/prompts/carve.md`: read-only turn against the main checkout, same access rules as `appraise.md`; loads `references/seams.md` by path; instructed to propose at least two cuts when two seams apply, to score them, to choose, and to write the answer file even when it cannot finish.
- `skills/carve-github-issue/prompts/confirm-carve.md`: the confirmer sees the parent thread and only the chosen cut's children; answers cover, gap, or overreach; separately says whether a higher seam was available, having been shown the seam list but not the carver's alternatives.
- `skills/carve-github-issue/references/seams.md`: see "The seams reference" below.

**Gate:** typecheck. A `--dry-run`-shaped harness call (`carveIssue` with `ctx.dryRun`) renders both prompts to the run directory and mutates nothing.

### Commit 3: add the `carve.ts` command

**Goal:** The skill runs standalone.

**Files created:**
- `skills/carve-github-issue/carve.ts`: `--issue N` (required), `--dry-run`, `--ceiling N`, `--carver`, `--confirmer`, `--no-confirm`, `--callbacks <dir>`; reads `carve-github-issue.config.ts`, else `burn-down-github-issues.config.ts` (ceiling from its `maxPoints`, seats from its `seats`); claims `carve.lock`; tees `runs/carve.log`; the same signal handling as `appraise.ts`; prints the outcome; exits non-zero on `failed`.
- `skills/carve-github-issue/SKILL.md`: what it does, the trunk-and-leaves contract, run lines, dependencies, the ceiling paragraph (tracker as untrusted instruction channel; confirmer independence is model-level).
- `skills/carve-github-issue/references/adopting.md`: config block, labels it creates, what lands on the tracker, the guards, boundaries.
- `skills/carve-github-issue/references/callbacks.md`: the two slots, both forms, the payload.

**Gate:** typecheck; `carve.ts --issue 1282 --dry-run` from the adopting repository prints the plan and writes only the log. Then one real carve of #1282 with the confirmer on: the parent carries `loop/carved` and the comment, the children exist with `parent` set, dependencies are recorded, no child carries a size label, `on-carve-pass` ran (a scratch executable that writes a line proves it).

### Commit 4: teach the burndown the tree

**Goal:** The loop never works a trunk, never works a blocked leaf, and releases a trunk whose leaves are done.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: `allIssues` and `selectCandidates` request `parent,subIssuesSummary,blockedBy`; `selectCandidates` drops issues labelled `loop/carved`, issues with `subIssuesSummary.total > completed`, and issues with an open blocker; new `releaseCarvedTrunks(all)` runs under the lock after merge reconciliation and feeds released trunks into this run's appraisal batch regardless of age; the board marks `carved` (children listed) and `released`.
- `skills/burn-down-github-issues/references/architecture.md`: the carving stage between appraisal and selection; the trunk release.

**Gate:** typecheck; burndown dry run lists #1282 as skipped for `loop/carved` and its children as candidates once sized. One real run with `--limit 1` picks a child, not the trunk.

### Commit 5: ship the size callback that invokes the knife

**Goal:** An issue sized over the ceiling is carved without the appraiser knowing the knife exists.

**Files created:**
- `skills/burn-down-github-issues/callbacks/on-size-over-ceiling`: a shell script template; reads the payload from stdin, runs `bun run {{CARVE_DIR}}/carve.ts --issue <n>` from `{{REPO_ROOT}}`, exits with its code. Executable form on purpose: invoking a program is load-bearing and never depends on an agent following prose; the `.md` form remains for adopters who want judgement in the slot.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: `placeSizeCallbacks` renders the template to `<callbacksDir>/on-size-over-<maxPoints>` with the two paths substituted and the executable bit set; when `maxPoints` changes, the stale file from the previous ceiling is removed.
- `skills/burn-down-github-issues/callbacks/README.md`: describes the shipped callback and the rendering.
- `skills/burn-down-github-issues/SKILL.md`, `references/adopting.md`, `references/operating.md`, `README.md`: the carving stage, the `carve` config block, the new labels, the skill row.

**Gate:** typecheck; a burndown run that appraises a fresh issue sized over the ceiling shows the callback firing and the carve log under `runs/`; link check over every touched `.md`; no em dashes in the diff.

### Commit 6: update the adopting repository's config

**Files rewritten (in the adopting repository):**
- `burn-down-github-issues.config.ts`: optional `carve: { maxDepth: 3, maxChildren: 8 }`; seats gain `carver`.

**Gate:** burndown and carve dry runs load the config without error.

### Commit 7: delete this plan

- Delete `add-carve-github-issue.md`.
- The methodology (`references/seams.md`) is a skill doc and stays.

**Gate:** typecheck passes; `grep -rn add-carve-github-issue` over the repository is empty.

## The seams reference

`references/seams.md` is the skill's methodology and is written for the carver, not for a person. Its sections, in order:

1. **The ladder**, with one paragraph per rung saying what the seam is, when it applies, and what a child cut on it looks like. Domain is first because a child cut there is provable on its own; material is last because it is blind to what the work means and is only right for width.
2. **The two axioms.** Seam order: the larger the issue, the more the cut must be conceptual. Symmetry: prefer even cuts when the seam offers them; carve the legs off an indivisible body when it does not.
3. **Floor and ceiling.** Too large: still divisible or parallelizable. Too small: the issue costs more to write than to do; operationally, a child without its own acceptance and proof, or under the scale's smallest rung.
4. **Width.** How to recognize it (one criterion, many instances), what to annotate, and when to chunk.
5. **Scoring**, explicit because an agent will not infer it: seam rank first; then balance; then independence (children that touch the same files serialize and conflict when their pull requests land); then child size within bounds; then the number of children. A dependency between children is recorded, not used as a reason to merge them.
6. **Hand-offs.** `indivisible` versus `too-uncertain`, with the Rumsfeld distinction stated so the carver names the right one.
7. **Other people's seams**, as a supplement to the ladder, mapped onto it rather than listed beside it:
   - Lawrence's nine story-splitting patterns (workflow steps, CRUD operations, business-rule variations, data variations, entry methods, major effort, simple/complex, defer performance, break out a spike) and his two selection rules, which are the symmetry axiom and "choose the split that lets you throw a piece away".
   - Cohn's SPIDR (spike, path, interface, data, rules): paths and rules are domain seams; interface is a tier seam; a spike is the `too-uncertain` hand-off made into work.
   - Cockburn's Elephant Carpaccio and vertical slicing: why domain outranks tier.
   - Parnas (1972): a good module boundary hides one decision likely to change; a good child boundary is the same test, and it is the independence score.
   - The WBS 100% rule (children sum to the parent, nothing outside it), which is the cover/gap/overreach gate, and the 8/80 rule, which is the floor and ceiling in hours.
   - Google's small-CL guidance: stacked, per-file, horizontal, vertical, and why vertical is preferred when review is the bottleneck.
   - Adzic's hamburger method: technical steps as a last resort when no vertical cut is available, which is the tier seam's position on the ladder.
   - Asthana et al. (2026), runtime-structured task decomposition for agentic coding: a validation gate between sub-tasks that blocks malformed output from propagating, which is the confirmer's job stated in their vocabulary.

## Verification checklist

- [ ] `bunx tsc --noEmit -p .` passes at every commit.
- [ ] Appraise and burndown dry runs from the adopting repository are unchanged after Commit 1.
- [ ] One real standalone carve with the confirmer on produced sub-issues attached to the parent, dependencies recorded, no size labels on children, `loop/carved` and the comment on the parent.
- [ ] One disputed carve (force it with `--confirmer` pointed at a prompt that answers `gap`) left the parent `needs-human` with both opinions and created nothing.
- [ ] One burndown run skipped the carved trunk and worked a child.
- [ ] One burndown run released a trunk whose children were all closed and appraised it in the same run.
- [ ] The shipped size callback fired for an issue sized over the ceiling and the carve log landed under `runs/`.
- [ ] Every relative link in the touched SKILL and reference files resolves; no em dashes in any touched file.
- [ ] Plan file deleted (Inspector Gadget Rule: no orphan plans).

## Answered questions

- **Executable or prompt for the shipped callback?** Executable. The earlier framing had the prompt invoke the skill; the collection's own rule is that anything load-bearing never depends on an agent following prose, and a program invocation is load-bearing. The prompt form stays available and is documented for adopters. The executable timeout becomes a knob because a carve takes minutes, not seconds.
- **Do children get sizes from the knife?** No. The carver proposes points in the body so the confirmer can judge balance, but the label comes from the appraiser on a later pass. One skill owns size.
- **What happens to the trunk?** Never closed by the knife. Released to the appraiser when its leaves are all closed, and the appraiser's confirmed close is what ends it.
- **Depth cap default?** 3. Deep enough for 21 to reach 3s along the Fibonacci scale; shallow enough that a bad decomposition cannot recurse into GitHub's eight-level limit.

## References

- `skills/appraise-github-issues/lib/appraise.ts`, the shape `carveIssue` follows.
- `skills/appraise-github-issues/references/callbacks.md`, the slot the knife answers.
- `skills/walk-the-floor/lib/callbacks.ts`, the typed wrapper the knife's callbacks copy.
- GitHub sub-issues REST reference: https://docs.github.com/en/rest/issues/sub-issues
- GitHub issue dependencies REST reference: https://docs.github.com/en/rest/issues/issue-dependencies
- Sub-issue limits: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues
- Lawrence, story splitting guide: https://www.humanizingwork.com/the-humanizing-work-guide-to-splitting-user-stories/
- Cohn, SPIDR: https://www.mountaingoatsoftware.com/agile/five-simple-but-powerful-ways-to-split-user-stories
- Kniberg, Elephant Carpaccio facilitation guide: https://blog.crisp.se/2013/07/25/henrikkniberg/elephant-carpaccio-facilitation-guide
- Parnas, On the criteria to be used in decomposing systems into modules: https://dl.acm.org/doi/10.1145/361598.361623
- PMI practice standard for work breakdown structures: https://www.pmi.org/learning/library/practice-standard-work-breakdown-structures-8063
- Google, small CLs: https://google.github.io/eng-practices/review/developer/small-cls.html
- Adzic, the hamburger method: https://gojko.net/2012/01/23/splitting-user-stories-the-hamburger-method/
- Asthana et al., Runtime-Structured Task Decomposition for Agentic Coding Systems (2026): https://arxiv.org/html/2605.15425v1

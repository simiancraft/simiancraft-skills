# Add `carve-github-issue`: erode oversized issues into sub-issues

**Status:** Draft
**Scope:** cross-stack
**Date:** 2026-09-02
**Last reviewed:** 2026-09-03
**Context:** The appraiser now runs a size callback after every `valid` verdict, but nothing answers it: an issue sized above the burndown's ceiling is labelled and then sits, because no skill turns a 13 into an 8 and a 5.

## Goal

The burndown works issues at or under a ceiling (`maxPoints`, default 5). Everything above it is sized and then ignored forever, so the hardest work in a backlog is precisely the work the loop never touches. The size-callback slot exists so a producer can answer "this is too big" with something; this plan writes that something.

`carve-github-issue` reads one oversized issue, decides the pieces it is made of along the highest seam the work has, matches each piece against the open backlog so nothing is authored twice, has a second engine confirm that the pieces cover the parent with no gap and no overreach, and only then expresses the parent as GitHub sub-issues. The parent stays open as the trunk and is worked by closing its leaves. Every leaf close triggers a revisit of the trunk, so the carving is re-checked continuously and a trunk with nothing left is handed back to the appraiser. Children are appraised on a later pass like any issue, and a child still over the ceiling is carved again, so a 13 erodes into 3s over runs.

Done looks like: `bun run <skill-dir>/carve.ts --issue N` carves or revisits one issue end to end from any adopting repository; the burndown ships the callback that invokes it for sizes over its ceiling, never works a trunk or a blocked leaf, works a trunk's leaves in their delivery order, and revisits a trunk whenever one of its leaves closes.

## Domain context

- **Seam.** A line along which one issue can be cut into children that each stand alone. Seams are ranked (domain, tier, route, area, file, unit, material); the carver searches from the top and drops a rung only when the higher one does not apply or fails admissibility. The ladder is a search order, not a trump card: a cut on any rung is admissible only if every child has one bounded outcome, its own acceptance and proof, and leaves the base usable after it lands. The methodology is `references/seams.md`.
- **Piece.** One unit of the parent's work as the carver names it. A piece becomes a child either by authoring a new issue or by referencing an issue the backlog already has. Normalization (list the pieces, match each against the open backlog, author only what is missing) is a step of every carve, not a special case.
- **Cut.** One candidate decomposition along one seam: its pieces, their relation to each other, their delivery order, and any shared groundwork with its owner. The carver proposes cuts along every seam that applies and chooses one; the alternatives stay in its answer.
- **Cover.** The confirmer's verdict that the union of the pieces is the parent: no ask of the parent is missing (`gap`) and no piece asks for something the parent did not (`overreach`). The WBS 100% rule applied to issues. A width cut is judged for partition integrity instead: the instance manifest is complete and deduplicated, every instance is in exactly one chunk, and every chunk carries the same acceptance and proof.
- **Trunk and leaves.** The parent is the trunk: open, labelled `loop/carved`, never handed to a worker while a child is open. Leaves are landable increments the burndown can work. Interior nodes are trunks of their own. Trunk-first (a person doing the whole thing) closes many leaves at once; leaf-first (the loop) erodes the trunk.
- **Carving record.** A comment with a fixed shape posted on the trunk after every carve and every revisit: the seam and why higher rungs did not apply, the state of the breakdown (`complete` or `partial` with what is waiting on what), the children as a table (number, piece, authored or referenced, proposed size, delivery order and the rung that decided it, dependencies), how the children relate (`shards`, `layers`, `mixed`, `waiting`), and shared groundwork with its owner. The newest record is authoritative; the history stays on the thread. Workers and revisits read it.
- **Revisit.** The knife run on a trunk that already has children, asking whether the carving is still good. Triggered by every child close. Answers `still-good`, `amend` (add pieces, reference pieces, supersede pieces; confirmed like a first carve), or `exhausted` (nothing remains uncarved and no child is open; the trunk goes back to the appraiser).
- **Hand-offs.** `indivisible` (we know it cannot be cut at this ceiling) goes to `needs-human`. `too-uncertain` (a product ruling nobody has made) goes to `needs-decision` with the question. A technical unknown is neither: it becomes a `spike` piece, and the rest of the cut waits on it.

## Current surface area

| Where | What | Change |
|---|---|---|
| `skills/appraise-github-issues/lib/appraise.ts` :59-76 | `AppraiseKnobs` | `sizeCallbackTimeoutMinutes` |
| `skills/appraise-github-issues/lib/callbacks.ts` | `SizePayload`, `runSizeCallback` | payload gains `repoRoot`; executable form gets the timeout passed explicitly |
| `skills/appraise-github-issues/references/callbacks.md` | ladder, forms, payload | payload field, timeout note |
| `skills/fix-github-issue/lib/callbacks.ts` :22, :53-61 | `runCallback` with a fixed 60 s timeout, kills only the wrapper | `timeoutMs` option; process-group kill; registered in `children` |
| `skills/fix-github-issue/lib/agent.ts` :220 | `clearsByRole` | `carver` entry |
| `skills/fix-github-issue/lib/control-files.ts` | control-file names | `CARVING_FILE` |
| `skills/fix-github-issue/lib/labels.ts` :21 | `ensureLabels` | `loop/carved` |
| `skills/fix-github-issue/lib/pipeline.ts` :67, :708 | `Issue` type; `fixIssue` | tree fields; roll-up and revisit hook on `merged` |
| `skills/fix-github-issue/prompts/triage-and-fix.md` | worker prompt | read the parent and its carving record when the issue has one |
| `skills/burn-down-github-issues/loop.ts` :485, :554, :624, :775-808 | `allIssues`, `selectCandidates`, `placeSizeCallbacks`, `main` | tree fields; trunk and blocker rules; leaf order; rendered callback with ownership marker; start-of-run carve sweep |
| `skills/burn-down-github-issues/callbacks/README.md` | empty slot directory | the shipped callback |
| `skills/burn-down-github-issues/references/{architecture,adopting,operating}.md`, `SKILL.md` | | carving stage, revisit, selection rules, the label |
| `README.md` | skill table | row for `carve-github-issue` |
| adopting repository `burn-down-github-issues.config.ts` | | optional `carve` block; `seats.carver` |

Forge facts the plan relies on (verified 2026-09-02 against `gh` 2.97.0): `gh issue create --parent N` creates a child already attached; `gh issue edit N --parent P` attaches an existing issue; `gh issue edit N --add-blocked-by M` records a dependency; `gh issue list --json` exposes `parent`, `subIssues`, `subIssuesSummary {total, completed, percentCompleted}`, `blockedBy {nodes, totalCount}`, and `blocking`. GitHub allows 100 sub-issues per parent and eight levels of nesting; each issue has one parent.

## File structure: before

**Legend:** ✏️ rewritten

```
simiancraft-skills/
├── ✏️ README.md
└── skills/
    ├── appraise-github-issues/
    │   ├── lib/
    │   │   ├── ✏️ appraise.ts                   // sizeCallbackTimeoutMinutes knob
    │   │   └── ✏️ callbacks.ts                  // repoRoot in the payload; timeout passed through
    │   └── references/
    │       └── ✏️ callbacks.md
    ├── burn-down-github-issues/
    │   ├── ✏️ SKILL.md
    │   ├── ✏️ loop.ts                           // selection rules; leaf order; callback rendering; carve sweep
    │   ├── callbacks/
    │   │   └── ✏️ README.md
    │   └── references/
    │       ├── ✏️ adopting.md
    │       ├── ✏️ architecture.md
    │       └── ✏️ operating.md
    └── fix-github-issue/
        ├── lib/
        │   ├── ✏️ agent.ts                      // carver role
        │   ├── ✏️ callbacks.ts                  // timeoutMs; process-group kill; registered child
        │   ├── ✏️ control-files.ts              // CARVING_FILE
        │   ├── ✏️ labels.ts                     // loop/carved
        │   └── ✏️ pipeline.ts                   // Issue gains tree fields; roll-up and revisit on merged
        └── prompts/
            └── ✏️ triage-and-fix.md             // read the parent's carving record
```

## File structure: after

**Legend:** 🆕 new · ✏️ rewritten

```
simiancraft-skills/
├── ✏️ README.md
└── skills/
    ├── 🆕 carve-github-issue/
    │   ├── 🆕 SKILL.md
    │   ├── 🆕 carve.ts                          // CLI: --issue N [--dry-run] [--ceiling N] [--carver] [--confirmer] [--callbacks dir]
    │   ├── 🆕 lib/
    │   │   ├── 🆕 carve.ts                      // carveIssue(ctx, issue, knobs): CarveOutcome; validation; apply; journal
    │   │   ├── 🆕 carve.test.ts                 // the pure validators, under bun test
    │   │   ├── 🆕 tree.ts                       // depth, children, blockers, the latest carving record, from gh json
    │   │   ├── 🆕 record.ts                     // render and parse the carving record; render a child body
    │   │   └── 🆕 callbacks.ts                  // on-carve-pass / on-carve-fail on the shared slot mechanism
    │   ├── 🆕 prompts/
    │   │   ├── 🆕 carve.md                      // the carver turn: pieces, normalization, seams, cuts, choice
    │   │   ├── 🆕 revisit.md                    // the carver turn on a trunk that has children
    │   │   └── 🆕 confirm-carve.md              // the confirmer turn: cover or partition, the checklist, seam dispute
    │   └── 🆕 references/
    │       ├── 🆕 seams.md                      // the ladder, the axioms, the floor, width, normalization, ordering, literature
    │       ├── 🆕 adopting.md                   // config, labels, what lands on the tracker, guards, boundaries
    │       ├── 🆕 the-record.md                 // the carving record's shape and who reads it
    │       └── 🆕 callbacks.md                  // the two slots and their payload
    ├── appraise-github-issues/
    │   ├── lib/
    │   │   ├── ✏️ appraise.ts
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
        ├── lib/
        │   ├── ✏️ agent.ts
        │   ├── ✏️ callbacks.ts
        │   ├── ✏️ control-files.ts
        │   ├── ✏️ labels.ts
        │   └── ✏️ pipeline.ts
        └── prompts/
            └── ✏️ triage-and-fix.md
```

## The carver's answer

`loop-carving.json`, written in the scratch directory. Programmatic validation owns everything mechanical (enums, index bounds, scale membership, acyclic dependencies, depth, cumulative fan-out, tracker limits, required headings) and rejects the file whole on any miss; the confirmer owns meaning.

```json
{
  "issue": 1282,
  "mode": "carve",
  "verdict": "carve",
  "reason": "two entities end to end; the author side is the smaller leg",
  "chosen": 0,
  "cuts": [
    {
      "seam": "domain",
      "whyNotHigher": "",
      "relation": "layers",
      "state": "complete",
      "waitingOn": null,
      "pieces": [
        { "kind": "author", "title": "…", "body": "…", "points": 5, "role": "work", "dependsOn": [], "order": 1, "orderRung": "source-of-truth" },
        { "kind": "reference", "number": 1240, "points": null, "role": "work", "dependsOn": [0], "order": 2, "orderRung": "dependency" }
      ],
      "groundwork": [{ "what": "authors table migration", "owner": 0 }],
      "width": null,
      "balance": "5 and an existing 3; uneven but each is one thing",
      "independence": "share the migration; the second depends on the first"
    },
    { "seam": "tier", "whyNotHigher": "", "relation": "layers", "state": "complete", "waitingOn": null, "pieces": [], "groundwork": [], "width": null, "balance": "", "independence": "inadmissible: three layers of one entity are not separately provable" }
  ]
}
```

- `mode` is `carve` (no children yet) or `revisit` (children exist). `verdict` in carve mode is `carve`, `small-enough`, `indivisible`, or `too-uncertain`; in revisit mode it is `still-good`, `amend`, or `exhausted`, and `amend` carries `cuts` and `chosen` like a carve plus `supersedes: [number]` for children the new cut replaces.
- `seam` is one of `domain`, `tier`, `route`, `area`, `file`, `unit`, `material`, in ladder order. `relation` is one of `shards`, `layers`, `mixed`, `waiting`. `orderRung` is one of `dependency`, `source-of-truth`, `risk`, `size`.
- A `carve` or `amend` requires between 2 and `maxChildren` pieces in the chosen cut (a `partial` cut may have 1 when it is a spike plus nothing independent), every authored piece `points` on the configured scale and at most the ceiling, `dependsOn` acyclic, `order` a permutation consistent with `dependsOn`, every authored body carrying the three headings the template mandates (Scope, Acceptance, Proof), every `groundwork` entry owned by exactly one piece, and every referenced number an open issue.
- `width`, when present, is `{ instances: [...], perInstance: "…" }` and puts the confirmer in partition mode. A width cut's pieces are chunks; its `relation` is `shards`.
- `small-enough` is the carver disagreeing with the size. Size is the appraiser's, so this lands as `needs-human` with both opinions.
- `indivisible` and `too-uncertain` require `reason` to state, respectively, what makes the work one thing and what question a person must answer.

## The confirmer's answer

`loop-confirmation.json`: `{ "issue": N, "agree": boolean, "finding": "cover" | "gap" | "overreach" | "partition-broken", "seam": "agree" | "higher-available", "seamCase": "…", "reason": "…" }`.

The confirmer sees the parent's whole thread, every child's thread when revisiting, the chosen cut only, and the seam list. It checks: cover (or partition integrity for a width cut); mutual exclusivity of pieces; one owner per acceptance criterion of the parent; each piece has one outcome and proof available at its close; the base is usable after each piece lands in its stated order; dependencies are necessary and minimal; every groundwork item has exactly one owner and no groundwork piece lacks a named consumer; a referenced issue really is the piece it stands in for; proposed sizes include tests and proof; a spike's questions are the ones the remaining scope turns on.

`agree` is true only for `cover` (or an intact partition) with `seam: agree`. A seam dispute is allowed only when the higher seam the confirmer sees is `domain` or `tier`; between mechanistic rungs any admissible covering cut ships, and the confirmer may only note the alternative in `seamCase` for the record. A dispute of either kind goes back to the carver with the confirmer's case as feedback, up to `maxCarveRounds` (default 5); after that the parent gets `needs-human` with the whole exchange on the thread.

## Normalization

Before any piece is authored, the carver matches every piece against the open backlog (`gh issue list --search` with the piece's nouns, plus the parent's existing children and blockers on a revisit). A match with no parent is attached with `gh issue edit <n> --parent <trunk>`; a match that already has a parent stays where it is and the trunk gets `--add-blocked-by <n>`, since an issue has one parent. Only pieces with no match are authored. The confirmer checks that a referenced issue is the piece and not something adjacent. A referenced issue that already carries a size keeps it.

## What lands on the tracker

| Verdict | Trunk | Children |
|---|---|---|
| `carve`, confirmed | children created and attached in delivery order; `blocked-by` edges from `dependsOn`; then `loop/carved`; then the carving record | authored pieces via `gh issue create --parent`, body from the template, no size label; referenced pieces attached or depended on |
| `carve`, disputed past the round cap | `needs-human`; comment with the last cut and the confirmer's case; `on-carve-fail` | none |
| `small-enough` | `needs-human`; comment with both sizes | none |
| `indivisible` | `needs-human`; comment | none |
| `too-uncertain` | `needs-decision`; comment with the question | none |
| revisit `still-good` | a new carving record noting the child that closed | none |
| revisit `amend`, confirmed | new children as above; superseded children with no work started closed with a pointer to their replacement; superseded children with a PR or a merge kept and referenced; a new carving record | as above |
| revisit `exhausted` | comment linking every closed child; size label and `loop/carved` removed, in that order; the issue is appraised in the same run whatever its age | none |

Comment before label, live re-read before every write, and a trunk that gained a hold label or a child since the carver started is left alone: the same ordering rules the appraiser keeps. Creation is journaled: `runs/carve-<n>.json` holds the accepted cut and each child number as it is created, and every authored child body carries `<!-- carve parent=<n> piece=<i> -->`. A crash mid-creation resumes by listing the trunk's children, matching markers, creating only the missing pieces, then edges, then the label, then the record.

## The carving record

Rendered by `lib/record.ts` from the accepted cut and posted as one comment. Its shape is fixed so three readers can parse it: the revisit (to know the intended state and compare it against what happened), the worker (to learn whether its leaf is a shard that touches nothing or a layer that assumes the schema child landed), and a person. The child body's first line points at the trunk and says to read the record. Full shape in `references/the-record.md`.

## Ordering

Two ladders, both domain-first with the mechanistic rung last, both search orders that fall through when a rung does not discriminate.

Seams: domain, tier, route, area, file, unit, material. The larger the issue, the more the cut must be conceptual; the smaller the issue, the more freedom to cut mechanistically, because at small sizes that may be the only axiom left. Severability outranks symmetry: prefer the cut that lets a piece be worked, tested, or thrown away on its own; use symmetry as a tie-breaker.

Delivery order of the children of one cut: hard dependency (spikes and blockers first); closeness to the source of truth (definitions, schema, types, tables, API objects; then persistence; then the view); uncertainty and risk; size. The children are created in this order, so within a trunk the issue number is the delivery order, and the burndown works a trunk's leaves ascending by number while the rest of the backlog stays newest-first.

## Guards

- **Depth.** The chain of `parent` links upward is counted; at `maxDepth` (default 3) the carver is not run and the issue is `indivisible` with the depth stated. GitHub's limit is eight.
- **Fan-out.** `maxChildren` (default 8) per cut, and the trunk's existing children plus the new ones must stay under GitHub's 100.
- **Floor.** No child under 1 point, no child over the ceiling, no child without its own acceptance and proof. A file, unit, or material cut is admissible only when the physical boundary also owns one change or one reviewable outcome.
- **Idempotence.** A trunk with open children is never carved fresh; it is revisited. A trunk labelled `loop/carved` is never handed to a worker. A leaf with an open blocker is never handed to a worker.
- **Locks.** One lock per issue, `carve-<n>.lock`, so concurrent appraisal callbacks do not contend for a repository-wide lock and lose issues. The burndown's start-of-run sweep carves any issue sized over the ceiling that is neither carved nor held, so a callback that was lost (timeout, crash, contention) is retried next run.

## Revisit triggers

- **Inside the loop.** `fixIssue` returning `merged` for an issue whose `parent` is set posts the roll-up comment on the trunk (which child, the PR, a one-line proof summary, a link to the child's thread) and runs the knife in revisit mode on the trunk.
- **Outside the loop.** The burndown's start-of-run sweep lists `loop/carved` issues (by label, so the 500-issue cap on the open listing does not hide old trunks) and revisits any whose `subIssuesSummary.completed` differs from the count in its latest carving record; that covers children closed by people or by the appraiser.

## Commits

Gates use the pair the collection already has: `bunx tsc --noEmit -p .` and a dry run from an adopting repository; this plan adds `bun test` for the pure validators. Real runs are against the adopting repository's tracker on an expendable oversized issue chosen at run time and named in the run log; as of the plan date the adopting repository has a sized-8 issue against a ceiling of 5. Every commit leaves the burndown runnable.

### Commit 1: widen the shared pieces the knife needs

**Goal:** Everything in `fix-github-issue` and `appraise-github-issues` the new skill reads, before the skill exists.

**Files rewritten:**
- `skills/fix-github-issue/lib/callbacks.ts`: `runCallback(dir, name, payload, log, options?: { timeoutMs?: number })`; default stays 60 s; the spawned process is started in its own process group (`setsid` when present, as `agent.ts` does), added to `children`, and killed by group on timeout.
- `skills/fix-github-issue/lib/control-files.ts`: `CARVING_FILE = 'loop-carving.json'`.
- `skills/fix-github-issue/lib/agent.ts`: `clearsByRole.carver = [CARVING_FILE, LAST_MESSAGE_FILE]`.
- `skills/fix-github-issue/lib/labels.ts`: `ensureLabels` adds `loop/carved` ("Carved into sub-issues; worked by closing them").
- `skills/fix-github-issue/lib/pipeline.ts`: `Issue` gains optional `parent: { number } | null`, `subIssuesSummary: { total, completed }`, `blockedBy: { nodes: Array<{ number, state }> }`.
- `skills/appraise-github-issues/lib/appraise.ts`: `AppraiseKnobs.sizeCallbackTimeoutMinutes` (default 100: two agent turns of 45 plus margin), threaded to `appraiseIssue` options.
- `skills/appraise-github-issues/lib/callbacks.ts`: `SizePayload.repoRoot`; `runSizeCallback` takes the timeout as a parameter and passes it to `runCallback`.
- `skills/appraise-github-issues/references/callbacks.md`: the field and the timeout.

**Gate:** typecheck; appraise and burndown dry runs unchanged.

### Commit 2: teach the burndown the tree

**Goal:** The loop never works a trunk or a blocked leaf and works a trunk's leaves in order, before any trunk exists.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: `allIssues` and `selectCandidates` request `parent,subIssuesSummary,blockedBy`; `selectCandidates` drops issues labelled `loop/carved`, issues with `subIssuesSummary.total > completed`, and issues with a blocker whose `state` is `OPEN`; the sort stays newest-first except that issues sharing a `parent` are ordered ascending among themselves; the board marks `carved` and `revisited`.
- `skills/burn-down-github-issues/references/architecture.md`: the selection rules.

**Gate:** typecheck; burndown dry run from the adopting repository lists the same candidates as before (no trunks exist yet) and the log shows the three new exclusions with zero hits.

### Commit 3: create the skill's library, prompts, and tests

**Goal:** `carveIssue` works end to end in dry run and under test; no command yet.

**Files created:**
- `skills/carve-github-issue/lib/tree.ts`: `readTree(ctx, number)` (one `gh issue view --json` with `parent,subIssues,subIssuesSummary,blockedBy,labels,body,comments`), `depthOf`, `openChildren`, `openBlockers`, `latestRecord` (parses the newest carving record comment).
- `skills/carve-github-issue/lib/record.ts`: `renderRecord(cut, children, closedChild?)`, `parseRecord(comment)`, `renderChildBody(trunk, piece, index)` with the pointer line, the marker, and the three headings.
- `skills/carve-github-issue/lib/carve.ts`: `CarveKnobs { ceiling, maxDepth, maxChildren, maxCarveRounds, callbacksDir, seats: { carver, confirmer } }`, `CARVE_DEFAULTS`, `assertDistinctEngines` (an error, not a warning), `validateCarving`, `validateConfirmation`, `normalize` (search and match, attach or depend), `createPieces` (journaled, in delivery order, resumable by marker), `carveIssue(ctx, issue, knobs): Promise<CarveOutcome>` following `appraiseIssue`'s shape: read tree, guards, choose mode, run carver, validate, re-read live, confirm with rounds, apply, record, callbacks.
- `skills/carve-github-issue/lib/carve.test.ts`: `validateCarving` (every enum, bounds, cycles, order consistency, headings, groundwork ownership), `validateConfirmation`, `depthOf` and fan-out against fixtures, `parseRecord` round-trips `renderRecord`, resume matches markers.
- `skills/carve-github-issue/lib/callbacks.ts`: `runCarveCallback(dir, 'on-carve-pass' | 'on-carve-fail', payload, log)`; payload `{ issue, title, mode, verdict, seam, relation, children: number[], superseded: number[], reason, repo, baseBranch, repoRoot }`.
- `skills/carve-github-issue/prompts/carve.md`: read-only turn against the main checkout, the same access rules as `appraise.md`; reads the whole thread; loads `references/seams.md` by path; lists the pieces first, normalizes, then proposes a cut on every seam that applies, scores, chooses; writes the answer file even when it cannot finish.
- `skills/carve-github-issue/prompts/revisit.md`: the same, on a trunk with children: reads every child's thread including closed ones and the latest record; answers `still-good`, `amend`, or `exhausted`.
- `skills/carve-github-issue/prompts/confirm-carve.md`: the checklist above; cover or partition mode; the seam rule (dispute only for `domain` or `tier`); rendered with the round number and, after the first round, the carver's reply.
- `skills/carve-github-issue/references/seams.md`: see "The seams reference" below.
- `skills/carve-github-issue/references/the-record.md`: the record's shape and its three readers.

**Gate:** typecheck; `bun test skills/carve-github-issue` passes; a dry-run call renders the carver prompt to the run directory, stops there (a dry run has no carver answer to confirm), and mutates nothing.

### Commit 4: add the `carve.ts` command

**Goal:** The skill runs standalone.

**Files created:**
- `skills/carve-github-issue/carve.ts`: `--issue N` (required), `--dry-run`, `--ceiling N`, `--carver`, `--confirmer`, `--callbacks <dir>`; no `--no-confirm`; reads `carve-github-issue.config.ts`, else `burn-down-github-issues.config.ts` (ceiling from `maxPoints`, seats from `seats`); refuses same-engine seats; claims `carve-<n>.lock`; tees `runs/carve.log`; the same signal handling as `appraise.ts`; prints the outcome; exits non-zero on `failed`.
- `skills/carve-github-issue/SKILL.md`: what it does, trunk and leaves, normalization, the record, run lines, dependencies, the ceiling paragraph (tracker as untrusted instruction channel; confirmer independence is model-level).
- `skills/carve-github-issue/references/adopting.md`: config block, the label, what lands on the tracker, the guards, boundaries.
- `skills/carve-github-issue/references/callbacks.md`: the two slots, both forms, the payload.

**Gate:** typecheck; `carve.ts --issue <n> --dry-run` from the adopting repository writes only the log. Then one real carve of the expendable oversized issue: children attached in order, edges recorded, no child carries a size label, the trunk carries `loop/carved` and a record, `on-carve-pass` ran (a scratch executable that writes a line proves it). Then one forced dispute (`--confirmer` pointed at a seat whose prompt answers `gap`): rounds logged up to the cap, the trunk `needs-human`, nothing created, `on-carve-fail` ran.

### Commit 5: revisit on close, inside and outside the loop

**Goal:** Every leaf close re-checks its trunk.

**Files rewritten:**
- `skills/fix-github-issue/lib/pipeline.ts`: `fixIssue`, on `merged` for an issue with `parent`, posts the roll-up on the trunk and calls `carveIssue` in revisit mode through an optional `onMerged` hook the burndown supplies (the fix skill does not import the knife; the burndown wires it).
- `skills/fix-github-issue/prompts/triage-and-fix.md`: when the issue has a parent, read the parent's thread and its latest carving record before starting; the record says whether this leaf is a shard or a layer and what it may assume has landed.
- `skills/burn-down-github-issues/loop.ts`: supplies the hook; the start-of-run sweep (after stranded-PR resume, under the lock) lists `--label loop/carved`, revisits trunks whose completed count moved, and carves issues sized over the ceiling that are neither carved nor held; the board marks `revisited` and `released`.
- `skills/burn-down-github-issues/references/architecture.md`: the revisit stage and the sweep.

**Gate:** typecheck; a burndown run with `--limit 1` works a leaf of the carved trunk, posts the roll-up, and the revisit answers `still-good` with a new record. Then close the remaining leaves by hand and run again: the sweep revisits, answers `exhausted`, strips the labels in order, and the appraiser closes or re-sizes the trunk in the same run.

### Commit 6: ship the size callback that invokes the knife

**Goal:** An issue sized over the ceiling is carved without the appraiser knowing the knife exists.

**Files created:**
- `skills/burn-down-github-issues/callbacks/on-size-over-ceiling`: a shell script template with a first-line ownership marker (`# rendered by burn-down-github-issues; edits are overwritten`); reads the payload from stdin, runs `bun run {{CARVE_DIR}}/carve.ts --issue <n>` from `{{REPO_ROOT}}`, exits with its code. Executable form on purpose: invoking a program is load-bearing and never depends on an agent following prose.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: `placeSizeCallbacks` renders the template to `<callbacksDir>/on-size-over-<maxPoints>` with the two paths substituted and the executable bit set, removes any other `on-size-over-*` file that carries the ownership marker (an adopter's file without the marker is left alone), and does none of this in a dry run.
- `skills/burn-down-github-issues/callbacks/README.md`: the shipped callback, the rendering, the marker.
- `skills/burn-down-github-issues/SKILL.md`, `references/adopting.md`, `references/operating.md`, `README.md`: the carving stage, the `carve` config block, the label, the skill row.

**Gate:** typecheck; a burndown run that appraises a fresh issue sized over the ceiling shows the callback firing and the carve log under `runs/`; link check over every touched `.md`; no em dashes in the diff.

### Commit 7: update the adopting repository's config

**Files rewritten (in the adopting repository):**
- `burn-down-github-issues.config.ts`: optional `carve: { maxDepth: 3, maxChildren: 8, maxCarveRounds: 5 }`; `seats.carver`.

**Gate:** burndown and carve dry runs load the config without error.

### Commit 8: delete this plan

- Delete `add-carve-github-issue.md`.
- The methodology (`references/seams.md`) and the record's shape (`references/the-record.md`) are skill docs and stay.

**Gate:** typecheck passes; `grep -rn add-carve-github-issue` over the repository is empty.

## The seams reference

`references/seams.md` is the skill's methodology and is written for the carver, not for a person. Its sections, in order:

1. **Why this ladder differs from the canon.** The story-splitting canon writes cards for people who slice below the card privately, so a card can stay a vertical story and horizontal cuts are called a smell. Here the card is the unit an agent works, so the slice that would have been private is written down. Horizontal cuts happen either way; the only question is whether the tracker records them.
2. **The ladder**, one paragraph per rung: what the seam is, when it applies, what a child cut on it looks like, and its admissibility condition. Domain first because a child cut there is provable on its own; tier keeps its rung because a client that is its own application in memory has a real contract at the boundary, and the admissibility gate ("each tier child provable on its own") does the work a ban would; material last because it is blind to what the work means and is right only for width.
3. **The axioms.** Seam order matters more as size grows, and the converse: the smaller the issue, the more freedom to cut mechanistically. Severability outranks symmetry; symmetry is a tie-breaker. The ladder is a search order, not a trump card.
4. **Normalization.** List the pieces first (an issue that is a list of unrelated asks becomes one piece per ask), match each against the backlog, author only what is missing.
5. **Floor and ceiling.** Too large: still divisible or parallelizable. Too small: the issue costs more to write than to do; operationally, a child without its own acceptance and proof, or under the scale's smallest rung.
6. **Width.** Recognize it (one criterion, many instances); it is a partition, not a count: a stable, deduplicated manifest, each instance in exactly one chunk, the same acceptance per chunk, shared tooling owned by one chunk. The mechanistic rungs are the right cut here because the instances are interchangeable.
7. **Shared groundwork.** Name it per cut and give each item one owner: the earliest piece that exercises it, or its own piece only when it exposes a stable interface with its own proof and a named consumer.
8. **Dependencies and delivery order.** Partition by deliverable first, derive order second. A dependent child must still be acceptable on its own once its prerequisite exists; keep the critical path short. The ordering ladder: hard dependency, source of truth, risk, size; and the note that "smallest useful slice first" is a heuristic that usually lands on the risk rung by accident and must not be applied over a dependency.
9. **Hand-offs and spikes.** `indivisible` versus `too-uncertain`, with the Rumsfeld distinction; a technical unknown is a `spike` piece whose acceptance is the questions answered, and the rest of the cut waits on it.
10. **Non-code pieces.** Design, docs, migrations, operations are valid when each names a deliverable and its evidence; an unresolved preference is a hand-off, not a design piece.
11. **Other people's seams**, mapped onto the ladder: Lawrence's nine patterns and his two selection rules (severability, then equal size); Cohn's SPIDR (paths and rules are domain seams, interface a tier seam, spike the technical unknown); Cockburn's Elephant Carpaccio (why domain outranks tier); Parnas (a boundary that hides one decision is the admissibility test for the low rungs and the independence score); the WBS 100% rule (the cover gate) and 8/80 (floor and ceiling in hours); Google's small-CL guidance (stacked, per-file, horizontal, vertical, and the stable-stub condition for horizontal); Adzic's hamburger method (technical steps when no vertical cut exists); Asthana et al. 2026 (validation gates between sub-tasks, and retrying only the failed phase, which is the journal).

## Verification checklist

- [ ] `bunx tsc --noEmit -p .` and `bun test` pass at every commit.
- [ ] Appraise and burndown dry runs from the adopting repository are unchanged after Commits 1 and 2.
- [ ] One real standalone carve produced attached children in delivery order, edges recorded, no size labels on children, `loop/carved` and a record on the trunk, and a referenced existing issue where one matched.
- [ ] One forced dispute ran the rounds to the cap, left the trunk `needs-human` with the exchange, and created nothing.
- [ ] A crash injected mid-creation (kill the process after the first child) resumed on the next run without a duplicate child.
- [ ] One burndown run skipped the trunk, worked its first leaf by order, posted the roll-up, and revisited `still-good`.
- [ ] One sweep revisited a trunk whose leaves were closed by hand, answered `exhausted`, and the appraiser handled it in the same run.
- [ ] The shipped size callback fired for an issue sized over the ceiling; the rendered file carries the marker; an unmarked adopter file survived a ceiling change.
- [ ] Every relative link in the touched SKILL and reference files resolves; no em dashes in any touched file.
- [ ] Plan file deleted (Inspector Gadget Rule: no orphan plans).

## Answered questions

- **Executable or prompt for the shipped callback?** Executable: a program invocation is load-bearing and never depends on an agent following prose. The prompt form stays available for adopters.
- **Is confirmation optional?** No. There is no flag and no knob; same-engine seats refuse to start. The earlier draft carried the appraiser's `--no-confirm` by copying, not by decision.
- **Do children get sizes from the knife?** No. The carver proposes points so the confirmer can judge balance; the label comes from the appraiser on a later pass. One skill owns size.
- **What happens to the trunk?** Never closed by the knife. Handed back to the appraiser by the revisit's `exhausted` answer; the appraiser's confirmed close ends it. The one close the knife makes is a superseded child with no work started, inside a confirmed re-cut.
- **What is `wide`?** Not a verdict. A cut whose instances are interchangeable, judged for partition integrity; its residue is the `shards` relation on the record.
- **Depth cap default?** 3. Deep enough for 21 to reach 3s along the Fibonacci scale; shallow enough that a bad decomposition cannot recurse into GitHub's eight-level limit.
- **Round cap default?** 5, chosen by the author; expected to be reached rarely because both agents share the ladder.

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

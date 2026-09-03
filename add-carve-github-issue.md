# Add `carve-github-issue`: erode oversized issues into sub-issues

**Status:** Draft
**Scope:** cross-stack
**Date:** 2026-09-02
**Last reviewed:** 2026-09-03
**Context:** The appraiser now runs a size callback after every `valid` verdict, but nothing answers it: an issue sized above the burndown's ceiling is labelled and then sits, because no skill turns a 13 into an 8 and a 5.

## Goal

The burndown works issues at or under a ceiling (`maxPoints`, default 5). Everything above it is sized and then ignored forever, so the hardest work in a backlog is precisely the work the loop never touches.

`carve-github-issue` reads one oversized issue, names its pieces along the highest seam the work has, matches each piece against the open backlog so nothing is authored twice, has a second engine confirm that the pieces cover the parent, and only then expresses the parent as GitHub sub-issues. The parent stays open as the trunk and is worked by closing its leaves; every leaf close triggers a revisit of the trunk, and a trunk with nothing left goes back to the appraiser.

Done looks like: `bun run <skill-dir>/carve.ts --issue N` carves or revisits one issue; the burndown invokes it over its ceiling, works leaves in recorded order and never a trunk, and revisits a trunk whenever a leaf closes.

## Domain context

- **Seam.** A line along which one issue can be cut into children that each stand alone. Seams are ranked (domain, tier, route, area, file, unit, material) and searched from the top; a cut on any rung is admissible only if every child has one bounded outcome, its own acceptance and proof, and leaves the base usable after it lands. The ladder is a search order, not a trump card. The methodology is `references/seams.md`.
- **Piece.** One unit of the parent's work as the carver names it. A piece becomes a child by authoring a new issue or by referencing one the backlog already has. Normalization (list the pieces, match each against the open backlog, author only what is missing) is a step of every carve.
- **Cover.** The confirmer's verdict that the union of the pieces is the parent: no ask missing (`gap`), nothing added (`overreach`). A width cut (interchangeable instances) is judged for partition integrity instead.
- **Trunk and leaves.** The parent is the trunk: open, labelled `loop/carved`, never handed to a worker while a child is open. Leaves are landable increments the burndown works. An interior node is a trunk of its own.
- **Carving record.** A comment with a fixed shape posted on the trunk after every carve and revisit; the newest is authoritative. Workers, revisits, the burndown's sweep, and people read it. Its shape is `references/the-record.md`.

## Domain categories

- **Cut.** One candidate decomposition along one seam: pieces, relation, delivery order, shared groundwork with owners, and a reason for every higher rung not taken. The carver proposes a cut on every seam that applies and chooses one; the alternatives stay in its answer.
- **Relation** of the children of one cut, one of: `shards` (disjoint slices of one job; any order; parallel), `layers` (each builds on the one before; source of truth first), `mixed` (edges listed per child), `waiting` (everything unlisted depends on a named spike).
- **Revisit.** The knife on a trunk that already has children: `still-good`, `amend` (add, reference, or supersede pieces), or `exhausted` (every acceptance criterion of the parent is completed and no recorded dependency is open). Triggered by every child close.
- **Generation.** One carve or amend of a trunk. Numbered from 1 on the trunk's records; markers and journals carry it so successive generations never match each other's children.
- **Hand-offs.** `indivisible` (cannot be cut at this ceiling) goes to `needs-human`; `too-uncertain` (a product ruling nobody has made) goes to `needs-decision` with the question; `small-enough` (the carver disputes the size) goes to `needs-human` with both opinions. A technical unknown is none of these: it becomes a `spike` piece and the rest of the cut waits on it.

## Current surface area

| Where | What | Change |
|---|---|---|
| `skills/appraise-github-issues/lib/appraise.ts` :59-76 | `AppraiseKnobs`, `appraiseIssue` options | `sizeCallbackTimeoutMinutes` (0 = bounded by the callee) |
| `skills/appraise-github-issues/appraise.ts` :215 | standalone caller | passes the timeout |
| `skills/appraise-github-issues/lib/callbacks.ts` | `SizePayload`, `runSizeCallback` | payload gains `repoRoot`; timeout passed through |
| `skills/appraise-github-issues/references/callbacks.md` | ladder, forms, payload | field and timeout |
| `skills/fix-github-issue/lib/callbacks.ts` :22, :53-61 | `runCallback` | `timeoutMs` option (0 = none); process-group kill; registered in `children` |
| `skills/fix-github-issue/lib/agent.ts` :220 | `clearsByRole` | `carver` entry |
| `skills/fix-github-issue/lib/control-files.ts` | control-file names | `CARVING_FILE` |
| `skills/fix-github-issue/lib/labels.ts` :21 | `ensureLabels` | `loop/carved` |
| `skills/fix-github-issue/lib/pipeline.ts` :27, :67, :503, :513, :708 | `FixOutcome`, `Issue`, close paths, `fixIssue` | tree fields; `onClosed` hook fired for `merged`, `already-fixed`, `obsolete` |
| `skills/fix-github-issue/prompts/triage-and-fix.md` | worker prompt | read the parent's record when the issue has one |
| `skills/burn-down-github-issues/loop.ts` :485, :554, :624, :775-808 | `allIssues`, `selectCandidates`, `placeSizeCallbacks`, `main` | tree fields; trunk and blocker rules; leaf order from the record; rendered callback with marker; sweep; hook wiring; same-run appraisal after `exhausted` |
| `skills/burn-down-github-issues/status.ts` :11 | `Stage` union and emoji map | `carved`, `revisited`, `released` |
| `skills/burn-down-github-issues/callbacks/README.md` | empty slot directory | the shipped callback |
| `skills/burn-down-github-issues/references/{architecture,adopting,operating}.md`, `SKILL.md` | | carving stage, revisit, selection rules, the label, the `carve` config block |
| `README.md` | skill table | row for `carve-github-issue` |

Forge facts (verified 2026-09-02 against `gh` 2.97.0): `gh issue create --parent N` creates a child already attached; `gh issue edit N --parent P` attaches an existing issue; `gh issue edit N --add-blocked-by M` records a dependency; `gh issue list --json` exposes `parent`, `subIssues`, `subIssuesSummary {total, completed}`, `blockedBy {nodes: [{number, state}]}`, and `blocking`; `--limit 1000` is accepted. GitHub allows 100 sub-issues per parent and eight levels of nesting; each issue has one parent.

## File structure: before

**Legend:** ✏️ rewritten

```
simiancraft-skills/
├── ✏️ README.md
└── skills/
    ├── appraise-github-issues/
    │   ├── ✏️ appraise.ts                       // passes the callback timeout
    │   ├── lib/
    │   │   ├── ✏️ appraise.ts                   // sizeCallbackTimeoutMinutes knob
    │   │   └── ✏️ callbacks.ts                  // repoRoot in the payload; timeout passed through
    │   └── references/
    │       └── ✏️ callbacks.md
    ├── burn-down-github-issues/
    │   ├── ✏️ SKILL.md
    │   ├── ✏️ loop.ts                           // selection; leaf order; sweep; hook; callback rendering
    │   ├── ✏️ status.ts                         // three stages
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
        │   └── ✏️ pipeline.ts                   // tree fields; onClosed hook
        └── prompts/
            └── ✏️ triage-and-fix.md             // read the parent's record
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
    │   │   ├── 🆕 carve.ts                      // carveIssue(ctx, issue, knobs): CarveOutcome; validation; rounds; apply; journal
    │   │   ├── 🆕 carve.test.ts                 // validators, record round-trip, resume, ledger, under bun test
    │   │   ├── 🆕 tree.ts                       // depth, children, blockers, latest record, generation, from gh json
    │   │   ├── 🆕 record.ts                     // render and parse the record; render a child body; the criterion ledger
    │   │   └── 🆕 callbacks.ts                  // on-carve-pass / on-carve-fail on the shared slot mechanism
    │   ├── 🆕 prompts/
    │   │   ├── 🆕 carve.md                      // the carver turn: pieces, normalization, seams, cuts, choice
    │   │   ├── 🆕 revisit.md                    // the carver turn on a trunk that has children
    │   │   └── 🆕 confirm-carve.md              // the confirmer turn: cover or partition, the checklist, seam dispute, revisit answers
    │   └── 🆕 references/
    │       ├── 🆕 seams.md                      // the ladder, the axioms, the floor, width, normalization, ordering, literature
    │       ├── 🆕 adopting.md                   // config, the label, what lands on the tracker, guards, boundaries
    │       ├── 🆕 the-record.md                 // the record's shape, the ledger, who reads it
    │       └── 🆕 callbacks.md                  // the two slots and their payload
    ├── appraise-github-issues/
    │   ├── ✏️ appraise.ts
    │   ├── lib/
    │   │   ├── ✏️ appraise.ts
    │   │   └── ✏️ callbacks.ts
    │   └── references/
    │       └── ✏️ callbacks.md
    ├── burn-down-github-issues/
    │   ├── ✏️ SKILL.md
    │   ├── ✏️ loop.ts
    │   ├── ✏️ status.ts
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

`loop-carving.json`, written in the scratch directory. Programmatic validation owns everything mechanical and rejects the file whole on any miss; the confirmer owns meaning.

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
      "higherRungs": [],
      "relation": "layers",
      "state": "complete",
      "deferred": [],
      "pieces": [
        { "kind": "author", "title": "…", "body": "…", "points": 5, "role": "work", "dependsOn": [], "order": 1, "orderRung": "source-of-truth", "criteria": ["A1", "A2"] },
        { "kind": "reference", "number": 1240, "points": null, "role": "work", "dependsOn": [0], "order": 2, "orderRung": "dependency", "criteria": ["A3"] }
      ],
      "groundwork": [{ "what": "authors table migration", "owner": 0 }],
      "width": null,
      "balance": "5 and an existing 3; uneven but each is one thing",
      "independence": "share the migration; the second depends on the first"
    },
    { "seam": "tier", "higherRungs": [{ "seam": "domain", "why": "…" }], "relation": "layers", "state": "complete", "deferred": [], "pieces": [], "groundwork": [], "width": null, "balance": "", "independence": "inadmissible: three layers of one entity are not separately provable" }
  ],
  "criteria": [{ "id": "A1", "text": "…" }, { "id": "A2", "text": "…" }, { "id": "A3", "text": "…" }]
}
```

- `criteria` is the carver's inventory of the parent's acceptance criteria, numbered, taken from the whole thread. Every criterion is owned by exactly one piece (`criteria` on the piece) or listed in `deferred` with the spike it waits on. This is the 100% rule made checkable.
- `mode` is `carve` or `revisit`. Carve verdicts: `carve`, `small-enough`, `indivisible`, `too-uncertain`. Revisit verdicts: `still-good`, `amend`, `exhausted`; `amend` carries `cuts` and `chosen` plus `supersedes: [{ old, replacements: [pieceIndex], reason }]`, and every `old` must be a child in the latest record.
- `seam` is one of `domain`, `tier`, `route`, `area`, `file`, `unit`, `material`. For a cut below `domain`, `higherRungs` names every rung above it with a non-empty reason it did not apply or was inadmissible; a lower cut is invalid while a higher one is admissible. `relation` and `orderRung` (`dependency`, `source-of-truth`, `risk`, `size`) take the values named above.
- A `carve` or `amend` requires 2 to `maxChildren` pieces (1 allowed when `state` is `partial` and the piece is a spike), every authored piece `points` on the scale and at most the ceiling, `dependsOn` acyclic, `order` a permutation consistent with `dependsOn`, every authored body carrying the headings Scope, Acceptance, and Proof, every groundwork item owned by exactly one piece, and every referenced number an open issue.
- `width`, when present, is `{ instances: [...], perInstance: "…" }`; its pieces are chunks, its relation `shards`, and the confirmer judges the partition.
- `indivisible` and `too-uncertain` require `reason` to state, respectively, what makes the work one thing and what question a person must answer.

## The confirmer's answer

`loop-confirmation.json`: `{ "issue": N, "mode": "carve" | "revisit", "agree": boolean, "finding": "cover" | "gap" | "overreach" | "partition-broken" | "still-good" | "exhausted" | "not-exhausted", "seam": "agree" | "higher-available", "seamCase": "…", "reason": "…" }`.

The confirmer sees the parent's whole thread, every child's thread on a revisit (closed ones included), the chosen cut only, the criteria inventory, and the seam list. On a `carve` or `amend` it checks: every criterion in the inventory is real and none is missing from the thread; cover, or partition integrity for a width cut; mutual exclusivity; one owner per criterion; each piece has one outcome and proof available at its close; the base is usable after each piece lands in its stated order; dependencies are necessary and minimal; every groundwork item has one owner and no groundwork piece lacks a named consumer; a referenced issue really is the piece it stands in for; proposed sizes include tests and proof; a partial cut's deferred criteria are exactly the ones the spike's questions decide. On `still-good` it checks the ledger against the tree; on `exhausted` it checks every criterion is completed by a closed child or closed reference and no recorded dependency is open. Only a confirmed `exhausted` begins release.

`agree` is true only for `cover` (or intact partition, `still-good`, `exhausted`) with `seam: agree`. A seam dispute is allowed only when the higher seam the confirmer sees is `domain` or `tier`; between mechanistic rungs any admissible covering cut ships and the alternative is noted in `seamCase`. A dispute of any kind goes back to the carver with the confirmer's case as feedback; `maxCarveRounds` (default 5) counts carver-confirmer pairs; after the cap the trunk gets `needs-human` with the whole exchange on the thread.

## Normalization

Before any piece is authored, the carver matches every piece against the open backlog (`gh issue list --search` with the piece's nouns, plus the trunk's existing children and blockers on a revisit). Immediately before apply, every referenced issue is re-read: one that closed restarts the carve from the carver; one whose parent changed is re-treated. A reference with no parent is attached with `gh issue edit <n> --parent <trunk>`; one that already has a parent stays where it is and the trunk gets `--add-blocked-by <n>`. Only unmatched pieces are authored. A referenced issue that already carries a size keeps it.

## What lands on the tracker

| Verdict | Trunk | Children |
|---|---|---|
| `carve` or `amend`, confirmed | in order: authored children created (delivery order), references attached or depended on, `blocked-by` edges, the carving record, then `loop/carved`; on `amend`, superseded children with no work started are closed with a pointer to their replacements before the record | authored pieces via `gh issue create --parent`, body from the template, no size label |
| disputed past the round cap | `needs-human`; comment with the last cut and the confirmer's case; `on-carve-fail` | none |
| `small-enough` | `needs-human`; comment with both sizes | none |
| `indivisible` | `needs-human`; comment | none |
| `too-uncertain` | `needs-decision`; comment with the question | none |
| revisit `still-good`, confirmed | a new record with the ledger updated | none |
| revisit `exhausted`, confirmed | comment linking every closed child; size label removed; `loop/carved` removed; then the appraiser is run on it directly, whatever its age | none |

"Work started" on a child means any of: an open pull request referencing it, an assignee, a lane for it under the run directory, or a `loop/*` label. A superseded child with any of those is kept and referenced as a piece of the new cut instead of closed.

Live re-read before every write, comment before label, and a trunk that gained a hold label since the carver started is left alone. Creation is journaled per generation: `runs/carve-<n>-gen<g>.json` holds the accepted cut and each child number as it lands, and every authored body carries `<!-- carve parent=<n> gen=<g> piece=<i> -->`. Resume, on any entry to a trunk: list its children; if the latest record's generation has a journal with unfinished steps, or children carry a generation newer than the latest record, finish that generation from the journal (missing pieces, then edges, then record, then label) before doing anything else. A trunk with `loop/carved` and no size label is a release that crashed between its two label writes; the sweep finishes it by removing the label and running the appraiser.

## The carving record

Rendered by `lib/record.ts` from the accepted cut and posted as one comment with a fixed heading and generation number. It carries: the seam and the reasons for every higher rung; the state (`complete` or `partial` with the deferred criteria and the spike each waits on); the criterion ledger (every criterion of the parent with its owner and its status: `open`, `completed`, `deferred`, `superseded`); the children as a table (number, piece, authored or referenced, attached or blocker, proposed size, delivery order and the rung that decided it, dependencies); the relation; shared groundwork with owners; and the counts the sweep compares against (`children total`, `children completed`, `blockers open`). The child body's first line points at the trunk and says to read the record. Full shape in `references/the-record.md`.

## Ordering

Two ladders, both domain-first with the mechanistic rung last, both search orders that fall through when a rung does not discriminate.

Seams: domain, tier, route, area, file, unit, material. The larger the issue, the more the cut must be conceptual; the smaller, the more freedom to cut mechanistically, because at small sizes that may be the only axiom left. Severability outranks symmetry; symmetry is a tie-breaker.

Delivery order within one cut: hard dependency; closeness to the source of truth (definitions, schema, types, tables, API objects; then persistence; then the view); uncertainty and risk; size. The confirmed `order` in the newest record is canonical; issue numbers never encode order. The burndown reads the order from the record for candidates that have a parent (one `gh issue view` per trunk, cached per run) and works a trunk's leaves in it; the rest of the backlog stays newest-first.

## Guards

- **Depth.** `depthOf` walks `parent` upward one `gh issue view --json parent` per level, stopping at `maxDepth` (default 3); at the cap the issue is `indivisible` with the depth stated. GitHub's limit is eight.
- **Fan-out.** `maxChildren` (default 8) per cut, and the trunk's `subIssuesSummary.total` plus authored pieces must stay at or under 100.
- **Floor.** No child under 1 point, none over the ceiling, none without its own acceptance and proof. A file, unit, or material cut is admissible only when the physical boundary also owns one change or one reviewable outcome.
- **Idempotence.** A trunk with children is revisited, never carved fresh. A `loop/carved` trunk is never handed to a worker. A leaf with an open blocker is never handed to a worker.
- **Locks.** `carveIssue` itself claims `carve-<n>.lock` (so the CLI and the burndown's hook share it), and returns `busy` without waiting when another process holds it. The sweep retries anything left behind.
- **Time.** The knife bounds itself: each agent turn has the runtime's 45-minute cap, rounds are capped, so a carve terminates by construction. The size callback that invokes it therefore runs with no outer timeout by default (`sizeCallbackTimeoutMinutes: 0`); the burndown's shutdown kills its process group.

## Revisit triggers

- **Inside the loop.** `fixIssue` fires `onClosed(issue, { kind: 'merged' | 'closed', pr?, sha?, reason })` after the child is closed, for `merged`, `already-fixed`, and `obsolete`; a hook failure is logged and does not change the `FixOutcome`. The burndown's hook posts the roll-up on the trunk (which child, the PR and merge sha when there is one, the worker's stated reason, a link to the child's thread) and calls `carveIssue` in revisit mode.
- **Outside the loop.** The start-of-run sweep, after stranded-PR resume and under the loop lock: `gh issue list --label loop/carved --limit 1000`; any trunk whose live `subIssuesSummary.completed` or open-blocker count differs from the counts in its latest record is revisited; any unfinished generation or half-done release is finished first. Then, for each scale rung above the ceiling, `gh issue list --label "size: <n>" --limit 1000` and every issue not carved, not held, and without children is carved; this is the repair path for a lost callback.

## Commits

Every gate is the full pair: `bunx tsc --noEmit -p .` and `bun test`, plus what the commit names. Real runs are against the adopting repository's tracker on an expendable oversized issue chosen at run time and named in the run log.

### Commit 1: widen the shared pieces the knife needs

**Goal:** Everything in `fix-github-issue` and `appraise-github-issues` the new skill reads, before the skill exists.

**Files rewritten:**
- `skills/fix-github-issue/lib/callbacks.ts`: `runCallback(dir, name, payload, log, options?: { timeoutMs?: number })`; default stays 60 s; `0` means no timer; the process starts in its own group (`setsid` when present, as `agent.ts` does), is added to `children`, and is killed by group on timeout or shutdown.
- `skills/fix-github-issue/lib/control-files.ts`: `CARVING_FILE = 'loop-carving.json'`.
- `skills/fix-github-issue/lib/agent.ts`: `clearsByRole.carver = [CARVING_FILE, LAST_MESSAGE_FILE]`.
- `skills/fix-github-issue/lib/labels.ts`: `ensureLabels` adds `loop/carved` ("Carved into sub-issues; worked by closing them").
- `skills/fix-github-issue/lib/pipeline.ts`: `Issue` gains optional `parent: { number } | null`, `subIssuesSummary: { total, completed }`, `blockedBy: { nodes: Array<{ number, state }> }`; `fixIssue` gains `options.onClosed` fired as described under Revisit triggers.
- `skills/appraise-github-issues/lib/appraise.ts`: `AppraiseKnobs.sizeCallbackTimeoutMinutes` (default 0), threaded through `appraiseIssue` options to `runSizeCallback`.
- `skills/appraise-github-issues/appraise.ts`: passes it.
- `skills/appraise-github-issues/lib/callbacks.ts`: `SizePayload.repoRoot`; the timeout parameter.
- `skills/appraise-github-issues/references/callbacks.md`: the field and the timeout.

**Gate:** the pair; appraise and burndown dry runs unchanged.

### Commit 2: teach the burndown the tree

**Goal:** The loop never works a trunk or a blocked leaf and works a trunk's leaves in recorded order, before any trunk exists.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: `allIssues` and `selectCandidates` request `parent,subIssuesSummary,blockedBy`; `selectCandidates` drops issues labelled `loop/carved`, issues with `subIssuesSummary.total > completed`, and issues with a blocker whose `state` is `OPEN`; candidates with a `parent` are ordered among siblings by the order in the trunk's latest record (missing record: by number ascending), and the sort is stable with the rest newest-first.
- `skills/burn-down-github-issues/status.ts`: `Stage` gains `carved` (🔪), `revisited` (🔁), `released` (🪵) and the emoji map entries.
- `skills/burn-down-github-issues/references/architecture.md`: the selection rules.

**Gate:** the pair; burndown dry run from the adopting repository lists the same candidates as before and logs the three new exclusions with zero hits.

### Commit 3: create the skill's library, prompts, and tests

**Goal:** `carveIssue` works end to end under test and in dry run; no command yet.

**Files created:**
- `skills/carve-github-issue/lib/tree.ts`: `readTree(ctx, number)` (one `gh issue view --json` with `parent,subIssues,subIssuesSummary,blockedBy,labels,body,comments`), `depthOf`, `openChildren`, `openBlockers`, `latestRecord`, `nextGeneration`.
- `skills/carve-github-issue/lib/record.ts`: `renderRecord(cut, children, ledger, counts)`, `parseRecord(comment)`, `renderChildBody(trunk, generation, piece, index)`, `buildLedger(record, tree)`.
- `skills/carve-github-issue/lib/carve.ts`: `CarveKnobs { ceiling, maxDepth, maxChildren, maxCarveRounds, callbacksDir, seats: { carver, confirmer } }`, `CARVE_DEFAULTS`, `assertDistinctEngines` (an error), `validateCarving`, `validateConfirmation`, `normalize`, `createPieces` (journaled per generation, delivery order, resumable by marker), `finishGeneration`, `finishRelease`, `carveIssue(ctx, issue, knobs): Promise<CarveOutcome>`: lock, read tree, resume unfinished work, guards, choose mode, run carver, validate, re-read live, confirm with rounds, apply, record, callbacks, unlock. `CarveOutcome` is the verdict plus `busy`, `resumed`, and `failed`.
- `skills/carve-github-issue/lib/carve.test.ts`: `validateCarving` (every enum, bounds, cycles, order consistency, headings, criterion ownership, `higherRungs` non-empty below domain, supersedes against a record), `validateConfirmation` per mode, `depthOf` and fan-out against fixtures, `parseRecord` round-trips `renderRecord`, `buildLedger` on fixture trees (open, completed, deferred, superseded, blocker closed), resume matches markers by generation, sweep count comparison.
- `skills/carve-github-issue/lib/callbacks.ts`: `runCarveCallback(dir, 'on-carve-pass' | 'on-carve-fail', payload, log)`; payload `{ issue, title, mode, verdict, generation, seam, relation, children: number[], superseded: number[], reason, repo, baseBranch, repoRoot }`.
- `skills/carve-github-issue/prompts/carve.md`: read-only turn against the main checkout with `appraise.md`'s access rules; reads the whole thread; inventories the criteria; normalizes; loads `references/seams.md` by path; proposes a cut on every seam that applies with reasons for every higher rung; scores; chooses; writes the answer file even when it cannot finish.
- `skills/carve-github-issue/prompts/revisit.md`: the same on a trunk with children: reads every child's thread including closed ones and the latest record; rebuilds the ledger; answers `still-good`, `amend`, or `exhausted`.
- `skills/carve-github-issue/prompts/confirm-carve.md`: the checklist above per mode; the seam rule; rendered with the round number and, after the first round, the carver's reply.
- `skills/carve-github-issue/references/seams.md`: see "The seams reference".
- `skills/carve-github-issue/references/the-record.md`: the record's shape, the ledger, its readers.

**Gate:** the pair; a dry-run call renders the carver prompt to the run directory, stops there (a dry run has no carver answer to confirm), and mutates nothing.

### Commit 4: add the `carve.ts` command

**Goal:** The skill runs standalone.

**Files created:**
- `skills/carve-github-issue/carve.ts`: `--issue N` (required), `--dry-run`, `--ceiling N`, `--carver`, `--confirmer`, `--callbacks <dir>`; reads `carve-github-issue.config.ts`, else `burn-down-github-issues.config.ts` (ceiling from `maxPoints`, seats from `seats`, limits from an optional `carve` block); refuses same-engine seats; tees `runs/carve.log`; the same signal handling as `appraise.ts`; prints the outcome; exits non-zero on `failed`, 3 on `busy`.
- `skills/carve-github-issue/SKILL.md`: what it does, trunk and leaves, normalization, the record, run lines, dependencies, the ceiling paragraph (tracker as untrusted instruction channel; confirmer independence is model-level).
- `skills/carve-github-issue/references/adopting.md`: the `carve` config block (`maxDepth: 3, maxChildren: 8, maxCarveRounds: 5`), `seats.carver`, the label, what lands on the tracker, the guards, boundaries.
- `skills/carve-github-issue/references/callbacks.md`: the two slots, both forms, the payload.

**Gate:** the pair; `carve.ts --issue <n> --dry-run` from the adopting repository writes only the log. Then one real carve of the expendable oversized issue: children attached in delivery order, edges recorded, no child carries a size label, the trunk carries a generation-1 record and `loop/carved`, `on-carve-pass` ran (a scratch executable that writes a line proves it). Then one forced dispute (`--confirmer` pointed at a seat whose prompt answers `gap`): rounds logged to the cap, the trunk `needs-human`, nothing created, `on-carve-fail` ran. Then a crash injected after the first child of a fresh carve: the next run resumes the generation without a duplicate.

### Commit 5: revisit on close, inside and outside the loop

**Goal:** Every leaf close re-checks its trunk.

**Files rewritten:**
- `skills/fix-github-issue/prompts/triage-and-fix.md`: when the issue has a parent, read the parent's thread and its latest carving record before starting; the record says whether this leaf is a shard or a layer and what it may assume has landed.
- `skills/burn-down-github-issues/loop.ts`: supplies `onClosed` (roll-up, then `carveIssue` in revisit mode; after a confirmed `exhausted`, `appraiseIssue` directly on the trunk); the start-of-run sweep as described under Revisit triggers; the board marks `revisited` and `released`.
- `skills/burn-down-github-issues/references/architecture.md`: the revisit stage and the sweep.

**Gate:** the pair; a burndown run with `--limit 1` works the first leaf by recorded order, posts the roll-up, and the revisit answers `still-good` with a generation-1 record whose ledger shows one criterion completed. Then close the remaining leaves by hand and run again: the sweep revisits, `exhausted` is confirmed, the labels come off in order, and the appraiser handles the trunk in the same run.

### Commit 6: ship the size callback that invokes the knife

**Goal:** An issue sized over the ceiling is carved without the appraiser knowing the knife exists.

**Files created:**
- `skills/burn-down-github-issues/callbacks/on-size-over-ceiling`: a shell script template with a first-line ownership marker (`# rendered by burn-down-github-issues; edits are overwritten`); reads the payload from stdin, runs `bun run {{CARVE_DIR}}/carve.ts --issue <n>` from `{{REPO_ROOT}}`, exits with its code. Executable form on purpose: invoking a program is load-bearing and never depends on an agent following prose.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: `placeSizeCallbacks` renders the template to `<callbacksDir>/on-size-over-<maxPoints>` with the two paths substituted and the executable bit set, removes any other `on-size-over-*` file that carries the marker (an unmarked adopter file is left alone), and does none of this in a dry run.
- `skills/burn-down-github-issues/callbacks/README.md`: the shipped callback, the rendering, the marker.
- `skills/burn-down-github-issues/SKILL.md`, `references/adopting.md`, `references/operating.md`, `README.md`: the carving stage, the `carve` config block and `seats.carver`, the label, the skill row.

**Gate:** the pair; a burndown run that appraises a fresh issue sized over the ceiling shows the callback firing and the carve log under `runs/`; a ceiling change re-renders and leaves an unmarked file alone; link check over every touched `.md`; no em dashes in the diff. The adopting repository's config gains its `carve` block and `seats.carver` outside this repository before this gate runs; that file is the adopter's and is not part of this plan's tree.

### Commit 7: delete this plan

- Delete `add-carve-github-issue.md`, after the two-key handshake: every commit shipped, the checklist green, the developer's explicit confirmation.
- The methodology (`references/seams.md`) and the record's shape (`references/the-record.md`) are skill docs and stay.

**Gate:** the pair; `grep -rn add-carve-github-issue` over the repository is empty.

## The seams reference

`references/seams.md` is the skill's methodology and is written for the carver. Its sections, in order:

1. **Why this ladder differs from the canon.** The story-splitting canon writes cards for people who slice below the card privately, so a card can stay a vertical story and horizontal cuts are called a smell. Here the card is the unit an agent works, so the slice that would have been private is written down. Horizontal cuts happen either way; the only question is whether the tracker records them.
2. **The ladder**, one paragraph per rung: what the seam is, when it applies, what a child cut on it looks like, and its admissibility condition. Domain first because a child cut there is provable on its own; tier keeps its rung because a client that is its own application in memory has a real contract at the boundary, and the admissibility gate does the work a ban would; material last because it is blind to what the work means and is right only for width. A cut below domain must say, for every higher rung, why it did not apply.
3. **The axioms.** Seam order matters more as size grows, and the converse: the smaller the issue, the more freedom to cut mechanistically. Severability outranks symmetry; symmetry is a tie-breaker. The ladder is a search order, not a trump card.
4. **Normalization.** Inventory the criteria and the pieces first (an issue that is a list of unrelated asks becomes one piece per ask), match each piece against the backlog, author only what is missing, re-read references before apply.
5. **Floor and ceiling.** Too large: still divisible or parallelizable. Too small: the issue costs more to write than to do; operationally, a child without its own acceptance and proof, or under the scale's smallest rung.
6. **Width.** Recognize it (one criterion, many instances); it is a partition, not a count: a stable, deduplicated manifest, each instance in exactly one chunk, the same acceptance per chunk, shared tooling owned by one chunk. The mechanistic rungs are the right cut here because the instances are interchangeable.
7. **Shared groundwork.** Name it per cut and give each item one owner: the earliest piece that exercises it, or its own piece only when it exposes a stable interface with its own proof and a named consumer.
8. **Dependencies and delivery order.** Partition by deliverable first, derive order second. A dependent child must still be acceptable on its own once its prerequisite exists; keep the critical path short. The ordering ladder: hard dependency, source of truth, risk, size; "smallest useful slice first" is a heuristic that usually lands on the risk rung by accident and must not be applied over a dependency.
9. **Hand-offs and spikes.** `indivisible` versus `too-uncertain`, with the Rumsfeld distinction; a technical unknown is a `spike` piece whose acceptance is the questions answered; a partial cut lists the deferred criteria and the spike answer each waits on, so the spike plus the deferred list still accounts for the whole parent.
10. **Revisits.** Every child close re-checks the trunk; the ledger classifies every criterion; `exhausted` requires every criterion completed and no open dependency; a better cut found later is a re-carve, and children with work started survive it as references.
11. **Non-code pieces.** Design, docs, migrations, operations are valid when each names a deliverable and its evidence; an unresolved preference is a hand-off, not a design piece.
12. **Other people's seams**, mapped onto the ladder: Lawrence's nine patterns and his two selection rules (severability, then equal size); Cohn's SPIDR (paths and rules are domain seams, interface a tier seam, spike the technical unknown); Cockburn's Elephant Carpaccio (why domain outranks tier); Parnas (a boundary that hides one decision is the admissibility test for the low rungs and the independence score); the WBS 100% rule (the ledger) and 8/80 (floor and ceiling in hours); Google's small-CL guidance (stacked, per-file, horizontal, vertical, and the stable-stub condition for horizontal); Adzic's hamburger method (technical steps when no vertical cut exists); Asthana et al. 2026 (validation gates between sub-tasks, and retrying only the failed phase, which is the journal).

## Verification checklist

- [ ] `bunx tsc --noEmit -p .` and `bun test` pass at every commit.
- [ ] Appraise and burndown dry runs from the adopting repository are unchanged after Commits 1 and 2.
- [ ] One real standalone carve produced attached children in delivery order, edges recorded, no size labels on children, a generation-1 record and `loop/carved` on the trunk, and a referenced existing issue where one matched.
- [ ] One forced dispute ran the rounds to the cap, left the trunk `needs-human` with the exchange, and created nothing.
- [ ] A crash injected after the first child resumed the generation on the next run without a duplicate.
- [ ] One burndown run skipped the trunk, worked its first leaf by recorded order, posted the roll-up, and revisited `still-good` with the ledger updated.
- [ ] One sweep revisited a trunk whose leaves were closed by hand, confirmed `exhausted`, and the appraiser handled it in the same run.
- [ ] The shipped size callback fired for an issue sized over the ceiling; the rendered file carries the marker; an unmarked adopter file survived a ceiling change.
- [ ] Every relative link in the touched SKILL and reference files resolves; no em dashes in any touched file.
- [ ] Plan file deleted after the two-key handshake (Inspector Gadget Rule: no orphan plans).

## Answered questions

- **Executable or prompt for the shipped callback?** Executable: a program invocation is load-bearing and never depends on an agent following prose. The prompt form stays available for adopters.
- **Is confirmation optional?** No. No flag, no knob; same-engine seats refuse to start. The first draft carried the appraiser's `--no-confirm` by copying, not by decision.
- **Do children get sizes from the knife?** No. The carver proposes points so the confirmer can judge balance; the label comes from the appraiser on a later pass. One skill owns size.
- **What happens to the trunk?** Never closed by the knife. Handed back to the appraiser by a confirmed `exhausted`. The one close the knife makes is a superseded child with no work started, inside a confirmed re-cut.
- **What is `wide`?** Not a verdict. A cut whose instances are interchangeable, judged for partition integrity; its residue is the `shards` relation on the record.
- **How is order carried?** In the record, not in issue numbers, because referenced issues keep their numbers.
- **Why no outer timeout on the size callback?** The knife is bounded by construction (turn cap times round cap); an outer timer that is shorter kills valid work and one that is longer adds nothing.
- **Depth cap default?** 3. **Round cap default?** 5 carver-confirmer pairs, chosen by the author; expected to be reached rarely because both agents share the ladder.

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

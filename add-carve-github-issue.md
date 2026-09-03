# Add `carve-github-issue`: erode oversized issues into sub-issues

**Status:** Draft
**Scope:** cross-stack
**Date:** 2026-09-02
**Last reviewed:** 2026-09-03
**Context:** The appraiser runs a size callback after every `valid` verdict, but nothing answers it: an issue sized above the burndown's ceiling is labelled and then sits, because no skill turns a 13 into an 8 and a 5.

## Goal

The burndown works issues at or under a ceiling (`maxPoints`, default 5). Everything above it is sized and then ignored, so the hardest work in a backlog is exactly the work the loop never touches.

`carve-github-issue` takes one oversized issue and expresses it as GitHub sub-issues: it names the pieces along the highest seam the work has, matches each piece against the open backlog so nothing is authored twice, and creates only what a second engine has confirmed covers the parent. The parent stays open as the trunk; the burndown works its leaves; every leaf close re-checks the trunk; a trunk with nothing left goes back to the appraiser. A leaf still over the ceiling is carved again, so a 13 erodes into 3s over runs, and every path a ticket can take ends in a merge, a confirmed close, or a person.

Done looks like: `bun run <skill-dir>/carve.ts --issue N` carves or revisits one issue; the burndown invokes it over its ceiling, works leaves in recorded order and never a trunk, and revisits a trunk whenever a leaf closes.

## Domain context

- **Seam.** A line along which one issue can be cut into children that each stand alone. Seams are ranked (domain, tier, route, area, file, unit, material) and searched from the top. A cut on any rung is admissible only if every child has one bounded outcome, its own acceptance and proof, and leaves the base usable after it lands; the ladder is a search order, not a trump card. The methodology is `references/seams.md`.
- **Piece.** One unit of the parent's work. A piece becomes a child by authoring a new issue or by referencing one the backlog already has. Normalization (inventory the parent's acceptance criteria, name the pieces, match each against the backlog, author only what is missing) is a step of every carve.
- **Trunk and leaves.** The parent is the trunk: open, labelled `loop/carved`, never handed to a worker while a child is open. Leaves are landable increments the burndown works; an interior node is a trunk of its own. Trunk-first (a person doing the whole thing) closes many leaves at once; leaf-first (the loop) erodes the trunk. Nothing is lost either way, because the tracker holds the tree.
- **Carving record.** A comment with a fixed shape posted on the trunk after every carve and revisit, carrying the cut, the ledger of the parent's criteria, and the counts the sweep compares against. The newest is authoritative. Workers, revisits, and people read it; its shape is `references/the-record.md`.
- **Revisit.** The knife on a trunk whose latest record is live (not `released`), asked one question: is this carving still good? Triggered by every child close. It answers `still-good`, `amend`, `exhausted`, or a hand-off, and the second engine confirms the answer as it confirms a carve. Any other issue the knife sees, children or not, is in carve mode: existing children are referenced through normalization and closed ones complete their criteria in the ledger.

## Domain categories

- **Cut.** One candidate decomposition along one seam: pieces, their relation, delivery order, shared groundwork with owners, and a reason for every higher rung not taken. The carver proposes a cut on every seam that applies and chooses one; the alternatives stay in its answer.
- **Cover.** The confirmer's verdict that the union of the pieces is the parent: no criterion unowned (`gap`), nothing the parent did not ask for (`overreach`). A width cut, one job over interchangeable instances, is judged for partition integrity instead.
- **Relation** of one cut's children: `shards` (disjoint slices of one job; any order; parallel), `layers` (each builds on the one before; source of truth first), `mixed` (edges listed per child), `waiting` (everything unlisted depends on a named spike).
- **Generation.** One carve or amend of a trunk, numbered from 1 on its records. Journals and child markers carry it so successive generations never match each other's children.
- **Hand-offs.** `indivisible` (cannot be cut at this ceiling) and `small-enough` (the carver disputes the size) go to `needs-human`; `too-uncertain` (a product ruling nobody has made) goes to `needs-decision` with the question. A technical unknown is none of these: it becomes a `spike` piece, and the rest of the cut waits on it.

## The lifecycle

Only so many things can happen to a ticket. This section names all of them; the rest of the plan is the machinery that makes each transition hold. Persisted state lives on the tracker (labels, the sub-issue tree, the record); nothing in a run directory is load-bearing across runs except the journal that finishes an interrupted generation.

### States

| State | On the tracker | Who owns it |
|---|---|---|
| **Unsized** | open, no `size:` label | the appraiser |
| **Leaf** | open, sized at or under the ceiling, no open children | the burndown's fix pipeline |
| **Oversized** | open, sized over the ceiling, no children, no hold label | the knife, carve mode |
| **Trunk** | open, `loop/carved`, children | the knife, revisit mode; workers take its leaves |
| **Held** | `needs-human`, `needs-decision`, `loop/skip`, `loop/parked`, or `loop/dlq` | a person |
| **Closed** | closed, with `stateReason` `COMPLETED` or `NOT_PLANNED` | terminal |

### Transitions

| From | Event | To | Notes |
|---|---|---|---|
| Unsized | appraiser: `valid` at or under the ceiling | Leaf | |
| Unsized | appraiser: `valid` over the ceiling | Oversized | fires the size callback, which runs the knife |
| Unsized | appraiser: close confirmed / hand-off | Closed / Held | |
| Oversized | knife: `carve` confirmed | Trunk | generation 1; children created; record; label last |
| Oversized | knife: `small-enough`, `indivisible`, `nothing-left`, disputed past the round cap | Held (`needs-human`) | both opinions on the thread; `nothing-left` is the carver finding every criterion already completed or withdrawn while the appraiser sized it as work, which is a disagreement a person settles |
| Oversized | knife: `too-uncertain` | Held (`needs-decision`) | the question on the thread |
| Oversized | knife: `busy`, `failed`, validation reject, upstream refusal | Oversized | `loop/carves: N` incremented; retried by the sweep; at `maxCarveAttempts` (3) goes Held (`needs-human`) with the log tail |
| Oversized | depth cap, or an open pull request already claims it | Held (`needs-human`) / left alone | depth is `indivisible` by definition; a claimed issue is a person's |
| Leaf | fix pipeline: `merged`, `already-fixed`, `obsolete`, `answered` | Closed (`COMPLETED`) | the close hook fires a revisit of the parent when there is one |
| Leaf | fix pipeline: `needs-*`, parked, dlq | Held | the trunk waits; a leaf that a sibling depends on blocks that sibling |
| Leaf | fix pipeline: `out-of-band` re-sizes over the ceiling | Oversized | recursion; the depth guard bounds it |
| Leaf | a person closes it | Closed | `COMPLETED` completes its criteria; `NOT_PLANNED` orphans them, which the next revisit must re-own |
| Trunk | any child closes, reopens, or is added; or a blocker closes | Trunk | revisit: `still-good` (new record), or `amend` confirmed (new generation) |
| Trunk | revisit: `exhausted` confirmed | Unsized | a final record with state `released`; size label off; `loop/carved` off; the appraiser is run on it in the same pass. The released record is what stops the next knife visit from revisiting a finished carving: the appraiser may size the remainder over the ceiling again, and the knife then carves afresh with the closed children as completed references |
| Trunk | revisit: `indivisible` or `too-uncertain` | Held | the label and children stay; the remaining work cannot be cut, or needs a ruling |
| Trunk | revisit disputed past the cap, or `maxGenerations` (5) reached and the answer was `amend` | Held (`needs-human`) | the label and children stay; a person resolves |
| Trunk | knife `busy` or `failed` | Trunk | counts still differ from the record, so the sweep retries; `loop/carves: N` applies per generation |
| Trunk | a person closes it with children open | Closed | children continue as leaves; the hook sees a closed parent and does nothing |
| Trunk | a person removes `loop/carved` with children open | Trunk (unlabelled) | still excluded from workers by its open children; the next child close or the sweep's second pass revisits and re-labels it |
| Closed child of a released trunk | a person reopens it | the trunk has an open child again | excluded from workers; the sweep's second pass hands it to the knife, which is in carve mode (released record) and references the reopened child through normalization |
| Held | a person removes the hold label | whatever the labels say | `needs-decision` answered re-enters Oversized with the answer in the thread |
| Closed | a person reopens | whatever the labels say | a reopened child changes the trunk's counts and triggers a revisit |

### Terminal cases

Closed, and every Held state. Nothing else is terminal, and every non-terminal state has a retry path with a counter: `loop/carves: N` per generation for the knife, `loop/reviews: N` for the fix pipeline as today, `maxGenerations` per trunk, `maxDepth` per tree. The recursion is bounded twice over: an authored child is at most the ceiling, so it is strictly smaller than its parent on the scale, and the depth cap ends any tree the scale did not.

### Leaks this table closed while it was being written

- A referenced issue closed as `NOT_PLANNED` or superseded by its own trunk does not complete a criterion; the ledger marks it orphaned and the next revisit re-owns it.
- A criterion the thread has retracted (a spike's answer made it moot, or a person withdrew it) could never be completed, so a trunk could never exhaust. The ledger has `withdrawn`, citing the comment, and the confirmer checks the retraction exists; `withdrawn` counts as done for exhaustion.
- After `exhausted`, the appraiser may size the remainder over the ceiling again, and a knife that chose revisit mode from "children exist" would answer `exhausted` again, forever. Mode is chosen from the latest record's state, not from the tree: a `released` record means carve mode.
- Two closes of the same leaf (a stranded pull request resumed, a reopen and re-close) would post two roll-ups. The roll-up names the child and the pull request, and the hook skips one the thread already carries.
- A trunk whose label a person removed, with its children later closed by hand, was invisible to the label sweep. The sweep's second pass (sized over the ceiling, not held, no open children) catches it, and the knife decides carve versus revisit from the tree, not the label.
- A spike leaf had no way to finish: the fix pipeline's verdicts all end in a pull request or a hand-off. The worker gains `answered` for a spike: proof comment, close, no pull request.
- Two agents could re-carve a trunk on every child close forever. `maxGenerations` ends it.
- A knife that crashes on the same issue every run would cost a carver turn per run forever. `loop/carves: N` ends it.
- A reference inside the trunk's own tree, or one that closes a `blocked-by` cycle, is rejected at normalization.
- The appraiser run with `--include-sized` could close a trunk over its open children. `selectForAppraisal` skips `loop/carved` unless the issue is named.

## The carver's answer

`loop-carving.json`, written in the scratch directory. Programmatic validation owns everything mechanical and rejects the file whole on any miss; the confirmer owns meaning.

```json
{
  "issue": 1282,
  "mode": "carve",
  "verdict": "carve",
  "reason": "two entities end to end; the author side is the smaller leg",
  "criteria": [{ "id": "A1", "text": "…" }, { "id": "A2", "text": "…" }, { "id": "A3", "text": "…" }],
  "chosen": 0,
  "cuts": [
    {
      "seam": "domain",
      "higherRungs": [],
      "relation": "layers",
      "state": "complete",
      "deferred": [],
      "pieces": [
        { "kind": "author", "title": "…", "body": "…", "points": 5, "role": "work", "criteria": ["A1", "A2"], "dependsOn": [], "order": 1, "orderRung": "source-of-truth" },
        { "kind": "reference", "number": 1240, "points": null, "role": "work", "criteria": ["A3"], "dependsOn": [0], "order": 2, "orderRung": "dependency" }
      ],
      "groundwork": [{ "what": "authors table migration", "owner": 0 }],
      "width": null,
      "balance": "5 and an existing 3; uneven but each is one thing",
      "independence": "share the migration; the second depends on the first"
    },
    { "seam": "tier", "higherRungs": [{ "seam": "domain", "why": "…" }], "relation": "layers", "state": "complete", "deferred": [], "pieces": [], "groundwork": [], "width": null, "balance": "", "independence": "inadmissible: three layers of one entity are not separately provable" }
  ]
}
```

- `criteria` is the inventory of the parent's acceptance criteria, numbered, taken from the whole thread. Every criterion is owned by exactly one piece or listed in `deferred` with the spike it waits on. This is the 100% rule made checkable.
- `mode` is `carve` or `revisit`; the knife sets it from the latest record (live record: revisit; none or `released`: carve) and rejects an answer in the other mode. Carve verdicts: `carve`, `small-enough`, `indivisible`, `too-uncertain`, `nothing-left`. Revisit verdicts: `still-good`, `amend`, `exhausted`, `indivisible`, `too-uncertain`; `amend` carries `cuts` and `chosen` plus `supersedes: [{ old, replacements: [pieceIndex], reason }]`, every `old` a child in the latest record. Every answer carries the ledger: each criterion with a status of `open`, `completed`, `deferred`, `superseded`, `orphaned`, or `withdrawn` (with the comment that retracted it).
- `seam` is one of `domain`, `tier`, `route`, `area`, `file`, `unit`, `material`. For a cut below `domain`, `higherRungs` names every rung above it with a non-empty reason it did not apply or was inadmissible; a lower cut is invalid while a higher one is admissible. `relation` and `orderRung` (`dependency`, `source-of-truth`, `risk`, `size`) take the values named above. `role` is `work` or `spike`.
- A `carve` or `amend` requires 2 to `maxChildren` pieces (1 allowed when `state` is `partial` and the piece is a spike), every authored piece's `points` on the scale and at most the ceiling, `dependsOn` acyclic, `order` a permutation consistent with `dependsOn`, every authored body carrying the headings Scope, Acceptance, and Proof, every groundwork item owned by exactly one piece, and every referenced number an open issue outside the trunk's own tree.
- `width`, when present, is `{ instances: [...], perInstance: "…" }`; its pieces are chunks, its relation `shards`, and the confirmer judges the partition.
- `indivisible` and `too-uncertain` require `reason` to state, respectively, what makes the work one thing and what question a person must answer.

## The confirmer's answer

`loop-confirmation.json`: `{ "issue": N, "mode": "carve" | "revisit", "agree": boolean, "finding": "cover" | "gap" | "overreach" | "partition-broken" | "still-good" | "exhausted" | "not-exhausted", "seam": "agree" | "higher-available", "seamCase": "…", "reason": "…" }`.

The confirmer sees the parent's whole thread, every child's thread on a revisit (closed ones included), the chosen cut only, the criteria inventory, and the seam list. On a `carve` or `amend` it checks: every criterion in the inventory is real and none is missing from the thread; cover, or partition integrity for a width cut; mutual exclusivity; one owner per criterion; each piece has one outcome and proof available at its close; the base is usable after each piece lands in its stated order; dependencies are necessary and minimal; every groundwork item has one owner and no groundwork piece lacks a named consumer; a referenced issue really is the piece it stands in for; proposed sizes include tests and proof; a partial cut's deferred criteria are exactly the ones the spike's questions decide. On `still-good` it checks the ledger against the tree; on `exhausted` it checks that every criterion is completed by a child or reference closed as `COMPLETED`, or withdrawn by a comment it can find, and that no recorded dependency is open; on `nothing-left` it checks the same ledger claim against the thread. Only a confirmed `exhausted` begins release.

`agree` is true only for `cover` (or an intact partition, `still-good`, or `exhausted`) with `seam: agree`. A seam dispute is allowed only when the higher seam the confirmer sees is `domain` or `tier`; between mechanistic rungs any admissible covering cut ships and the alternative is noted in `seamCase`. A dispute of any kind goes back to the carver with the confirmer's case as feedback; `maxCarveRounds` (default 5) counts carver-confirmer pairs; past the cap the trunk goes Held with the whole exchange on the thread.

## Normalization

Before any piece is authored, the carver matches every piece against the open backlog (`gh issue list --search` with the piece's nouns, plus the trunk's existing children and blockers on a revisit). A match with no parent is attached with `gh issue edit <n> --parent <trunk>`; one that already has a parent stays where it is and the trunk gets `--add-blocked-by <n>`, since an issue has one parent. A match inside the trunk's own tree, or one that would close a `blocked-by` cycle, is rejected and the piece is authored instead. Immediately before apply, every referenced issue is re-read: one that closed restarts the carve from the carver; one whose parent changed is re-treated. A referenced issue that already carries a size keeps it.

## What lands on the tracker

| Verdict | Trunk | Children |
|---|---|---|
| `carve` or `amend`, confirmed | in order: authored children created in delivery order, references attached or depended on, `blocked-by` edges, superseded children with no work started closed with a pointer to their replacements, the record, then `loop/carved` | authored pieces via `gh issue create --parent`, body from the template, `spike` label on spikes, no size label |
| disputed past the round cap | `needs-human`; comment with the last cut and the confirmer's case; `on-carve-fail` | none |
| `small-enough`, `indivisible`, `nothing-left` | `needs-human`; comment | none |
| `too-uncertain` | `needs-decision`; comment with the question | none |
| `still-good`, confirmed | a new record with the ledger updated | none |
| `exhausted`, confirmed | a final record with state `released` linking every closed child; size label off; `loop/carved` off; the appraiser is run on it directly, whatever its age | none |

"Work started" on a child means any of: an open pull request referencing it, an assignee, a lane for it under the run directory, or a `loop/*` label. A superseded child with any of those is kept and referenced as a piece of the new cut instead of closed.

Live re-read before every write; comment before label; a trunk that gained a hold label, or an open pull request, since the carver started is left alone. Creation is journaled per generation: `runs/carve-<n>-gen<g>.json` holds the accepted cut and each child number as it lands, and every authored body carries `<!-- carve parent=<n> gen=<g> piece=<i> -->`. On any entry to an issue the knife first finishes what a crash left: a journal with unfinished steps, or children carrying a generation newer than the latest record, is completed from the journal (missing pieces, then edges, then record, then label); a trunk with `loop/carved` and no size label is a release that crashed between its two label writes, finished by removing the label and running the appraiser.

## The carving record

Rendered by `lib/record.ts` from the accepted cut and posted as one comment with a fixed heading and generation number. It carries: the seam and the reasons for every higher rung; the state (`complete`, `partial` with the deferred criteria and the spike each waits on, or `released` on the record that ends a carving); the ledger (every criterion of the parent with its owner and status: `open`, `completed`, `deferred`, `superseded`, `orphaned`, `withdrawn`); the children as a table (number, piece, authored or referenced, attached or blocker, proposed size, delivery order and the rung that decided it, dependencies); the relation; shared groundwork with owners; and the counts the sweep compares against (`children total`, `children completed`, `blockers open`). The child body's first line points at the trunk and says to read the record.

## Ordering

Two ladders, both domain-first with the mechanistic rung last, both search orders that fall through when a rung does not discriminate.

Seams: domain, tier, route, area, file, unit, material. The larger the issue, the more the cut must be conceptual; the smaller, the more freedom to cut mechanistically, because at small sizes that may be the only axiom left. Severability outranks symmetry; symmetry is a tie-breaker.

Delivery order within one cut: hard dependency; closeness to the source of truth (definitions, schema, types, tables, API objects; then persistence; then the view); uncertainty and risk; size. The confirmed `order` in the newest record is canonical; issue numbers never encode order, because referenced issues keep theirs. The burndown reads the order from the record for candidates that have a parent (one `gh issue view` per trunk, cached per run) and works a trunk's leaves in it; the rest of the backlog stays newest-first.

## Guards

- **Depth.** `depthOf` walks `parent` upward, one `gh issue view --json parent` per level, stopping at `maxDepth` (default 3); at the cap the issue is `indivisible` with the depth stated. GitHub's limit is eight.
- **Fan-out.** `maxChildren` (default 8) per cut, and the trunk's `subIssuesSummary.total` plus authored pieces must stay at or under 100.
- **Floor.** No child under 1 point, none over the ceiling, none without its own acceptance and proof. A file, unit, or material cut is admissible only when the physical boundary also owns one change or one reviewable outcome.
- **Counters.** `loop/carves: N` on the issue, in the pattern of `loop/reviews: N`, incremented on every knife run that does not reach a confirmed verdict; cleared by a confirmed verdict; at `maxCarveAttempts` (3) the issue goes Held. `maxGenerations` (5) per trunk, read from the records; past it a revisit may answer `still-good` or `exhausted`, and `amend` goes Held.
- **Locks.** `carveIssue` claims `carve-<n>.lock`, so the CLI and the burndown's hook share it, and returns `busy` without waiting when another process holds it.
- **Time.** The knife bounds itself: every agent turn has the runtime's 45-minute cap and rounds are capped, so a carve terminates by construction. The size callback that invokes it runs with no outer timer by default (`sizeCallbackTimeoutMinutes: 0`); the burndown's shutdown kills its process group.

## Revisit triggers

- **Inside the loop.** `fixIssue` fires `onClosed(issue, { kind, pr?, sha?, reason })` after the child is closed, for `merged`, `already-fixed`, `obsolete`, and `answered`; a hook failure is logged and does not change the `FixOutcome`. The burndown's hook posts the roll-up on the trunk (which child, the pull request and merge sha when there is one, the worker's stated reason, a link to the child's thread), skipping one the thread already carries for that child and pull request, and calls `carveIssue`; after a confirmed `exhausted` it calls `appraiseIssue` on the trunk directly. A closed parent is logged and left alone.
- **Outside the loop.** The start-of-run sweep, after stranded-pull-request resume and under the loop lock, in two passes, logged and skipped in a dry run. First, `gh issue list --label loop/carved --limit 1000`: any trunk whose live `subIssuesSummary`, open-blocker count, or child set differs from its latest record is handed to the knife; unfinished generations and half-done releases are finished first. Second, over the open listing: every issue that is either sized over the ceiling or has children, and is not labelled `loop/carved`, not held, and not claimed by an open pull request, is handed to the knife, which sets its mode from the record. The second pass is the repair path for a lost callback, a trunk that lost its label, and a released trunk with a reopened child.
- **What the knife does not see.** A second burndown on another machine shares the tracker but not the run directory, so "work started" cannot see its lanes; a superseded child being worked there is protected only by its pull request or `loop/*` label once those exist. Two machines on one tracker is outside this plan.

## Current surface area

| Where | What | Change |
|---|---|---|
| `skills/appraise-github-issues/lib/appraise.ts` :59-76, :137-147 | `AppraiseKnobs`, `selectForAppraisal` | `sizeCallbackTimeoutMinutes` (0 = bounded by the callee); skip `loop/carved` unless named |
| `skills/appraise-github-issues/appraise.ts` :215 | standalone caller | passes the timeout |
| `skills/appraise-github-issues/lib/callbacks.ts` | `SizePayload`, `runSizeCallback` | payload gains `repoRoot`; timeout passed through |
| `skills/appraise-github-issues/references/callbacks.md` | ladder, forms, payload | field and timeout |
| `skills/fix-github-issue/lib/callbacks.ts` :22, :53-61 | `runCallback` | `timeoutMs` option (0 = none); process-group kill; registered in `children` |
| `skills/fix-github-issue/lib/agent.ts` :220 | `clearsByRole` | `carver` entry |
| `skills/fix-github-issue/lib/control-files.ts` | control-file names | `CARVING_FILE` |
| `skills/fix-github-issue/lib/labels.ts` :21, :39-70 | `ensureLabels`, review counter | `loop/carved`, `spike`; `carveCount` and `recordCarve` in the counter's pattern |
| `skills/fix-github-issue/lib/pipeline.ts` :27, :36-42, :67, :106, :503-536, :708 | `FixOutcome`, `Verdict`, `Issue`, close paths, `fixIssue` | tree fields; `answered` verdict; `onClosed` hook |
| `skills/fix-github-issue/prompts/triage-and-fix.md` | worker prompt | read the parent's record; `answered` for a spike |
| `skills/burn-down-github-issues/loop.ts` :485, :554, :624, :775-808 | `allIssues`, `selectCandidates`, `placeSizeCallbacks`, `main` | tree fields; trunk and blocker rules; leaf order from the record; rendered callback with marker; sweep; hook wiring |
| `skills/burn-down-github-issues/status.ts` :11 | `Stage` union and emoji map | `carved`, `revisited`, `released` |
| `skills/burn-down-github-issues/callbacks/README.md` | empty slot directory | the shipped callback |
| `skills/burn-down-github-issues/references/{architecture,adopting,operating}.md`, `SKILL.md` | | carving stage, revisit, selection rules, labels, the `carve` config block |
| `README.md` | skill table | row for `carve-github-issue` |

Forge facts (verified 2026-09-02 against `gh` 2.97.0): `gh issue create --parent N` creates a child already attached; `gh issue edit N --parent P` attaches an existing issue; `gh issue edit N --add-blocked-by M` records a dependency; `gh issue list --json` exposes `parent`, `subIssues`, `subIssuesSummary {total, completed}`, `blockedBy {nodes: [{number, state}]}`, `blocking`, and `stateReason`; `--limit 1000` is accepted. GitHub allows 100 sub-issues per parent and eight levels of nesting; each issue has one parent.

## File structure: before

**Legend:** ✏️ rewritten

```
simiancraft-skills/
├── ✏️ README.md
└── skills/
    ├── appraise-github-issues/
    │   ├── ✏️ appraise.ts                       // passes the callback timeout
    │   ├── lib/
    │   │   ├── ✏️ appraise.ts                   // timeout knob; selection skips loop/carved
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
        │   ├── ✏️ labels.ts                     // loop/carved, spike, carve counter
        │   └── ✏️ pipeline.ts                   // tree fields; answered; onClosed hook
        └── prompts/
            └── ✏️ triage-and-fix.md             // read the parent's record; spikes
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
    │   │   ├── 🆕 carve.test.ts                 // validators, record round-trip, ledger, resume, under bun test
    │   │   ├── 🆕 tree.ts                       // depth, children, blockers, latest record, generation, from gh json
    │   │   ├── 🆕 record.ts                     // render and parse the record; render a child body; the ledger
    │   │   └── 🆕 callbacks.ts                  // on-carve-pass / on-carve-fail on the shared slot mechanism
    │   ├── 🆕 prompts/
    │   │   ├── 🆕 carve.md                      // the carver turn: criteria, normalization, seams, cuts, choice
    │   │   ├── 🆕 revisit.md                    // the carver turn on a trunk that has children
    │   │   └── 🆕 confirm-carve.md              // the confirmer turn: cover or partition, the checklist, seam dispute, revisit answers
    │   └── 🆕 references/
    │       ├── 🆕 seams.md                      // the ladder, the axioms, the floor, width, normalization, ordering, literature
    │       ├── 🆕 lifecycle.md                  // the states and transitions table, as a skill doc
    │       ├── 🆕 adopting.md                   // config, labels, what lands on the tracker, guards, boundaries
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

## Commits

Every gate is the full pair, `bunx tsc --noEmit -p .` and `bun test`, plus what the commit names. Real runs are against the adopting repository's tracker on an expendable oversized issue chosen at run time and named in the run log. Every commit leaves the burndown runnable, and no commit lets a trunk reach a worker.

### Commit 1: widen the shared pieces the knife needs

**Goal:** Everything in `fix-github-issue` and `appraise-github-issues` the new skill reads, before the skill exists.

**Files rewritten:**
- `skills/fix-github-issue/lib/callbacks.ts`: `runCallback(dir, name, payload, log, options?: { timeoutMs?: number })`; default stays 60 s; `0` means no timer; the process starts in its own group (`setsid` when present, as `agent.ts` does), is added to `children`, and is killed by group on timeout or shutdown.
- `skills/fix-github-issue/lib/control-files.ts`: `CARVING_FILE = 'loop-carving.json'`.
- `skills/fix-github-issue/lib/agent.ts`: `clearsByRole.carver = [CARVING_FILE, LAST_MESSAGE_FILE]`.
- `skills/fix-github-issue/lib/labels.ts`: `ensureLabels` adds `loop/carved` ("Carved into sub-issues; worked by closing them") and `spike` ("Answer a question with evidence; no pull request"); `carveCount(labels)` and `recordCarve(ctx, issue)` on `loop/carves: N`, in the review counter's pattern; `clearCarves(ctx, issue)`.
- `skills/fix-github-issue/lib/pipeline.ts`: `Issue` gains optional `parent: { number } | null`, `subIssuesSummary: { total, completed }`, `blockedBy: { nodes: Array<{ number, state }> }`; `Verdict` gains `answered` (valid only for an issue labelled `spike`, rejected as `failed` otherwise: the worker's proof comment is posted and the issue closed, no pull request); `fixIssue` gains `options.onClosed` fired as described under Revisit triggers.
- `skills/fix-github-issue/prompts/triage-and-fix.md`: when the issue has a parent, read the parent's thread and its latest carving record before starting; the record says whether this leaf is a shard or a layer and what it may assume has landed. When the issue carries `spike`, run the experiments its body names, post the answers with evidence, and return `answered`.
- `skills/appraise-github-issues/lib/appraise.ts`: `AppraiseKnobs.sizeCallbackTimeoutMinutes` (default 0), threaded through `appraiseIssue` options to `runSizeCallback`; `selectForAppraisal` skips `loop/carved` (a named `--issue` still bypasses it).
- `skills/appraise-github-issues/appraise.ts`: passes the timeout.
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
- `skills/carve-github-issue/lib/tree.ts`: `readTree(ctx, number)` (one `gh issue view --json` with `parent,subIssues,subIssuesSummary,blockedBy,labels,body,comments,state,stateReason`), `depthOf`, `openChildren`, `openBlockers`, `latestRecord`, `nextGeneration`, `insideTree`.
- `skills/carve-github-issue/lib/record.ts`: `renderRecord(cut, children, ledger, counts)`, `parseRecord(comment)`, `renderChildBody(trunk, generation, piece, index)`, `buildLedger(record, tree)` (a child or reference closed `COMPLETED` completes its criteria; closed `NOT_PLANNED` orphans them; `withdrawn` survives only with its citing comment).
- `skills/carve-github-issue/lib/carve.ts`: `CarveKnobs { ceiling, maxDepth, maxChildren, maxCarveRounds, maxCarveAttempts, maxGenerations, callbacksDir, seats: { carver, confirmer } }`, `CARVE_DEFAULTS`, `assertDistinctEngines` (an error), `validateCarving`, `validateConfirmation`, `normalize`, `createPieces` (journaled per generation, delivery order, resumable by marker), `finishGeneration`, `finishRelease`, `carveIssue(ctx, issue, knobs): Promise<CarveOutcome>`: lock, read tree, finish unfinished work, guards and counters, choose mode from the latest record, run carver, validate, re-read live, confirm with rounds, apply, record, callbacks, clear or record the counter, unlock. `CarveOutcome` is the verdict plus `busy`, `resumed`, `left-alone`, and `failed`, each with a reason.
- `skills/carve-github-issue/lib/carve.test.ts`: `validateCarving` (every enum, bounds, cycles, order consistency, headings, criterion ownership, `higherRungs` non-empty below domain, supersedes against a record, references outside the tree), `validateConfirmation` per mode, `depthOf` and fan-out against fixtures, `parseRecord` round-trips `renderRecord`, `buildLedger` on fixture trees (open, completed, deferred, superseded, orphaned, blocker closed), resume matches markers by generation, the sweep's count comparison, the counters' thresholds.
- `skills/carve-github-issue/lib/callbacks.ts`: `runCarveCallback(dir, 'on-carve-pass' | 'on-carve-fail', payload, log)`; payload `{ issue, title, mode, verdict, generation, seam, relation, children: number[], superseded: number[], reason, repo, baseBranch, repoRoot }`.
- `skills/carve-github-issue/prompts/carve.md`: read-only turn against the main checkout with `appraise.md`'s access rules; reads the whole thread; inventories the criteria; normalizes; loads `references/seams.md` by path; proposes a cut on every seam that applies with reasons for every higher rung; scores; chooses; writes the answer file even when it cannot finish.
- `skills/carve-github-issue/prompts/revisit.md`: the same on a trunk with children: reads every child's thread including closed ones and the latest record; rebuilds the ledger; answers `still-good`, `amend`, or `exhausted`.
- `skills/carve-github-issue/prompts/confirm-carve.md`: the checklist above per mode; the seam rule; rendered with the round number and, after the first round, the carver's reply.
- `skills/carve-github-issue/references/seams.md`: see "The seams reference".
- `skills/carve-github-issue/references/lifecycle.md`: the states, transitions, terminal cases, and counters from this plan's lifecycle section, kept as the skill's durable contract.
- `skills/carve-github-issue/references/the-record.md`: the record's shape, the ledger, its readers.

**Gate:** the pair; a dry-run call renders the carver prompt to the run directory, stops there (a dry run has no carver answer to confirm), and mutates nothing.

### Commit 4: add the `carve.ts` command

**Goal:** The skill runs standalone.

**Files created:**
- `skills/carve-github-issue/carve.ts`: `--issue N` (required), `--dry-run`, `--ceiling N`, `--carver`, `--confirmer`, `--callbacks <dir>`; reads `carve-github-issue.config.ts`, else `burn-down-github-issues.config.ts` (ceiling from `maxPoints`, seats from `seats`, limits from an optional `carve` block); refuses same-engine seats; tees `runs/carve.log`; the same signal handling as `appraise.ts`; prints the outcome; exits non-zero on `failed`, 3 on `busy`.
- `skills/carve-github-issue/SKILL.md`: what it does, trunk and leaves, normalization, the record, the lifecycle in brief, run lines, dependencies, the ceiling paragraph (tracker as untrusted instruction channel; confirmer independence is model-level).
- `skills/carve-github-issue/references/adopting.md`: the `carve` config block (`maxDepth: 3, maxChildren: 8, maxCarveRounds: 5, maxCarveAttempts: 3, maxGenerations: 5`), `seats.carver`, the labels, what lands on the tracker, the guards, boundaries.
- `skills/carve-github-issue/references/callbacks.md`: the two slots, both forms, the payload.

**Gate:** the pair; `carve.ts --issue <n> --dry-run` from the adopting repository writes only the log. Then one real carve of the expendable oversized issue: children attached in delivery order, edges recorded, no child carries a size label, the trunk carries a generation-1 record and `loop/carved`, `on-carve-pass` ran (a scratch executable that writes a line proves it). Then one forced dispute (`--confirmer` pointed at a seat whose prompt answers `gap`): rounds logged to the cap, the trunk `needs-human`, nothing created, `on-carve-fail` ran. Then a crash injected after the first child of a fresh carve: the next run resumes the generation without a duplicate.

### Commit 5: revisit on close, inside and outside the loop

**Goal:** Every leaf close re-checks its trunk.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: supplies `onClosed` (roll-up, then `carveIssue` in revisit mode; after a confirmed `exhausted`, `appraiseIssue` directly on the trunk); the two-pass start-of-run sweep as described under Revisit triggers; the board marks `revisited` and `released`.
- `skills/burn-down-github-issues/references/architecture.md`: the revisit stage and the sweep.

**Gate:** the pair; a burndown run with `--limit 1` works the first leaf by recorded order, posts the roll-up, and the revisit answers `still-good` with a generation-1 record whose ledger shows one criterion completed. Then close the remaining leaves by hand and run again: the sweep revisits, `exhausted` is confirmed, the labels come off in order, and the appraiser handles the trunk in the same run. Then remove `loop/carved` from a fresh trunk by hand, close its leaves, and run again: the second pass finds it and the revisit re-labels or exhausts it. Then reopen one closed leaf of a released trunk and run again: the second pass hands it to the knife in carve mode, and the reopened leaf is referenced, not re-authored.

### Commit 6: ship the size callback that invokes the knife

**Goal:** An issue sized over the ceiling is carved without the appraiser knowing the knife exists.

**Files created:**
- `skills/burn-down-github-issues/callbacks/on-size-over-ceiling`: a shell script template with a first-line ownership marker (`# rendered by burn-down-github-issues; edits are overwritten`); reads the payload from stdin, runs `bun run {{CARVE_DIR}}/carve.ts --issue <n>` from `{{REPO_ROOT}}`, exits with its code. Executable form on purpose: invoking a program is load-bearing and never depends on an agent following prose.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: `placeSizeCallbacks` renders the template to `<callbacksDir>/on-size-over-<maxPoints>` with the two paths substituted and the executable bit set, removes any other `on-size-over-*` file that carries the marker (an unmarked adopter file is left alone), and does none of this in a dry run.
- `skills/burn-down-github-issues/callbacks/README.md`: the shipped callback, the rendering, the marker.
- `skills/burn-down-github-issues/SKILL.md`, `references/adopting.md`, `references/operating.md`, `README.md`: the carving stage, the `carve` config block and `seats.carver`, the labels, the skill row.

**Gate:** the pair; a burndown run that appraises a fresh issue sized over the ceiling shows the callback firing and the carve log under `runs/`; a ceiling change re-renders and leaves an unmarked file alone; link check over every touched `.md`; no em dashes in the diff. The adopting repository's config gains its `carve` block and `seats.carver` outside this repository before this gate runs; that file is the adopter's and is not part of this plan's tree.

### Commit 7: delete this plan

- Delete `add-carve-github-issue.md`, after the two-key handshake: every commit shipped, the checklist green, the developer's explicit confirmation.
- The methodology (`references/seams.md`), the lifecycle (`references/lifecycle.md`), and the record's shape (`references/the-record.md`) are skill docs and stay.

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
10. **Revisits.** Every child close re-checks the trunk; the ledger classifies every criterion; `exhausted` requires every criterion completed and no open dependency; a better cut found later is a re-carve, and children with work started survive it as references; generations are capped.
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
- [ ] One trunk stripped of its label by hand was found by the second pass and re-labelled or exhausted.
- [ ] One spike leaf ended in `answered` with its proof on the thread and no pull request.
- [ ] One released trunk sized over the ceiling again was carved afresh, not revisited, with its closed children as completed references.
- [ ] The shipped size callback fired for an issue sized over the ceiling; the rendered file carries the marker; an unmarked adopter file survived a ceiling change.
- [ ] Every transition in the lifecycle table is exercised by a test or a gate above, and none ends in a state without an owner.
- [ ] Every relative link in the touched SKILL and reference files resolves; no em dashes in any touched file.
- [ ] Plan file deleted after the two-key handshake (Inspector Gadget Rule: no orphan plans).

## References

- `skills/appraise-github-issues/lib/appraise.ts`, the shape `carveIssue` follows.
- `skills/appraise-github-issues/references/callbacks.md`, the slot the knife answers.
- `skills/fix-github-issue/lib/labels.ts`, the counter pattern `loop/carves: N` copies.
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

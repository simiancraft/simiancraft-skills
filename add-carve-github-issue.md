# Add `carve-github-issue`: erode oversized issues into sub-issues

**Status:** Draft
**Scope:** cross-stack
**Date:** 2026-09-02
**Last reviewed:** 2026-09-03
**Context:** The appraiser runs a size callback after every `valid` verdict, but nothing answers it: an issue sized above the burndown's ceiling is labelled and then sits, because no skill turns a 13 into an 8 and a 5.

## Goal

The burndown works issues at or under a ceiling (`maxPoints`, default 5) and never touches anything above it, so the hardest work in a backlog is exactly what the loop skips. `carve-github-issue`, the knife, takes one oversized issue and expresses it as GitHub sub-issues: it names the pieces along the highest seam the work has, matches each against the open backlog so nothing is authored twice, and creates only what a second engine has confirmed covers the parent. The parent stays open as the trunk; the burndown works its leaves; every leaf close is followed by a revisit; a trunk with nothing left goes back to the appraiser. A leaf still over the ceiling is carved again, so a 13 erodes into 3s. Done looks like: `carve.ts --issue N` carves or revisits one issue, the burndown invokes it over its ceiling and never works a trunk, and every path a ticket can take ends in a merge, a confirmed close, or a person.

## Domain context

- **Seam.** A line along which one issue can be cut into children that each stand alone. Seams are ranked (domain, tier, route, area, file, unit, material) and searched from the top. A cut on any rung is admissible only if every child has one bounded outcome, its own acceptance and proof, and leaves the base usable after it lands; the ladder is a search order, not a trump card. The methodology is `references/seams.md`.
- **Piece.** One unit of the parent's work. A piece becomes a child by authoring a new issue, by adopting an issue already in the trunk's tree, or by referencing one from elsewhere in the backlog. Normalization (inventory the parent's acceptance criteria, name the pieces, match each against the backlog, author only what is missing) is a step of every carve.
- **Trunk and leaves.** The parent is the trunk: open, labelled `loop/carved`, never handed to a worker while a child is open. Leaves are landable increments the burndown works; an interior node is a trunk of its own. Trunk-first (a person doing the whole thing) closes many leaves at once; leaf-first (the loop) erodes the trunk. Nothing is lost either way, because the tracker holds the tree.
- **Carving record.** A comment with a fixed shape posted on the trunk after every carve and revisit, carrying the cut, the ledger (every acceptance criterion of the parent with its owner and status), and what the tracker looked like when it was written. The newest is authoritative; its shape is `references/the-record.md`. Workers, revisits, and people read it.
- **Revisit.** The knife on a trunk whose latest record is live, asked one question: is this carving still good? It answers `still-good`, `amend`, `exhausted`, or a hand-off, and the second engine confirms the answer as it confirms a carve. The knife's mode (carve or revisit) is chosen from the latest record alone: a live record means revisit; none, or a `released` one, means carve.

## Domain categories

- **Cut.** One candidate decomposition along one seam: pieces, their relation, delivery order, shared groundwork with owners, and a reason for every higher rung not taken. The carver proposes a cut on every seam that applies and chooses one; the alternatives stay in its answer.
- **Cover.** The confirmer's verdict that the union of the pieces is the parent: no criterion unowned (`gap`), nothing the parent did not ask for (`overreach`). A width cut, one job over interchangeable instances, is judged for partition integrity instead.
- **Relation** of one cut's children: `shards` (disjoint slices of one job; any order; parallel), `layers` (each builds on the one before; source of truth first), `mixed` (edges listed per child), `waiting` (everything unlisted depends on a named spike). An edge is a `blocked-by` link on the tracker.
- **Generation.** One carve or amend of a trunk, numbered from 1. The number is carried on a `loop/carve-gen: N` label (the durable high-water mark), in the record, in the journal, and in every authored child's marker, so successive generations never match each other's children.
- **Journal.** `runs/carve-<n>-gen<g>.json`, the only run-directory state that matters across runs: the accepted cut and each write as it lands, so an interrupted generation is finished rather than redone.
- **Sweep.** The burndown's start-of-run pass that hands the knife every issue the tracker says needs it, so closes and edits made outside the loop are seen on the next run.
- **Roll-up.** The comment the loop posts on a trunk when one of its leaves closes: which leaf, how, and where the proof is.
- **Hand-offs.** `indivisible` (cannot be cut at this ceiling), `small-enough` (the carver disputes the size), and `nothing-left` (the carver finds every criterion done while the appraiser sized it as work) go to `needs-human`; `too-uncertain` (a product ruling nobody has made) goes to `needs-decision` with the question. A technical unknown is none of these: it becomes a `spike` piece, and the rest of the cut waits on it.
- **Scale.** The adopter's point scale, the values the config's `pointScale` array lists (the Fibonacci rungs by default). Every size in this plan is on it.

## Current surface area

| Where | What | Change |
|---|---|---|
| `skills/fix-github-issue/lib/engines.ts` :17-38 | `ENGINES` | `fixture` engine for deterministic gates |
| `skills/fix-github-issue/lib/callbacks.ts` :22, :53-61 | `runCallback` | `timeoutMs` option (0 = none); process group; registered in `children` |
| `skills/fix-github-issue/lib/agent.ts` :220 | `clearsByRole` | `carver` entry |
| `skills/fix-github-issue/lib/control-files.ts` | control-file names | `CARVING_FILE` |
| `skills/fix-github-issue/lib/labels.ts` :16-75, :144 | `ensureLabels`, review counter, `closeIssue` | new labels; carve and appraisal counters; close hook |
| `skills/fix-github-issue/lib/context.ts` :24-51 | `Context` | `onClosed` |
| `skills/fix-github-issue/lib/config.ts` :70, :221 | `PipelineKnobs`, validator | `pointScale`; zero-allowed knobs |
| `skills/fix-github-issue/lib/pipeline.ts` :27, :36-42, :67, :106, :503-536, :708 | `FixOutcome`, `Verdict`, `Issue`, `settleTerminalVerdict`, `fixIssue` | tree fields; `answered`; confirmed closes; live gate |
| `skills/fix-github-issue/prompts/triage-and-fix.md` :147-166 | worker prompt and verdict schema | parent record; `answered` and `answer` |
| `skills/fix-github-issue/prompts/` | | `confirm-answer.md` |
| `skills/appraise-github-issues/lib/appraise.ts` :59-76, :137-147, :203, :243 | knobs, selection, `confirmClose`, `appraiseIssue` | timeout knob; skip carved; export `confirmClose`; attempt counter; refuse a live trunk by name |
| `skills/appraise-github-issues/appraise.ts` :215 | standalone caller | passes the timeout |
| `skills/appraise-github-issues/lib/callbacks.ts` | `SizePayload`, `runSizeCallback` | `repoRoot`; timeout passed through |
| `skills/appraise-github-issues/references/callbacks.md` | ladder, forms, payload | field and timeout |
| `skills/burn-down-github-issues/loop.ts` :485, :497-545, :554, :624, :775-808 | listing, reconciliation, selection, callbacks, `main` | tree fields; reconciliation guard; trunk, blocker, claim rules; leaf order; rendered callback; sweep; hook wiring |
| `skills/burn-down-github-issues/status.ts` :11 | `Stage` and emoji map | `carved`, `revisited`, `released` |
| `skills/burn-down-github-issues/callbacks/README.md` | empty slot directory | the shipped callback |
| `skills/burn-down-github-issues/SKILL.md`, `references/{architecture,adopting,operating}.md` | | carving stage, revisit, selection rules, labels, the `carve` config block |
| `README.md` | skill table | row for `carve-github-issue` |

Forge facts (verified 2026-09-02 against `gh` 2.97.0): `gh issue create --parent N` creates a child already attached; `gh issue edit N --parent P` attaches an existing issue; `gh issue edit N --add-blocked-by M` records a dependency; `gh issue list --json` exposes `parent`, `subIssues`, `subIssuesSummary {total, completed}`, `blockedBy {nodes: [{number, state}]}`, `blocking`, `stateReason`, `updatedAt`, and `comments`; `gh api --paginate` walks any listing past a page. GitHub allows 100 sub-issues per parent and eight levels of nesting; each issue has one parent.

## File structure: before

**Legend:** ✏️ rewritten · ❌ deleted

```
simiancraft-skills/
├── ❌ add-carve-github-issue.md               // this plan; deleted by its last commit
├── ✏️ README.md
└── skills/
    ├── appraise-github-issues/
    │   ├── ✏️ appraise.ts                       // passes the callback timeout
    │   ├── lib/
    │   │   ├── ✏️ appraise.ts                   // timeout knob; skip carved; attempt counter; export confirmClose
    │   │   └── ✏️ callbacks.ts                  // repoRoot in the payload; timeout passed through
    │   └── references/
    │       └── ✏️ callbacks.md
    ├── burn-down-github-issues/
    │   ├── ✏️ SKILL.md
    │   ├── ✏️ loop.ts                           // selection; reconciliation guard; leaf order; sweep; hook; callback rendering
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
        │   ├── ✏️ callbacks.ts                  // timeoutMs; process group; registered child
        │   ├── ✏️ config.ts                     // pointScale; zero-allowed knobs
        │   ├── ✏️ context.ts                    // onClosed
        │   ├── ✏️ control-files.ts              // CARVING_FILE
        │   ├── ✏️ engines.ts                    // fixture engine
        │   ├── ✏️ labels.ts                     // labels; counters; close hook
        │   └── ✏️ pipeline.ts                   // tree fields; answered; confirmed closes; live gate
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
    │   ├── 🆕 carve.ts                          // CLI: --issue N [--dry-run] [--ceiling N] [--carver] [--confirmer] [--callbacks dir] [--fail-after step]
    │   ├── 🆕 lib/
    │   │   ├── 🆕 carve.ts                      // carveIssue(ctx, issue, knobs): CarveOutcome; claim; validation; rounds; apply; journal
    │   │   ├── 🆕 carve.test.ts                 // validators, ledger transitions, record round-trip, resume, needsRevisit, counters; inline fixtures
    │   │   ├── 🆕 tree.ts                       // Tree, readTree, depthOf, latestRecord, needsRevisit, claims
    │   │   ├── 🆕 record.ts                     // Record, Ledger, renderRecord, parseRecord, renderChildBody, buildLedger
    │   │   └── 🆕 callbacks.ts                  // on-carve-pass / on-carve-fail on the shared slot mechanism
    │   ├── 🆕 prompts/
    │   │   ├── 🆕 carve.md                      // the carver turn: criteria, normalization, seams, cuts, choice
    │   │   ├── 🆕 revisit.md                    // the carver turn on a trunk with a live record
    │   │   └── 🆕 confirm-carve.md              // the confirmer turn: cover or partition, the checklist, seam dispute, revisit and hand-off answers
    │   └── 🆕 references/
    │       ├── 🆕 seams.md                      // the ladder, the axioms, the floor, width, normalization, ordering, literature
    │       ├── 🆕 lifecycle.md                  // the states, transitions, invariants, counters; the board's columns
    │       ├── 🆕 the-record.md                 // the record's grammar, the ledger and its transitions, who reads it
    │       ├── 🆕 adopting.md                   // config, labels, what lands on the tracker, guards, boundaries
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
        │   ├── ✏️ config.ts
        │   ├── ✏️ context.ts
        │   ├── ✏️ control-files.ts
        │   ├── ✏️ engines.ts
        │   ├── ✏️ labels.ts
        │   └── ✏️ pipeline.ts
        └── prompts/
            ├── 🆕 confirm-answer.md             // second engine on a spike's answered verdict
            └── ✏️ triage-and-fix.md
```

## The lifecycle

Only so many things can happen to a ticket. This section names all of them; the rest of the plan is the machinery that makes each transition hold. Every state is derived from the issue itself (its labels, its sub-issue tree, its latest record); nothing in a run directory decides a state, and the journal only finishes writes the tracker already shows as started. That property is deliberate: these states are the columns of the board this work will eventually be shown on, and a state a person cannot read off the issue is a defect.

One rule governs every cost trade-off below: churn spent re-reading an existing issue is cheaper than the churn a wrong carving multiplies into. Where the plan can spend an agent turn to be sure, it does.

### States

Derived in this precedence; every open or closed issue is in exactly one.

| Precedence | State | Derived from | Who owns it |
|---|---|---|---|
| 1 | **Closed** | `state: CLOSED`; `stateReason` `COMPLETED` or `NOT_PLANNED` | terminal |
| 2 | **Held** | any of `needs-human`, `needs-decision`, `loop/skip`, `loop/parked`, `loop/dlq` | a person |
| 3 | **Trunk** | a live record, or any open child | the knife (revisit); workers take its leaves |
| 4 | **Oversized** | sized over the ceiling | the knife (carve) |
| 5 | **Leaf** | sized at or under the ceiling | the fix pipeline |
| 6 | **Unsized** | no `size:` label | the appraiser |

`loop/carved` is the trunk's normal label and what excludes it from the worker's selection; a trunk that lost the label is still a trunk by this table and is re-labelled at its next revisit. `loop/carving` is a claim, not a state: it marks an issue the knife is working right now, on any machine.

### Transitions

| From | Event | To | Notes |
|---|---|---|---|
| Unsized | appraiser: `valid` at or under the ceiling | Leaf | |
| Unsized | appraiser: `valid` over the ceiling | Oversized | fires the size callback, which runs the knife |
| Unsized | appraiser: close confirmed / hand-off | Closed / Held | |
| Unsized | appraiser: crash, malformed answer, confirmer failure | Unsized | `loop/appraisals: N`; at `maxAppraiseAttempts` (3) goes Held (`needs-human`) with the log tail |
| Oversized | knife: `carve` confirmed | Trunk | generation 1; children created; record; `loop/carved` last |
| Oversized | knife: `small-enough`, `indivisible`, `nothing-left`, disputed past the round cap | Held (`needs-human`) | both opinions on the thread |
| Oversized | knife: `too-uncertain` | Held (`needs-decision`) | the question on the thread |
| Oversized | knife: `failed` (crash, invalid answer, upstream refusal) | Oversized | `loop/carves: N`; at `maxCarveAttempts` (3) goes Held (`needs-human`) with the log tail; `busy` and `left-alone` never count |
| Oversized | depth cap; claimed by an open pull request; claimed by another machine | Held (`needs-human`) / left alone / `busy` | depth is `indivisible` by definition; a pull request means a person or a worker has it |
| Leaf | fix pipeline: `merged`; `already-fixed`, `obsolete`, `answered` confirmed by the second engine | Closed (`COMPLETED`) | the close hook posts a roll-up and revisits the parent when there is one |
| Leaf | fix pipeline: a close the second engine disputed; `needs-*`; parked; dlq | Held | the trunk waits; a leaf that a sibling depends on blocks that sibling |
| Leaf | fix pipeline: `out-of-band` re-sizes over the ceiling | Oversized | recursion; the depth guard bounds it |
| Leaf | a person closes it | Closed | `COMPLETED` completes its criteria; `NOT_PLANNED` orphans them; a dependent sibling stays blocked until its blocker is `COMPLETED` |
| Trunk | a child closes, reopens, or is added; a blocker closes or is added; any comment or edit on the trunk | Trunk | revisit: `still-good` (new record), or `amend` confirmed (new generation) |
| Trunk | revisit: `exhausted` confirmed | Unsized | a `released` record; size label off; `loop/carved` off; counters off; the appraiser is run on it directly. The released record is what stops the next knife visit from revisiting a finished carving |
| Trunk | revisit: `indivisible` or `too-uncertain` confirmed | Held | the label and children stay |
| Trunk | revisit disputed past the round cap; `maxGenerations` (5) reached and the answer was `amend`; `maxRevisitsPerGeneration` (10) reached | Held (`needs-human`) | the label and children stay; a person resolves |
| Trunk | knife `failed` | Trunk | `loop/carves: N` as above; the sweep retries while the tracker still differs from the record |
| Trunk | a person closes it with children open | Closed | children continue as leaves; the hook sees a closed parent and does nothing |
| Trunk (released, closed children only) | appraiser sizes the remainder | Leaf or Oversized | closed children do not route; a small remainder is an ordinary leaf; an oversized one is carved afresh with the closed children adopted as completed pieces |
| Held | a person removes the hold label | whatever the table derives | `needs-decision` answered re-enters with the answer in the thread |
| Closed | a person reopens | whatever the table derives | a reopened child changes the tree and triggers a revisit; a reopened child of a released trunk makes the trunk a Trunk again, in carve mode |

### Terminal cases

Closed, and every Held state. Nothing else is terminal, and every non-terminal state has a retry path with a counter: `loop/appraisals: N` for the appraiser, `loop/carves: N` per generation for the knife, `loop/reviews: N` for the fix pipeline as today, `maxGenerations` and `maxRevisitsPerGeneration` per trunk, `maxDepth` per tree. Recursion is bounded twice: an authored child is at most the ceiling, so strictly smaller than its oversized parent on the scale, and the depth cap ends any tree the scale did not; a referenced piece keeps its own size and is carved on its own depth.

### Invariants

Each of these closes a path the tracing found, and each has a test or a gate below.

- A referenced or adopted issue closed `NOT_PLANNED`, deleted, or superseded elsewhere does not complete a criterion; the ledger marks it `orphaned`, `still-good` is invalid while any criterion is orphaned, and the revisit must re-own it.
- A criterion the thread has retracted is `withdrawn`, citing the comment; it counts as done for exhaustion; if the comment disappears the criterion is `open` again, and the sweep sees the edit.
- Mode is chosen from the latest record, never from the tree, so a released trunk is never revisited into a second `exhausted`.
- Closed children never route an issue to the knife; only open children or an oversized label do.
- A release that crashed after its record is finished by the record, not by counts: a `released` record with any of the size label, `loop/carved`, or the counter labels still present is completed before anything else.
- Merge reconciliation never closes a trunk: it skips `loop/carved` issues and issues with open children, and it requires a closing keyword before an issue number.
- A worker never starts on a trunk, a held issue, a closed issue, or a leaf whose blocker is not `COMPLETED`, however the selection snapshot looked: the live gate re-reads immediately before spawning.
- Every close of a leaf, wherever it comes from, is followed by a revisit of its parent: immediately when the loop made the close, on the next run's sweep otherwise.
- Two roll-ups for one close are impossible: the roll-up is keyed by child and event and the hook skips one the thread already carries.
- Two machines cannot both carve one trunk: the claim on the tracker wins ties by earliest claim comment.
- `busy` and `left-alone` never spend an attempt.

## Interfaces

The types every commit below refers to. They live where the tree says; the shapes are fixed here so no commit invents them.

```ts
// fix-github-issue/lib/context.ts
export type CloseEvent = { issue: number; kind: 'merged' | 'closed' | 'answered'; pr?: number; mergeSha?: string; reason: string };
Context.onClosed?: (event: CloseEvent) => Promise<void>;   // awaited by closeIssue; a throw is logged, never propagated

// fix-github-issue/lib/engines.ts
ENGINES.fixture: { command: (cwd, prompt, model) => ['bun', FIXTURE_RUNNER, cwd, model] }
// `fixture:<path>`: the runner copies <path> to the role's control file in cwd and exits 0; for tests and gates only

// fix-github-issue/lib/config.ts
PipelineKnobs.pointScale: number[];            // default [1, 2, 3, 5, 8, 13, 21, 34]
loadProjectConfig options.nonNegativeIntegers  // sibling of positiveIntegers; used for sizeCallbackTimeoutMinutes

// fix-github-issue/lib/pipeline.ts
Issue: { number; title; createdAt; updatedAt; labels; parent: { number } | null;
         subIssuesSummary: { total; completed }; blockedBy: { nodes: Array<{ number; state; stateReason }> } };
Verdict: adds 'answered'; WorkerResult.answer?: string  // Markdown; required with 'answered'
FixOutcome.outcome: adds 'left-alone'

// carve-github-issue/lib/tree.ts
export type Tree = { issue: Issue & { body: string; state; stateReason; comments: Comment[] };
  children: Array<Issue & { stateReason }>; blockers: Array<Issue & { stateReason }>; depth: number;
  record: Record | null; generation: number; claim: Claim | null };
export function readTree(ctx, number): Tree;                  // one gh issue view plus one gh issue view per ancestor for depth
export function needsRevisit(record: Record, tree: Tree, botLogin: string): string | null;  // the reason, or null
export type Claim = { runId: string; at: string; author: string };

// carve-github-issue/lib/record.ts
export type CriterionStatus = 'open' | 'completed' | 'deferred' | 'withdrawn' | 'orphaned';
export type ChildStatus = 'open' | 'closed-completed' | 'closed-not-planned' | 'superseded' | 'deleted';
export type Ledger = Array<{ id: string; text: string; owner: number | null; status: CriterionStatus; cite?: string }>;
export type Record = { generation: number; state: 'live' | 'released'; seam: Seam; higherRungs; relation; deferred;
  children: Array<{ number; piece; kind: 'author' | 'child' | 'reference'; link: 'sub-issue' | 'blocker';
                    points: number | null; order: number; orderRung; dependsOn: number[]; status: ChildStatus }>;
  ledger: Ledger; groundwork; revisits: number;
  seen: { children: number[]; blockers: number[]; updatedAt: string; comments: number } };
export function renderRecord(r: Record): string;   // begins with `<!-- carve-record gen=N state=live|released -->`, then a fenced JSON block, then the human table
export function parseRecord(comment: { body; author }, botLogin): Record | null;  // marker, author, and JSON must all check; else null and a log line
export function renderChildBody(trunk: number, generation: number, index: number, piece): string;  // first line links the trunk and the record; marker `<!-- carve parent=N gen=G piece=I -->`; headings Scope, Acceptance, Proof
export function buildLedger(previous: Ledger, record: Record, tree: Tree): Ledger;  // the transition table in the-record.md

// carve-github-issue/lib/carve.ts
export type CarveKnobs = { ceiling; maxDepth: 3; maxChildren: 8; maxCarveRounds: 5; maxCarveAttempts: 3;
  maxGenerations: 5; maxRevisitsPerGeneration: 10; callbacksDir: string /* default <worktreeRoot>/appraisal-callbacks, the same directory the size callbacks use */;
  seats: { carver: Seat; confirmer: Seat } };
export type Journal = { issue; generation; cut; steps: Array<{ name: 'claim' | 'create' | 'adopt' | 'reference' | 'edge' | 'supersede' | 'record' | 'label' | 'counters' | 'release-size' | 'release-label' | 'release-counters' | 'unclaim'; target?: number; done: boolean }> };
export type CarveOutcome = { outcome: Carving['verdict'] | 'busy' | 'resumed' | 'left-alone' | 'failed'; reason: string; generation?: number; children?: number[] };
export async function carveIssue(ctx: Context, issue: Issue, knobs: CarveKnobs): Promise<CarveOutcome>;
```

The record's grammar: the marker line, one fenced `json` block holding the `Record` object verbatim, then a Markdown table for people. `parseRecord` reads only the JSON; the table is derived. The newest comment by the authenticated account (`gh api user`) with a valid marker and JSON is the latest record; anything else on the thread is not a record.

## The carver's answer

`loop-carving.json`, written in the scratch directory. Programmatic validation owns everything mechanical and rejects the file whole on any miss; the confirmer owns meaning.

```json
{
  "issue": 1282,
  "mode": "carve",
  "verdict": "carve",
  "reason": "two entities end to end; the author side is the smaller leg",
  "criteria": [{ "id": "A1", "text": "…" }, { "id": "A2", "text": "…" }, { "id": "A3", "text": "…" }],
  "ledger": [{ "id": "A1", "owner": 0, "status": "open" }, { "id": "A2", "owner": 0, "status": "open" }, { "id": "A3", "owner": 1, "status": "open" }],
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

A revisit answer has the same envelope with `"mode": "revisit"`; `still-good` and `exhausted` carry `criteria` and `ledger` and no `cuts`; `amend` carries `cuts`, `chosen`, and `supersedes: [{ "old": 1301, "replacements": [0, 1], "reason": "…" }]`. A hand-off in either mode carries `verdict` and `reason` only, plus `ledger` when the carver got that far.

- `criteria` is the inventory of the parent's acceptance criteria, numbered, taken from the whole thread. In the ledger every criterion is owned by exactly one piece, or `deferred` with the spike it waits on, or `withdrawn` with the comment cited. This is the 100% rule made checkable.
- `mode` is set by the knife from the latest record, and an answer in the other mode is rejected. Carve verdicts: `carve`, `small-enough`, `indivisible`, `too-uncertain`, `nothing-left`. Revisit verdicts: `still-good`, `amend`, `exhausted`, `indivisible`, `too-uncertain`.
- `kind` is `author` (a new issue), `child` (an issue already in this trunk's tree, adopted as the piece: closed ones complete their criteria, open ones own them), or `reference` (an open issue outside the tree, attached if it has no parent, otherwise an edge). A `reference` inside the tree is rejected; that is what `child` is for.
- `seam` is one of `domain`, `tier`, `route`, `area`, `file`, `unit`, `material`. For a cut below `domain`, `higherRungs` names every rung above it with a non-empty reason it did not apply or was inadmissible; a lower cut is invalid while a higher one is admissible. `role` is `work` or `spike`.
- A `carve` or `amend` requires 2 to `maxChildren` pieces (1 allowed when `state` is `partial` and the piece is a spike), every authored piece's `points` on the scale and at most the ceiling, `dependsOn` acyclic, `order` a permutation consistent with `dependsOn`, every authored body carrying the headings Scope, Acceptance, and Proof, every groundwork item owned by exactly one piece, every `supersedes.old` a child of the latest record, and the trunk's `subIssuesSummary.total` plus authored pieces plus references that will be attached at or under 100.
- `width`, when present, is `{ "instances": ["…"], "perInstance": "…" }`; its pieces are chunks, its relation `shards`, and the confirmer judges the partition.
- `small-enough` is the carver disputing the size; `nothing-left` is the carver finding every criterion `completed` or `withdrawn` in carve mode. Both are disagreements with the appraiser and go to a person.

## The confirmer's answer

`loop-confirmation.json`: `{ "issue": N, "mode": "carve" | "revisit", "agree": boolean, "finding": F, "seam": "agree" | "higher-available", "seamCase": "…", "reason": "…" }` where `F` is one of `cover`, `gap`, `overreach`, `partition-broken`, `still-good`, `not-still-good`, `exhausted`, `not-exhausted`, `hand-off-agree`, `hand-off-disagree`.

The confirmer sees the parent's whole thread, every child's thread on a revisit (closed ones included), the chosen cut only, the criteria inventory and ledger, and the seam list. On a `carve` or `amend` it checks: every criterion in the inventory is real and none is missing from the thread; cover, or partition integrity for a width cut; mutual exclusivity; one owner per criterion; each piece has one outcome and proof available at its close; the base is usable after each piece lands in its stated order; dependencies are necessary and minimal; every groundwork item has one owner and no groundwork piece lacks a named consumer; an adopted or referenced issue really is the piece it stands in for; proposed sizes include tests and proof; a partial cut's deferred criteria are exactly the ones the spike's questions decide. On `still-good` it checks the ledger against the tree and rejects when any criterion is `orphaned`, or `deferred` while its spike is closed. On `exhausted` it checks that every criterion is `completed` by a child or reference closed `COMPLETED`, or `withdrawn` by a comment it can find, and that no recorded dependency is open. On a hand-off it checks the stated reason against the thread. Only a confirmed `exhausted` begins release.

`agree` is true only for `cover` (or intact partition), `still-good`, `exhausted`, or `hand-off-agree`, with `seam: agree`. A seam dispute is allowed only when the higher seam the confirmer sees is `domain` or `tier`; between mechanistic rungs any admissible covering cut ships and the alternative is noted in `seamCase`. A dispute of any kind goes back to the carver with the confirmer's case as feedback. `maxCarveRounds` (default 5) is the maximum number of carver-confirmer pairs; the fifth disagreement hands off, so at most five carver turns and five confirmer turns run. Past the cap the trunk goes Held with the whole exchange on the thread.

## Normalization

Before any piece is authored, the carver matches every piece against the trunk's own tree first (`child`) and then the open backlog (`gh issue list --search` with the piece's nouns; a match is one the carver would defend as the same ask, and the confirmer checks it). A `reference` with no parent is attached with `gh issue edit <n> --parent <trunk>`; one that already has a parent stays where it is and the trunk gets `--add-blocked-by <n>`. A match that would close a `blocked-by` cycle is rejected and the piece is authored instead. Immediately before apply, every adopted and referenced issue is re-read: one that closed since confirmation restarts the carve from the carver; one whose parent changed is re-treated. An adopted or referenced issue that already carries a size keeps it.

## What lands on the tracker

Every write below is a journal step, so an interrupted sequence is finished from the journal on the next entry to the trunk, in the same order, skipping steps the tracker already shows as done. Before every write the trunk is re-read: a hold label, an open pull request claiming it, a foreign live claim, or a child set that changed since confirmation aborts the sequence (`left-alone`, and the journal is marked abandoned), except that a generation whose first child already exists is always finished.

| Verdict | Trunk | Children |
|---|---|---|
| `carve` or `amend`, confirmed | claim; authored children created in delivery order; children adopted; references attached or depended on; edges; superseded children with no work started closed with a pointer to their replacements; the record; `loop/carve-gen: N`; `loop/carved`; counters cleared; unclaim | authored pieces via `gh issue create --parent`, body from the template, `spike` label on spikes, no size label |
| disputed past the round cap | `needs-human`; comment with the last cut and the confirmer's case; `on-carve-fail`; unclaim | none |
| `small-enough`, `indivisible`, `nothing-left`, confirmed | `needs-human`; comment; unclaim | none |
| `too-uncertain`, confirmed | `needs-decision`; comment with the question; unclaim | none |
| `still-good`, confirmed | a new record with the ledger and `revisits` updated; unclaim | none |
| `exhausted`, confirmed | a `released` record linking every closed child; size label off; `loop/carved` off; counter labels off; unclaim; then the appraiser is run on it directly with the burndown's appraisal options and no age window | none |

"Work started" on a child means any of: an open pull request referencing it, an assignee, a lane for it under this machine's run directory, or a `loop/*` label. A superseded child with any of those is kept and adopted as a piece of the new cut instead of closed. The worker's live gate closes the remaining window: a worker that finds its issue closed when it re-reads does not start.

Spike proof: the worker writes `answer` in its verdict file; the driver runs `confirm-answer.md` on the second engine (does the evidence answer the questions the spike's body asks); on agreement the driver posts the answer with a marker naming the issue and generation, then closes; on disagreement it parks the leaf as `needs-human` with both opinions. `already-fixed` and `obsolete` from a worker go through `confirmClose` the same way.

## The carving record

Rendered by `record.ts` and posted as one comment; the shape is in Interfaces and the grammar in `references/the-record.md`. Beyond the cut, it carries the ledger, the `revisits` count for this generation, and `seen`: the child set, blocker set, `updatedAt`, and comment count at the moment it was written, which is what `needsRevisit` compares against. The child body's first line points at the trunk and says to read the record; a worker with a parent reads it before starting, and learns whether its leaf is a shard that touches nothing or a layer that assumes the schema child landed.

The ledger's transitions, one row per event, are the contract in `references/the-record.md`: a child or reference closed `COMPLETED` completes its criteria; closed `NOT_PLANNED`, deleted, or superseded elsewhere orphans them; a completed child reopened reopens them; a superseded child reopened is an unexpected open child the revisit must adopt or hand off; a spike closed makes its deferred criteria `open` and unowned, which only an `amend` can settle; a withdrawn comment removed reopens the criterion. Supersession moves criteria to the replacement as `open`; `superseded` is a child status, not a criterion status.

## Ordering

Two ladders, both conceptual-first with the mechanistic rung last, both search orders that fall through when a rung does not discriminate.

Seams: domain, tier, route, area, file, unit, material. The larger the issue, the more the cut must be conceptual; the smaller, the more freedom to cut mechanistically, because at small sizes that may be the only axiom left. Severability outranks symmetry; symmetry is a tie-breaker.

Delivery order within one cut: hard dependency; closeness to the source of truth (definitions, schema, types, tables, API objects; then persistence; then the view); uncertainty and risk; size. The confirmed `order` in the newest record is canonical; issue numbers never encode order, because adopted and referenced issues keep theirs. The burndown reads the order from the record for candidates that have a parent (one `gh issue view` per trunk, cached per run) and sorts a trunk's leaves by it, contiguous, in the position the trunk's newest leaf would have had; the rest of the backlog stays newest-first. Order is a dispatch preference; only an edge is a hard constraint, and the carver emits an edge wherever a later piece cannot land before an earlier one.

## Guards

- **Depth.** The root is depth 0; an issue at depth d is carvable iff d < `maxDepth` (default 3), so `maxDepth: 3` allows carving at depths 0, 1, and 2 and leaves at depth 3. `depthOf` walks `parent` upward, one `gh issue view --json parent` per level. At the cap the issue is `indivisible` with the depth stated. GitHub's limit is eight.
- **Fan-out.** `maxChildren` (default 8) per cut, and the trunk's `subIssuesSummary.total` plus authored pieces plus references to be attached at or under 100.
- **Floor.** No child under the scale's smallest rung, none over the ceiling, none without its own acceptance and proof. A file, unit, or material cut is admissible only when the physical boundary also owns one change or one reviewable outcome.
- **Counters.** `loop/carves: N` and `loop/appraisals: N` in the pattern of `loop/reviews: N` (`recordCarve(ctx, issue, previous)`, `carveCount(labels)`, and the appraisal pair), incremented on a `failed` outcome only, cleared as a journal step of a confirmed verdict; `repairDurableState` learns both so a crash between add and remove cannot double-count. `loop/carve-gen: N` is the generation high-water mark; the knife trusts the larger of the label and the record. `maxGenerations` (5) per trunk; past it a revisit may answer `still-good` or `exhausted`, and `amend` goes Held. `maxRevisitsPerGeneration` (10), counted in the record; past it the trunk goes Held. This last cap is a known unknown: how often a healthy trunk is revisited is unmeasured, the record makes it measurable, and `references/operating.md` says to raise it or rethink the trigger if trunks reach it routinely.
- **Claims.** Before running the carver the knife adds `loop/carving` and posts a claim comment `<!-- carve-claim run=<id> at=<iso> -->`, then re-reads the thread; if an earlier claim comment by another run is live, it removes nothing and returns `busy`. A claim is stale when older than `AGENT_TIMEOUT_MS` times `2 * maxCarveRounds`; the sweep clears a stale claim with a comment. The claim is released as the last journal step of every outcome. The local `carve-<n>.lock` stays as the cheap first check on one machine.
- **Time.** The knife bounds itself: every agent turn has the runtime's 45-minute cap and rounds are capped, so a carve terminates by construction. The size callback that invokes it runs with no outer timer by default (`sizeCallbackTimeoutMinutes: 0`, validated as a non-negative integer); the burndown's shutdown kills its process group.

## Revisit triggers

- **Inside the loop.** `closeIssue` awaits `ctx.onClosed(event)` after the close, so every close path (the fix pipeline, stranded resume, reconciliation, the appraiser) fires it; a throw is logged and never changes an outcome. The burndown's hook: if the closed issue has a parent, post the roll-up on the trunk (marker `<!-- carve-rollup child=N event=merged|closed|answered pr=M -->`, the worker's reason, a link to the child's thread), skipping one the thread already carries; then `carveIssue` on the trunk; after a confirmed `exhausted`, `appraiseIssue` on the trunk with the burndown's appraisal options and `ageDays` ignored. A closed parent is logged and left alone.
- **Outside the loop.** The sweep runs after stranded-pull-request resume, under the loop lock, once per trunk per run, and in a dry run only logs. Two passes, both through `gh api --paginate`. First, every open issue labelled `loop/carved` or `loop/carving` that is not Held: finish any unfinished generation or release; clear a stale claim; then `needsRevisit(record, tree, botLogin)` decides (child set, blocker set, `updatedAt`, or comment count differ from `seen`, the loop's own roll-ups and records excluded from the count by author; no record at all counts as a difference). Second, every open issue that is not `loop/carved`, not Held, not claimed by an open pull request, and either sized over the ceiling or with an open child, is handed to the knife. The second pass is the repair path for a lost callback, a trunk that lost its label, and a released trunk with a reopened child.

## The seams reference

`references/seams.md` is the skill's methodology and is written for the carver. Its sections, in order:

1. **Why this ladder differs from the canon.** The story-splitting canon (Lawrence, Cohn, Cockburn) writes cards for people who slice below the card privately, so a card can stay a vertical story and horizontal cuts are called a smell. Here the card is the unit an agent works, so the slice that would have been private is written down. Horizontal cuts happen either way; the only question is whether the tracker records them.
2. **The ladder**, one paragraph per rung: what the seam is, when it applies, what a child cut on it looks like, and its admissibility condition. Domain first because a child cut there is provable on its own; tier keeps its rung because a client-side application with its own state has a real contract at the boundary with its backend, and the admissibility gate ("each tier child provable on its own") does the work a ban would; material last because it is blind to what the work means and is right only for width. A cut below domain must say, for every higher rung, why it did not apply.
3. **The axioms.** Seam order matters more as size grows, and the converse: the smaller the issue, the more freedom to cut mechanistically. Severability outranks symmetry; symmetry is a tie-breaker. The ladder is a search order, not a trump card.
4. **Normalization.** Inventory the criteria and the pieces first (an issue that is a list of unrelated asks becomes one piece per ask), adopt what the tree already has, reference what the backlog already has, author only what is missing, re-read before apply.
5. **Floor and ceiling.** Too large: still divisible or parallelizable. Too small: the issue costs more to write than to do; operationally, a child without its own acceptance and proof, or under the scale's smallest rung.
6. **Width.** Recognize it (one criterion, many instances); it is a partition, not a count: a stable, deduplicated manifest, each instance in exactly one chunk, the same acceptance per chunk, shared tooling owned by one chunk. The mechanistic rungs are the right cut here because the instances are interchangeable.
7. **Shared groundwork.** Name it per cut and give each item one owner: the earliest piece that exercises it, or its own piece only when it exposes a stable interface with its own proof and a named consumer.
8. **Dependencies and delivery order.** Partition by deliverable first, derive order second. A dependent child must still be acceptable on its own once its prerequisite exists; keep the critical path short. The ordering ladder: hard dependency, source of truth, risk, size; "smallest useful slice first" is a heuristic that usually lands on the risk rung by accident and must not be applied over a dependency.
9. **Hand-offs and spikes.** `indivisible` is a verdict (we know it cannot be cut here); `too-uncertain` is a pending state (a person has not decided); the two are never blurred. A technical unknown is a `spike` piece whose acceptance is the questions answered; a partial cut lists the deferred criteria and the spike answer each waits on, so the spike plus the deferred list still accounts for the whole parent.
10. **Revisits.** Every child close is followed by a re-check of the trunk; the ledger classifies every criterion; `exhausted` requires every criterion completed or withdrawn and no open dependency; a better cut found later is a re-carve, and children with work started survive it as adopted pieces; generations and revisits are capped.
11. **Non-code pieces.** Design, docs, migrations, operations are valid when each names a deliverable and its evidence; an unresolved preference is a hand-off, not a design piece.
12. **Other people's seams**, mapped onto the ladder: Lawrence's nine patterns and his two selection rules (severability, then equal size); Cohn's SPIDR (paths and rules are domain seams, interface a tier seam, spike the technical unknown); Cockburn's Elephant Carpaccio (why domain outranks tier); Parnas (a boundary that hides one decision is the admissibility test for the low rungs and the independence score); the WBS 100% rule (the ledger) and 8/80 (floor and ceiling in hours); Google's small-CL guidance (stacked, per-file, horizontal, vertical; a horizontal cut is fine when a stable stub lets each side land alone); Adzic's hamburger method (technical steps when no vertical cut exists); Asthana et al. 2026 (validation gates between sub-tasks, and retrying only the failed phase, which is the journal).

## Scope boundaries

Named here so the lifecycle's claims are read with them.

- **One burndown per run directory, any number of machines per tracker.** The claim on the tracker keeps two knives off one trunk. Two machines can still pick the same leaf before either opens a pull request, because a leaf's only claim today is its pull request; that is the fix pipeline's existing assumption and the follow-up is a worker-side claim in `fix-github-issue`, not this plan.
- **The age window** (`ageDays`) is the burndown's existing scope: an issue older than the window is not selected for appraisal or work unless named or `--all`. Trunks and their children are exempt through the sweep; other old issues are as they were.
- **Dirty-lane recovery** (a worker that modified its worktree and died before a pull request) is the fix pipeline's existing gap, left "for inspection" by its reconciliation; not changed here.
- **Cross-repository sub-issues** are not used; every child is created in the trunk's repository.

## Commits

Every gate names its commands in full. The adopting repository is the checkout holding `burn-down-github-issues.config.ts` from which a gate is run; live gates create their own fixture issue there, titled with a `[carve-test]` prefix, sized by label as the gate says, and close it afterward. Every commit leaves the burndown runnable, and no commit lets a trunk reach a worker.

### Commit 1: widen the shared runtime

**Goal:** Everything in `fix-github-issue` and `appraise-github-issues` the knife and its gates need, before the skill exists.

**Files rewritten:**
- `skills/fix-github-issue/lib/engines.ts`: the `fixture` engine as in Interfaces, with `FIXTURE_RUNNER` a script beside it that copies the seat's model path to the control file the role expects (`loop-carving.json`, `loop-confirmation.json`, `loop-verdict.json`, `loop-appraisal.json`) and exits 0.
- `skills/fix-github-issue/lib/callbacks.ts`: `runCallback(dir, name, payload, log, options?: { timeoutMs?: number })`; default 60 s; `0` means no timer; the process starts in its own group (`setsid` when present, as `agent.ts` does), is added to `children`, drains both pipes concurrently, is removed from `children` on exit, and is killed by group on timeout or shutdown.
- `skills/fix-github-issue/lib/control-files.ts`: `CARVING_FILE = 'loop-carving.json'`.
- `skills/fix-github-issue/lib/agent.ts`: `clearsByRole.carver = [CARVING_FILE, LAST_MESSAGE_FILE]`.
- `skills/fix-github-issue/lib/config.ts`: `PipelineKnobs.pointScale` (default `[1, 2, 3, 5, 8, 13, 21, 34]`, validated as ascending positive integers); `nonNegativeIntegers` option beside `positiveIntegers`.
- `skills/fix-github-issue/lib/context.ts`: `CloseEvent` and `onClosed` as in Interfaces.
- `skills/fix-github-issue/lib/labels.ts`: `ensureLabels` adds `loop/carved` (`5319e7`, "Carved into sub-issues; worked by closing them"), `loop/carving` (`5319e7`, "A carve is in progress; other runs wait"), `spike` (`0e8a16`, "Answer a question with evidence; no pull request"); `carveCount`, `recordCarve(ctx, issue, previous)`, `clearCarves`, and `appraisalCount`, `recordAppraisal`, `clearAppraisals` in the review counter's pattern; `repairDurableState` repairs both; `closeIssue` awaits `ctx.onClosed` after the close.
- `skills/fix-github-issue/lib/pipeline.ts`: `Issue` gains the tree fields; `Verdict` gains `answered` (valid only for an issue labelled `spike`, with `answer` present; rejected as `failed` otherwise); `settleTerminalVerdict` runs `confirmClose` (imported from the appraiser, now exported) for `already-fixed` and `obsolete`, and `confirm-answer.md` for `answered`, closing on agreement and parking as `needs-human` with both opinions on disagreement; `fixIssue` re-reads the issue immediately before spawning the worker and returns `left-alone` when it is closed, Held, a trunk (live record or open child), claimed, or blocked by an issue not closed `COMPLETED`; `FixOutcome` gains `left-alone`; `land` fires `onClosed` through `closeIssue` with `pr` and `mergeSha`.
- `skills/fix-github-issue/prompts/triage-and-fix.md`: when the issue has a parent, read the parent's thread and its latest carving record before starting; when the issue carries `spike`, run the experiments its body names, put the answers with evidence in `answer`, and return `answered`; the verdict schema gains both.
- `skills/appraise-github-issues/lib/appraise.ts`: `sizeCallbackTimeoutMinutes` (default 0) threaded to `runSizeCallback`; `selectForAppraisal` skips `loop/carved`; `appraiseIssue` refuses an issue with an open child (`left-alone` with a message) even when named; a `failed` appraisal records `loop/appraisals: N` and at `maxAppraiseAttempts` (3) parks the issue with the log tail; `confirmClose` exported.
- `skills/appraise-github-issues/appraise.ts`: passes the timeout and the attempt cap.
- `skills/appraise-github-issues/lib/callbacks.ts`: `SizePayload.repoRoot`; the timeout parameter.
- `skills/appraise-github-issues/references/callbacks.md`: the field and the timeout.

**Files created:**
- `skills/fix-github-issue/prompts/confirm-answer.md`: the second engine reads the spike's body and the proposed answer, checks each question has evidence a stranger could re-check, and writes `loop-confirmation.json` with `agree` and `reason`.

**Gate:** `bunx tsc --noEmit -p .` passes and `bun test` passes; from the adopting repository, `bun run <skills>/appraise-github-issues/appraise.ts --dry-run` and `bun run <skills>/burn-down-github-issues/loop.ts --dry-run` print the same selection as before the commit (capture both before starting); `bun run <skills>/fix-github-issue/fix.ts --issue <a [carve-test] issue labelled spike> --worker fixture:<a verdict file with answered> --reviewer fixture:<a confirmation file with agree>` posts the answer and closes the issue.

### Commit 2: the tree and the record, and the burndown reads them

**Goal:** The parsers exist, and the loop never works a trunk or a blocked leaf and works a trunk's leaves in recorded order, before any trunk exists.

**Files created:**
- `skills/carve-github-issue/lib/tree.ts`: `Tree`, `readTree`, `depthOf`, `openChildren`, `openBlockers`, `latestRecord`, `readClaim`, `needsRevisit`, as in Interfaces.
- `skills/carve-github-issue/lib/record.ts`: `Record`, `Ledger`, `renderRecord`, `parseRecord`, `renderChildBody`, `buildLedger`, as in Interfaces.
- `skills/carve-github-issue/lib/carve.test.ts` (first part): `parseRecord` round-trips `renderRecord`; rejects a wrong author, a missing marker, malformed JSON; `buildLedger` on inline fixture trees for every row of the transition table; `needsRevisit` for each of child set, blocker set, `updatedAt`, comment count, and the bot's own comments excluded.
- `skills/carve-github-issue/references/the-record.md`: the grammar, the JSON shape, the ledger transition table, the readers.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: `allIssues` and `selectCandidates` request `parent,subIssuesSummary,blockedBy,updatedAt`; `selectCandidates` drops issues labelled `loop/carved` or `loop/carving`, issues with an open child, and issues with a blocker not closed `COMPLETED`, logging each exclusion with its rule; candidates with a `parent` are grouped contiguously at the position of the group's newest member and sorted within the group by the trunk's latest record (missing record: by number ascending); `reconcileMergedPullRequests` skips issues labelled `loop/carved` and issues with an open child, and `issueRefs` gains a `closing` mode that matches only `(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved) #N`, which reconciliation uses.
- `skills/burn-down-github-issues/status.ts`: `Stage` gains `carved` (🔪), `revisited` (🔁), `released` (🪵) and the emoji map entries.
- `skills/burn-down-github-issues/references/architecture.md`: the selection and reconciliation rules.

**Gate:** `bunx tsc --noEmit -p .` passes and `bun test` passes; from the adopting repository, `bun run <skills>/burn-down-github-issues/loop.ts --dry-run` prints the same candidates as the Commit 1 capture and logs the three new exclusions with zero hits.

### Commit 3: the knife's library, prompts, and tests

**Goal:** `carveIssue` works end to end under test and in dry run; no command yet.

**Files created:**
- `skills/carve-github-issue/lib/carve.ts`: `CarveKnobs`, `CARVE_DEFAULTS`, `assertDistinctEngines` (an error when carver and confirmer share an engine), `validateCarving`, `validateConfirmation`, `normalize`, `claim` and `unclaim`, `applyGeneration` (journaled; resumable by marker and by re-reading the tree), `finishGeneration`, `finishRelease`, `carveIssue`: local lock; read tree; finish unfinished work; guards and counters; claim; choose mode from the latest record; run carver; validate; re-read live; confirm with rounds; apply; callbacks; clear or record the counter; unclaim; unlock (the unlock and unclaim run in `finally`). `CarveOutcome` as in Interfaces.
- `skills/carve-github-issue/lib/carve.test.ts` (second part): `validateCarving` (every enum, bounds, cycles, order consistency, headings, criterion ownership, `higherRungs` non-empty below domain, `supersedes.old` against a record, `reference` inside the tree rejected, fan-out with attached references), `validateConfirmation` per mode and finding, `depthOf` and the depth cap at the boundary, resume matching markers by generation and skipping done steps, the counters' thresholds and that `busy` does not count, stale-claim detection, the revisit cap, the generation cap.
- `skills/carve-github-issue/lib/callbacks.ts`: `runCarveCallback(dir, 'on-carve-pass' | 'on-carve-fail', payload, log)` on the shared slot; payload `{ issue, title, mode, verdict, generation, seam, relation, children: number[], superseded: number[], reason, repo, baseBranch, repoRoot }`; the directory is `CarveKnobs.callbacksDir`, the same one the size callbacks use.
- `skills/carve-github-issue/prompts/carve.md`: read-only turn against the main checkout with `appraise.md`'s access rules; reads the whole thread; inventories the criteria; normalizes; loads `references/seams.md` by path; proposes a cut on every seam that applies with reasons for every higher rung; chooses by the scoring order in `seams.md` (seam rank, severability, balance, independence, size within bounds, child count); writes the answer file even when it cannot finish.
- `skills/carve-github-issue/prompts/revisit.md`: the same on a trunk with a live record: reads every child's thread including closed ones and the latest record; rebuilds the ledger; answers `still-good`, `amend`, `exhausted`, or a hand-off.
- `skills/carve-github-issue/prompts/confirm-carve.md`: the checklist above per mode and finding; the seam rule; rendered with the round number and, after the first round, the carver's reply.
- `skills/carve-github-issue/references/seams.md`: see "The seams reference".
- `skills/carve-github-issue/references/lifecycle.md`: the states, transitions, invariants, counters, and the board note from this plan's lifecycle section, kept as the skill's durable contract.

**Gate:** `bunx tsc --noEmit -p .` passes and `bun test` passes; a test in `carve.test.ts` drives `carveIssue` with a dry-run context and fixture seats through a full carve, a disputed carve to the cap, a `still-good`, and an `exhausted`, asserting the journal steps and the mutations the dry run would have made.

### Commit 4: the `carve.ts` command

**Goal:** The skill runs standalone.

**Files created:**
- `skills/carve-github-issue/carve.ts`: `--issue N` (required), `--dry-run`, `--ceiling N`, `--carver`, `--confirmer`, `--callbacks <dir>`, `--fail-after <step>` (refused unless `CARVE_DEV=1`; exits after the named journal step); reads `carve-github-issue.config.ts`, else `burn-down-github-issues.config.ts` (ceiling from `maxPoints`, seats from `seats`, limits from an optional `carve` block merged over `CARVE_DEFAULTS` and validated with `positiveIntegers`); builds the context with the pipeline's own seats and knobs from the same config, since `createContext` requires them; refuses same-engine seats; tees `runs/carve.log`; the same signal handling as `appraise.ts`; prints the outcome; exit code 0 for every confirmed verdict and `left-alone`, 1 on `failed`, 3 on `busy`.
- `skills/carve-github-issue/SKILL.md`: what it does, trunk and leaves, normalization, the record, the lifecycle in brief, run lines, dependencies, the ceiling paragraph (tracker as untrusted instruction channel; the carver and confirmer must be different engines, and even then their independence is model-level: both run as one GitHub account).
- `skills/carve-github-issue/references/adopting.md`: the `carve` config block (`maxDepth: 3, maxChildren: 8, maxCarveRounds: 5, maxCarveAttempts: 3, maxGenerations: 5, maxRevisitsPerGeneration: 10, callbacksDir`), `seats.carver`, the labels, what lands on the tracker, the guards, the boundaries.
- `skills/carve-github-issue/references/callbacks.md`: the two slots, both forms, the payload.

**Gate:** `bunx tsc --noEmit -p .` passes and `bun test` passes; from the adopting repository: `bun run <skills>/carve-github-issue/carve.ts --issue <a [carve-test] issue labelled size: 8> --dry-run` writes only the log; the same without `--dry-run` produces children attached in delivery order, edges, no size label on any child, a generation-1 record, `loop/carve-gen: 1`, `loop/carved`, no `loop/carving`, and a line from a scratch `on-carve-pass` executable; the same on a second fixture issue with `--confirmer fixture:<a confirmation file answering gap>` logs five rounds, leaves the trunk `needs-human`, creates nothing, and runs `on-carve-fail`; the same on a third fixture issue with `CARVE_DEV=1 --fail-after create` then a plain rerun finishes generation 1 without a duplicate child.

### Commit 5: revisit on close, inside and outside the loop

**Goal:** Every leaf close is followed by a revisit of its trunk.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: supplies `ctx.onClosed` (the roll-up, then `carveIssue`, then `appraiseIssue` after a confirmed `exhausted`, as under Revisit triggers); the two-pass sweep; the board marks `revisited` and `released`.
- `skills/burn-down-github-issues/references/architecture.md`: the revisit stage and the sweep.

**Gate:** `bunx tsc --noEmit -p .` passes and `bun test` passes; from the adopting repository, on the trunk Commit 4 carved: `bun run <skills>/burn-down-github-issues/loop.ts --limit 1` works the first leaf by recorded order, posts one roll-up, and the revisit answers `still-good` with a record whose ledger shows one criterion completed and `revisits: 1`; close the remaining leaves by hand and rerun: the sweep revisits, `exhausted` is confirmed, the labels come off in order, and the appraiser handles the trunk in the same run; remove `loop/carved` from a second carved fixture by hand, close its leaves, rerun: the second pass finds it and it is exhausted; reopen one closed leaf of the released trunk and rerun: the second pass hands it to the knife in carve mode and the reopened leaf is adopted, not re-authored; comment on a live trunk and rerun: one revisit, `still-good`.

### Commit 6: the shipped size callback

**Goal:** An issue sized over the ceiling is carved without the appraiser knowing the knife exists.

**Files created:**
- `skills/burn-down-github-issues/callbacks/on-size-over-ceiling`: a `#!/usr/bin/env bash` template whose second line is the ownership marker `# rendered by burn-down-github-issues; edits are overwritten`; reads stdin into a variable, extracts the issue number with `bun -e` from the JSON, and runs `bun run '{{CARVE_DIR}}/carve.ts' --issue "$issue"` from `'{{REPO_ROOT}}'` with single quotes and `'\''` escaping for the two substituted paths; exits with the knife's code.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: `placeSizeCallbacks` renders the template to `<callbacksDir>/on-size-over-<maxPoints>` by writing a temporary file and renaming it into place with the executable bit set; before that it removes any other regular file named `on-size-over-*` whose second line is the marker (directories and symlinks are left alone); in a dry run it logs what it would do and returns.
- `skills/burn-down-github-issues/callbacks/README.md`: the shipped callback, the rendering, the marker.
- `skills/burn-down-github-issues/SKILL.md`, `skills/burn-down-github-issues/references/adopting.md`, `skills/burn-down-github-issues/references/operating.md` (including the revisit-cap note), `README.md`: the carving stage, the `carve` config block and `seats.carver`, the labels, the skill row.

**Gate:** `bunx tsc --noEmit -p .` passes and `bun test` passes; the adopting repository's config gains the `carve` block and `seats.carver` (that file is the adopter's, edited outside this repository); from there, `bun run <skills>/burn-down-github-issues/loop.ts --appraise-limit 1` on a fresh `[carve-test]` issue the appraiser sizes over the ceiling shows the callback firing and a carve log under `runs/`; change `maxPoints` and rerun `--dry-run`: the log names the re-render and an unmarked `on-size-over-99` placed by hand survives; every relative link in the touched `.md` files resolves (`grep -oE '\]\([^)]+\.md[^)]*\)'` then `test -e` each target).

### Commit 7: delete this plan

- Verify: every commit above shipped, the verification checklist green, both validation commands green.
- Propose deletion explicitly, naming the path `add-carve-github-issue.md`, and wait for the developer's explicit confirmation.
- On confirmation, check the path ends in `.md`, is repository-relative, exists in the working tree, and matches this front matter; then delete and commit the deletion alone.
- The methodology (`references/seams.md`), the lifecycle (`references/lifecycle.md`), and the record (`references/the-record.md`) are skill docs and stay.

**Gate:** `bunx tsc --noEmit -p .` passes and `bun test` passes; `git grep -n add-carve-github-issue` is empty.

## Verification checklist

- [ ] `bunx tsc --noEmit -p .` and `bun test` pass at every commit.
- [ ] Appraise and burndown dry runs from the adopting repository match the Commit 1 captures after Commits 1 and 2.
- [ ] One standalone carve produced attached children in delivery order, edges, no size labels on children, a generation-1 record, the generation label, `loop/carved`, and no lingering claim; one adopted or referenced issue where one matched.
- [ ] One forced dispute ran five rounds, left the trunk `needs-human` with the exchange, created nothing, and ran `on-carve-fail`.
- [ ] A crash injected after the first child resumed the generation on the next run without a duplicate.
- [ ] One burndown run skipped the trunk, worked its first leaf by recorded order, posted one roll-up, and revisited `still-good` with the ledger and `revisits` updated.
- [ ] One sweep revisited a trunk whose leaves were closed by hand, confirmed `exhausted`, released it, and the appraiser handled it in the same run.
- [ ] One trunk stripped of its label by hand was found by the second pass and exhausted.
- [ ] One released trunk with a reopened leaf was carved afresh with the leaf adopted.
- [ ] One comment on a live trunk produced exactly one revisit.
- [ ] One spike leaf ended in `answered` with confirmed proof on the thread and no pull request; one worker `already-fixed` went through the confirmer.
- [ ] The shipped size callback fired for an issue sized over the ceiling; the rendered file carries the marker; an unmarked adopter file survived a ceiling change.
- [ ] Every transition in the lifecycle table is exercised by a test in `carve.test.ts` or a gate above, and none ends in a state without an owner.
- [ ] Every relative link in the touched SKILL and reference files resolves.
- [ ] Plan file deleted after the two-key handshake (Inspector Gadget Rule: no orphan plans).

## References

- `skills/appraise-github-issues/lib/appraise.ts`, the shape `carveIssue` follows and the confirmer the fix pipeline now reuses.
- `skills/appraise-github-issues/references/callbacks.md`, the slot the knife answers.
- `skills/fix-github-issue/lib/labels.ts`, the counter pattern the new counters copy.
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

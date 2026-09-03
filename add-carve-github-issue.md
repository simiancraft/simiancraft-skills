# Add `carve-github-issue`: erode oversized issues into sub-issues

**Status:** Draft
**Scope:** cross-stack
**Date:** 2026-09-02
**Last reviewed:** 2026-09-03
**Context:** The appraiser runs a size callback after every `valid` verdict, but nothing answers it: an issue sized above the burndown's ceiling is labelled and then sits, because no skill turns a 13 into an 8 and a 5.

## Goal

The burndown works issues at or under a ceiling (`maxPoints`) and never touches anything above it, so the hardest work in a backlog is exactly what the loop skips. `carve-github-issue`, the knife, takes one oversized issue and expresses it as GitHub sub-issues: it names the pieces along the highest seam the work has, matches each against the backlog so nothing is authored twice, and creates only what a second engine has confirmed covers the parent. The parent stays open as the trunk; the burndown works its leaves; every leaf close is followed by a revisit; a trunk with nothing left goes back to the appraiser. A leaf still over the ceiling is carved again, so a 13 erodes into 3s. Done looks like: the knife carves or revisits one issue on demand, the burndown invokes it over its ceiling and never works a trunk, and every path a ticket can take ends in a merge, a confirmed close, or a person.

## Domain context

- **Seam.** A line along which one issue can be cut into children that each stand alone. Seams are ranked (domain, tier, route, area, file, unit, material) and searched from the top. A cut on any rung is admissible only if every child has one bounded outcome, its own acceptance and proof, and leaves the base usable after it lands; the ladder is a search order, not a trump card. The methodology is `references/seams.md`.
- **Piece.** One unit of the parent's work. A piece becomes a child by authoring a new issue, by adopting an issue already in the trunk's tree, or by referencing one from elsewhere in the backlog, open or closed. Normalization (inventory the parent's acceptance criteria, name the pieces, match each against the tree and the backlog, author only what is missing) is a step of every carve.
- **Trunk and leaves.** The parent is the trunk: open, carrying a live carving record, never handed to a worker. Leaves are landable increments the burndown works; an interior node is a trunk of its own. The trunk commands its leaves through the record: their order, their edges, and which of them are paused while a question about the trunk is open. Trunk-first (a person doing the whole thing) closes many leaves at once; leaf-first (the loop) erodes the trunk. Nothing is lost either way, because the tracker holds the tree.
- **Carving record.** A comment with a fixed grammar posted on the trunk by the knife at every step that changes the carving: `applying` before the writes of a generation, `live` after them and after every revisit, `released` when the trunk is handed back to the appraiser. It carries the cut, the ledger (every acceptance criterion of the parent with its owner and status), the per-child commands, and a fingerprint of what the tracker looked like when it was written. The newest is authoritative; its grammar is `references/the-record.md`. Workers, revisits, and people read it.
- **Claim.** A label plus a marker comment that says a run is acting on an issue right now, honoured across machines: `loop/carving` for the knife, `loop/working` for a worker. Each stands off the other. A claim older than its holder's time bound is stale and is cleared by the sweep.

## Domain categories

- **Cut.** One candidate decomposition along one seam: pieces, their relation, delivery order, shared groundwork with owners, and a reason for every higher rung not taken. The carver proposes a cut on every seam that applies and chooses one; the alternatives stay in its answer.
- **Cover.** The confirmer's verdict that the union of the pieces is the parent: no criterion unowned (`gap`), nothing the parent did not ask for (`overreach`). A width cut, one job over interchangeable instances, is judged for partition integrity instead (`partition-intact` or `partition-broken`).
- **Relation** of one cut's children: `shards` (disjoint slices of one job; any order; parallel), `layers` (each builds on the one before; source of truth first), `mixed` (edges listed per child), `waiting` (everything unlisted depends on a named spike). An edge is a `blocked-by` link on the tracker, recorded in the record as well so its removal by hand is visible.
- **Revisit.** The knife on a trunk whose latest record is `live`, asked one question: is this carving still good? It answers `still-good`, `amend`, `exhausted`, or a hand-off, and the second engine confirms the answer as it confirms a carve. The knife's mode is chosen from the latest record alone: `live` means revisit; none, or `released`, means carve.
- **Generation.** One carve or amend of a trunk, numbered from 1. The number is carried on a `loop/carve-gen: N` label, in every record, in the journal, and in every authored child's marker, so successive generations never match each other's children.
- **Journal.** `runs/carve-<n>-gen<g>.json`, this machine's copy of the steps of one generation and their status. It speeds up a resume on the same machine; the `applying` record on the tracker is what any machine resumes from.
- **Sweep.** The burndown's start-of-run pass that hands the knife every issue the tracker says needs it, so closes, edits, and holds made outside the loop are seen on the next run.
- **Roll-up.** The comment the loop posts on a trunk when one of its leaves closes: which leaf, how, when, and where the proof is.
- **Hand-offs.** `indivisible` (cannot be cut at this ceiling), `small-enough` (the carver disputes the size), and `nothing-left` (the carver finds every criterion done while the appraiser sized it as work) go to `needs-human`; `too-uncertain` (a product ruling nobody has made) goes to `needs-decision` with the question. A technical unknown is none of these: it becomes a `spike` piece, and the rest of the cut waits on it.
- **Scale.** The adopter's point scale, the values the config's `pointScale` array lists (the Fibonacci rungs by default). Every size in this plan is on it. The ceiling is the adopter's `maxPoints`; the burndown's own default is 2.

## Current surface area

| Where | What | Change |
|---|---|---|
| `skills/fix-github-issue/lib/engines.ts` :17-38 | `ENGINES` | `fixture` and `fixture2` engines for deterministic gates |
| `skills/fix-github-issue/lib/agent.ts` :220, :243 | `clearsByRole`, child env | `carver` entry; `LOOP_ROLE` in the child's environment |
| `skills/fix-github-issue/lib/callbacks.ts` :22, :53-61 | `runCallback` | `timeoutMs` option (0 = none); process group; registered in `children` |
| `skills/fix-github-issue/lib/control-files.ts` | control-file names | `CARVING_FILE` |
| `skills/fix-github-issue/lib/shell.ts` :90 | `mutate` | records dry-run mutations on the context |
| `skills/fix-github-issue/lib/context.ts` :24-51 | `Context` | `onClosed`, `dryRunLog`, `botLogin` |
| `skills/fix-github-issue/lib/config.ts` :70, :192, :221 | `PipelineKnobs`, merge, validator | `pointScale`; nested-block merge; zero-allowed knobs |
| `skills/fix-github-issue/lib/labels.ts` :16-75, :112, :144 | `ensureLabels`, counters, `repairDurableState`, `closeIssue` | new labels; carve and appraisal counters; caps as parameters; async close with an event |
| `skills/fix-github-issue/lib/pipeline.ts` :27, :36-42, :67, :106, :421-503, :507-536, :572, :708 | types, landing, `settleTerminalVerdict`, `workIssue`, `fixIssue` | tree fields; `answered`; confirmed closes; live gate; worker claim; topology re-read before merge and close |
| `skills/fix-github-issue/lib/resume.ts` :31, :98, :166 | `reconcile`, `findStranded`, resume | stale `loop/working` cleared; topology re-read on resume |
| `skills/fix-github-issue/fix.ts` :86-122 | standalone command | `--confirmer`; the appraiser's prompts dir; tree fields |
| `skills/fix-github-issue/prompts/triage-and-fix.md` :147-166 | worker prompt and verdict schema | parent record; `answered` and `answer` |
| `skills/appraise-github-issues/lib/appraise.ts` :59-76, :127, :137-147, :203, :243, :326 | knobs, listing, selection, `confirmClose`, `appraiseIssue` | timeout knob; paginated listing; skip trunks; export `confirmClose`; attempt counter; refuse a trunk by name; journaled hand-off |
| `skills/appraise-github-issues/appraise.ts` :215 | standalone caller | passes the timeout and the cap |
| `skills/appraise-github-issues/lib/callbacks.ts` | `SizePayload`, `runSizeCallback` | `repoRoot`; timeout passed through |
| `skills/appraise-github-issues/prompts/appraise.md` :23 | age-window sentence | conditioned on the window being in force |
| `skills/appraise-github-issues/references/callbacks.md` | ladder, forms, payload | field and timeout |
| `skills/burn-down-github-issues/loop.ts` :485, :497-545, :554-611, :624, :775-808 | listing, reconciliation, selection, claims, callbacks, `main` | tree fields; paginated listings; reconciliation guard; trunk, blocker, pause, claim rules; leaf order; rendered callback; sweep; hook wiring |
| `skills/burn-down-github-issues/status.ts` :11 | `Stage` and emoji map | `carved`, `revisited`, `released` |
| `skills/burn-down-github-issues/callbacks/README.md` | empty slot directory | the shipped callback |
| `skills/burn-down-github-issues/SKILL.md`, `references/{architecture,adopting,operating}.md` | | carving stage, revisit, selection rules, labels, the `carve` config block |
| `README.md` | skill table | row for `carve-github-issue` |

Forge facts (verified 2026-09-02 against `gh` 2.97.0): `gh issue create --parent N` creates a child already attached; `gh issue edit N --parent P` attaches an existing issue; `gh issue edit N --add-blocked-by M` and `--remove-blocked-by M` record and remove a dependency; `gh issue close N --reason "not planned"` sets `stateReason`; `gh issue list --json` and `gh issue view --json` expose `parent`, `subIssues`, `subIssuesSummary {total, completed}`, `blockedBy {nodes: [{number, state, stateReason}]}`, `blocking`, `stateReason`, `body`, and `comments` (with `id`, `author`, `body`, `createdAt`); `gh api --paginate` walks any listing past a page; `gh api user` names the authenticated account. GitHub allows 100 sub-issues per parent and eight levels of nesting; each issue has one parent.

## File structure: before

**Legend:** ✏️ rewritten · ❌ deleted

```
simiancraft-skills/
├── ❌ add-carve-github-issue.md               // this plan; deleted by its last commit
├── ✏️ README.md
└── skills/
    ├── appraise-github-issues/
    │   ├── ✏️ appraise.ts                       // passes the timeout and the cap
    │   ├── lib/
    │   │   ├── ✏️ appraise.ts                   // timeout knob; paginated listing; skip trunks; attempt counter; export confirmClose; journaled hand-off
    │   │   └── ✏️ callbacks.ts                  // repoRoot in the payload; timeout passed through
    │   ├── prompts/
    │   │   └── ✏️ appraise.md                   // age-window sentence conditioned
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
        ├── ✏️ fix.ts                            // --confirmer; appraiser prompts dir; tree fields
        ├── lib/
        │   ├── ✏️ agent.ts                      // carver role; LOOP_ROLE
        │   ├── ✏️ callbacks.ts                  // timeoutMs; process group; registered child
        │   ├── ✏️ config.ts                     // pointScale; nested-block merge; zero-allowed knobs
        │   ├── ✏️ context.ts                    // onClosed; dryRunLog; botLogin
        │   ├── ✏️ control-files.ts              // CARVING_FILE
        │   ├── ✏️ engines.ts                    // fixture engines
        │   ├── ✏️ labels.ts                     // labels; counters; caps; async close with event
        │   ├── ✏️ pipeline.ts                   // tree fields; answered; confirmed closes; live gate; worker claim; topology re-read
        │   ├── ✏️ resume.ts                     // stale working claims; topology re-read on resume
        │   └── ✏️ shell.ts                      // dry-run mutation log
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
    │   ├── 🆕 carve.ts                          // CLI: --issue N [--dry-run] [--ceiling N] [--carver] [--confirmer] [--fail-after step]
    │   ├── 🆕 lib/
    │   │   ├── 🆕 carve.ts                      // carveIssue(ctx, issue, knobs): CarveOutcome; claim; validation; rounds; apply; journal
    │   │   ├── 🆕 carve.test.ts                 // validators, ledger transitions, record round-trip, needsRevisit, resume, counters, claims, pauses; inline fixtures
    │   │   ├── 🆕 tree.ts                       // Tree, readTree, depthOf, latestRecord, fingerprint, needsRevisit, claims
    │   │   ├── 🆕 record.ts                     // Record, Ledger, renderRecord, parseRecord, renderChildBody, buildLedger, pauseSet
    │   │   └── 🆕 callbacks.ts                  // on-carve-pass / on-carve-fail on the shared slot mechanism
    │   ├── 🆕 prompts/
    │   │   ├── 🆕 carve.md                      // the carver turn: criteria, normalization, seams, cuts, choice
    │   │   ├── 🆕 revisit.md                    // the carver turn on a trunk with a live record
    │   │   └── 🆕 confirm-carve.md              // the confirmer turn: cover or partition, the checklist, seam dispute, revisit, hand-off, pause set
    │   └── 🆕 references/
    │       ├── 🆕 seams.md                      // the ladder, the axioms, the floor, width, normalization, ordering, literature
    │       ├── 🆕 lifecycle.md                  // the states, transitions, invariants, counters, claims; the board's columns
    │       ├── 🆕 the-record.md                 // the record's grammar, the ledger and its transitions, the fingerprint, who reads it
    │       ├── 🆕 adopting.md                   // config, labels, what lands on the tracker, guards, boundaries
    │       └── 🆕 callbacks.md                  // the two slots and their payload
    ├── appraise-github-issues/
    │   ├── ✏️ appraise.ts
    │   ├── lib/
    │   │   ├── ✏️ appraise.ts
    │   │   └── ✏️ callbacks.ts
    │   ├── prompts/
    │   │   └── ✏️ appraise.md
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
        ├── ✏️ fix.ts
        ├── lib/
        │   ├── ✏️ agent.ts
        │   ├── ✏️ callbacks.ts
        │   ├── ✏️ config.ts
        │   ├── ✏️ context.ts
        │   ├── ✏️ control-files.ts
        │   ├── ✏️ engines.ts
        │   ├── 🆕 fixture-runner.ts             // the fixture engines' executable: copies a canned answer into the role's control file
        │   ├── ✏️ labels.ts
        │   ├── ✏️ pipeline.ts
        │   ├── ✏️ resume.ts
        │   └── ✏️ shell.ts
        └── prompts/
            ├── 🆕 confirm-answer.md             // second engine on a spike's answered verdict
            └── ✏️ triage-and-fix.md
```

## The lifecycle

Only so many things can happen to a ticket. This section names all of them; the rest of the plan is the machinery that makes each transition hold. Every state is derived from the issue itself (its labels, its sub-issue tree, its latest record); nothing in a run directory decides a state, and the journal only speeds up finishing writes the tracker already shows as started. That property is deliberate: these states are the columns of the board this work will eventually be shown on, and a state a person cannot read off the issue is a defect.

One rule governs every cost trade-off below: churn spent re-reading an existing issue is cheaper than the churn a wrong carving multiplies into. Where the plan can spend an agent turn to be sure, it does.

### States

Derived in this precedence; every issue is in exactly one.

| Precedence | State | Derived from | Who owns it |
|---|---|---|---|
| 1 | **Closed** | `state: CLOSED`; `stateReason` `COMPLETED` or `NOT_PLANNED` | terminal |
| 2 | **Held** | any of `needs-human`, `needs-decision`, `loop/skip`, `loop/parked`, `loop/dlq`, `loop/paused` | a person, or the parent that paused it |
| 3 | **Claimed** | `loop/carving` or `loop/working` with a live claim | the run that claimed it |
| 4 | **Trunk** | a `live` or `applying` record, or any open child | the knife (revisit); workers take its leaves |
| 5 | **Blocked** | a `blocked-by` on the tracker or in the parent's record whose target is not closed `COMPLETED` | its blocker; a root leaf whose blocker closed `NOT_PLANNED` goes Held (`needs-human`) by the sweep, since no trunk will re-own it |
| 6 | **Oversized** | sized over the ceiling | the knife (carve) |
| 7 | **Leaf** | sized at or under the ceiling | the fix pipeline |
| 8 | **Unsized** | no `size:` label | the appraiser |

`loop/carved` is the trunk's label for people and for the worker's selection; a trunk that lost it is still a trunk by this table and is re-labelled at its next revisit. `loop/carve-gen: N` survives the removal of `loop/carved` and is the second way the sweep finds a trunk.

### Transitions

| From | Event | To | Notes |
|---|---|---|---|
| Unsized | appraiser: `valid` at or under the ceiling | Leaf | |
| Unsized | appraiser: `valid` over the ceiling | Oversized | fires the size callback, which runs the knife |
| Unsized | appraiser: close confirmed / hand-off | Closed / Held | the hand-off comment and label are one journaled step, finished on the next run if interrupted |
| Unsized | appraiser: crash, malformed answer, confirmer failure | Unsized | `loop/appraisals: N`; on reaching `maxAppraiseAttempts` (3) goes Held (`needs-human`) with the log tail |
| Oversized | knife: `carve` confirmed | Trunk | generation 1: `applying` record, children, edges, `live` record, labels, unclaim |
| Oversized | knife: `small-enough`, `indivisible`, `nothing-left`, disputed past the round cap, all confirmed | Held (`needs-human`) | both opinions on the thread; a `live` record with the verdict |
| Oversized | knife: `too-uncertain` confirmed | Held (`needs-decision`) | the question on the thread; a `live` record with the verdict |
| Oversized | knife: `failed` (crash, invalid answer, upstream refusal) | Oversized | `loop/carves: N`; on reaching `maxCarveAttempts` (3) goes Held (`needs-human`) with the log tail; `busy` never counts |
| Oversized | depth cap | Held (`needs-human`) | `indivisible` by definition |
| Oversized | another run's claim, or a worker's claim, is live | Oversized (`busy`) | retried by the sweep once the claim is gone |
| Leaf | worker starts | Claimed (`loop/working`) | after the live gate; the claim is released at the terminal outcome, whatever it is |
| Claimed (working) | `merged`; `already-fixed`, `obsolete`, `answered` confirmed by the second engine | Closed (`COMPLETED`) | the pull master re-reads topology before merge and before close; the close hook posts a roll-up and revisits the parent when there is one |
| Claimed (working) | a close the second engine disputed; `needs-*`; parked; dlq; topology changed under it | Held | the trunk waits; the pull request, if any, is parked with the reason |
| Claimed (working) | `out-of-band` re-sizes over the ceiling | Oversized | recursion; the depth guard bounds it |
| Claimed (working) | the run dies | Leaf | the next run's stranded pass resumes the lane or clears the stale claim |
| Leaf | a person closes it | Closed | `COMPLETED` completes its criteria; `NOT_PLANNED` orphans them; a dependent sibling stays Blocked |
| Trunk | a child closes, reopens, is added, or is edited; a blocker changes state; an edge is removed; any comment or edit on the trunk by a person | Trunk | revisit: `still-good` (new record), or `amend` confirmed (new generation), each with its pause set |
| Trunk | revisit: hand-off confirmed | Held | the trunk's hold; the leaves the question touches, and their dependents along recorded edges, get `loop/paused`; the rest keep working |
| Held (trunk) | a person answers and removes the hold | Trunk | the sweep sees the label change, the revisit lifts every pause it recorded and amends as the answer requires, including a rollback piece for work that landed on the old premise |
| Trunk | revisit: `exhausted` confirmed | Unsized | a `released` record; size label off; `loop/carved` off; counters off; unclaim; the appraiser is run on it directly |
| Trunk | revisit disputed past the round cap; `amend` on reaching `maxGenerations` (5); `still-good` on reaching `maxRevisitsPerGeneration` (10) | Held (`needs-human`) | the label and children stay; a person resolves; removing the hold resets the counter that tripped |
| Trunk | knife `failed` | Trunk | `loop/carves: N` as above; the sweep retries while the tracker still differs from the record |
| Trunk | a person closes it with children open | Closed | children continue as leaves; the hook sees a closed parent and does nothing |
| Trunk (released, closed children only) | appraiser sizes the remainder | Leaf or Oversized | closed children do not route; a small remainder is an ordinary leaf; an oversized one is carved afresh with the closed children adopted as completed pieces |
| Held | a person removes the hold label | whatever the table derives | a counter at its cap is cleared by the sweep first; `needs-decision` answered re-enters with the answer in the thread |
| Closed | a person reopens | whatever the table derives | a reopened child changes the tree and triggers a revisit; a reopened child of a released trunk makes the trunk a Trunk again, in carve mode |

### Terminal cases

Closed, and every Held state. Nothing else is terminal, and every non-terminal state has a retry path with a counter: `loop/appraisals: N` for the appraiser, `loop/carves: N` per generation for the knife, `loop/reviews: N` for the fix pipeline as today, `maxGenerations` and `maxRevisitsPerGeneration` per trunk, `maxDepth` per tree. Recursion is bounded twice: an authored child is at most the ceiling, so strictly smaller than its oversized parent on the scale, and the depth cap ends any tree the scale did not; an adopted or referenced piece keeps its own size and is carved on its own depth.

### Invariants

Each has a test or a gate below.

- A confirmed cut is applied only to the trunk it was confirmed against: the fingerprint the carver read is re-read before the first write, and any difference restarts from the carver.
- A generation whose `applying` record exists is finished by whichever machine sees it next, from that record, then revisited at once; if the trunk gained a hold meanwhile, every new child is paused.
- A referenced or adopted issue closed `NOT_PLANNED` (which is also how the knife closes a superseded child) or deleted does not complete a criterion; the ledger marks it `orphaned`, `still-good` is invalid while any criterion is orphaned, and the revisit must re-own it.
- A criterion the thread has retracted is `withdrawn`, citing the comment; it counts as done for exhaustion; if the comment disappears the criterion is `open` again, and the sweep sees the change because comment ids are in the fingerprint.
- Mode is chosen from the latest record, never from the tree, so a released trunk is never revisited into a second `exhausted`.
- Closed children never route an issue to the knife; only open children, a live record, or an oversized label do.
- A release that crashed after its record is finished by the record: a `released` record with any of the size label, `loop/carved`, or the counter labels still present is completed before anything else.
- Merge reconciliation never closes a trunk: it skips issues with a live record or an open child, re-reads the issue immediately before closing, and requires a closing keyword before an issue number.
- A worker never starts on, merges, or closes a trunk, a held or paused issue, an oversized issue, or a leaf whose blocker (on the tracker or in the parent's record) is not `COMPLETED`: the live gate re-reads before spawning, and the pull master re-reads before merge and before close.
- The knife never carves under a worker and a worker never starts under the knife: each stands off the other's claim, on every machine.
- Every close of a leaf, wherever it comes from, is followed by a revisit of its parent: immediately when the loop made the close, on the next run's sweep otherwise, because the fingerprint carries child states.
- Two roll-ups for one close are impossible: the roll-up is keyed by child, event, and the close time, and the hook skips one the thread already carries.
- The knife's own writes never trigger a revisit: the fingerprint excludes the loop's marker comments and the `loop/*` labels.
- `busy` never spends an attempt.

## Interfaces

The types every commit below refers to. They live where the tree says; the shapes are fixed here so no commit invents them.

```ts
// fix-github-issue/lib/context.ts
export type CloseEvent = { issue: number; kind: 'merged' | 'closed' | 'answered'; pr?: number; mergeSha?: string; closedAt: string; reason: string };
Context.onClosed?: (event: CloseEvent) => Promise<void>;   // awaited by closeIssue; a throw is logged, never propagated
Context.dryRunLog: string[];                                // every mutate() the dry run would have made, in order
Context.botLogin: string;                                   // `gh api user` at context creation; the author records must carry

// fix-github-issue/lib/engines.ts
ENGINES.fixture, ENGINES.fixture2: { command: (cwd, prompt, model) => ['bun', FIXTURE_RUNNER, cwd, model] }
// `fixture:<path>` / `fixture2:<path>`: the runner reads LOOP_ROLE from its environment, copies <path> to that role's control file in cwd, exits 0. Two names so assertDistinctEngines holds in tests.

// fix-github-issue/lib/agent.ts
runAgentOnce sets LOOP_ROLE=<role> in the child's environment.

// fix-github-issue/lib/config.ts
PipelineKnobs.pointScale: number[];                 // default [1, 2, 3, 5, 8, 13, 21, 34]; ascending positive integers
loadProjectConfig options.nonNegativeIntegers;       // sibling of positiveIntegers
loadProjectConfig options.blocks?: string[];         // nested objects merged one level deep over their defaults, like seats

// fix-github-issue/lib/labels.ts
export async function closeIssue(ctx, issue: number, comment: string, event: Omit<CloseEvent, 'issue' | 'closedAt'>): Promise<void>;
export function carveCount(labels), recordCarve(ctx, issue, previous), clearCarves(ctx, issue);        // loop/carves: N
export function appraisalCount(labels), recordAppraisal(ctx, issue, previous), clearAppraisals(ctx, issue);  // loop/appraisals: N
export function repairDurableState(ctx, all, skipLabels, caps: { reviews; carves; appraisals });

// fix-github-issue/lib/pipeline.ts
Issue: { number; title; createdAt; labels; parent?: { number } | null; subIssuesSummary?: { total; completed };
         blockedBy?: { nodes: Array<{ number; state; stateReason }> } };      // optional until Commit 2 requests them everywhere
Verdict: adds 'answered'; WorkerResult.answer?: string     // Markdown; required with 'answered'
FixOutcome.outcome: adds 'left-alone' (the live gate refused) and 'busy' (a foreign claim)
fixIssue(ctx, issue, options: { maxPoints?; ceiling?; confirmer: Seat })

// carve-github-issue/lib/tree.ts
export type Comment = { id: string; author: string; body: string; createdAt: string };
export type Seam = 'domain' | 'tier' | 'route' | 'area' | 'file' | 'unit' | 'material';
export type Relation = 'shards' | 'layers' | 'mixed' | 'waiting';
export type OrderRung = 'dependency' | 'source-of-truth' | 'risk' | 'size';
export type Tree = { issue: Issue & { body; state; stateReason; comments: Comment[] };
  children: Array<Issue & { state; stateReason; bodyHash: string; blockedBy }>; blockers: Array<Issue & { state; stateReason }>;
  depth: number; record: Record | null; generation: number; claims: Claim[] };
export type Claim = { kind: 'carving' | 'working'; runId: string; at: string; released: boolean };
export type Fingerprint = { bodyHash: string; size: number | null; holds: string[]; comments: string[] /* ids, markers excluded */;
  children: Array<{ number; state; stateReason; bodyHash; blockedBy: number[] }>; blockers: Array<{ number; state; stateReason }>; parent: number | null };
export function readTree(ctx, number): Tree;                          // one gh issue view for the trunk, one per child, one per ancestor for depth
export function fingerprint(tree: Tree): Fingerprint;
export function needsRevisit(record: Record, tree: Tree): string | null;   // the first differing field, or null
export function liveClaim(tree: Tree, kind, runId): Claim | null;    // the earliest unreleased, unexpired claim of that kind not ours

// carve-github-issue/lib/record.ts
export type CriterionStatus = 'open' | 'completed' | 'deferred' | 'withdrawn' | 'orphaned';
export type ChildStatus = 'open' | 'closed-completed' | 'closed-not-planned' | 'superseded' | 'deleted';
export type Ledger = Array<{ id: string; text: string; owner: number | null; status: CriterionStatus; cite?: string; waitsOn?: number }>;
export type Cut = { seam: Seam; higherRungs: Array<{ seam: Seam; why: string }>; relation: Relation;
  state: 'complete' | 'partial' | 'inadmissible'; deferred: Array<{ criterion: string; waitsOn: number }>;
  pieces: Piece[]; groundwork: Array<{ what: string; owner: number }>; width: { instances: string[]; perInstance: string } | null;
  balance: string; independence: string };
export type Piece = { kind: 'author' | 'child' | 'reference'; title?: string; body?: string; number?: number; points: number | null;
  role: 'work' | 'spike'; criteria: string[]; dependsOn: number[]; order: number; orderRung: OrderRung };
export type Record = { generation: number; state: 'applying' | 'live' | 'released'; verdict: string; cut: Cut | null;
  children: Array<{ number; piece: number; kind; link: 'sub-issue' | 'blocker'; points; order; orderRung; dependsOn: number[]; status: ChildStatus; paused: boolean }>;
  ledger: Ledger; revisits: number; seen: Fingerprint; at: string };
export function renderRecord(r: Record): string;   // `<!-- carve-record gen=N state=S -->`, a fenced json block holding r, then the human table
export function parseRecord(comment: Comment, botLogin: string): Record | null;  // marker, author, and JSON must all check; else null and a log line
export function renderChildBody(trunk, generation, index, piece): string;  // first line links the trunk and the record; marker `<!-- carve parent=N gen=G piece=I -->`; headings Scope, Acceptance, Proof
export function buildLedger(previous: Ledger, record: Record, tree: Tree): Ledger;   // the transition table in the-record.md; ids carried forward by text match
export function pauseSet(record: Record, affected: string[]): number[];   // owners of the affected criteria plus their dependents along dependsOn

// carve-github-issue/lib/carve.ts
export type Carving = { issue: number; mode: 'carve' | 'revisit'; verdict: CarveVerdict | RevisitVerdict; reason: string;
  criteria: Array<{ id; text }>; ledger: Ledger; chosen?: number; cuts?: Cut[];
  supersedes?: Array<{ old: number; replacements: number[]; reason: string }>; affected?: string[] /* criteria a hand-off touches */ };
export type CarveVerdict = 'carve' | 'small-enough' | 'indivisible' | 'too-uncertain' | 'nothing-left';
export type RevisitVerdict = 'still-good' | 'amend' | 'exhausted' | 'indivisible' | 'too-uncertain';
export type Confirmation = { issue; mode; agree: boolean; finding: 'cover' | 'gap' | 'overreach' | 'partition-intact' | 'partition-broken'
  | 'still-good' | 'not-still-good' | 'exhausted' | 'not-exhausted' | 'hand-off-agree' | 'hand-off-disagree'; seam: 'agree' | 'higher-available'; seamCase: string; reason: string };
export type CarveKnobs = { ceiling; maxDepth: 3; maxChildren: 8; maxCarveRounds: 5; maxCarveAttempts: 3; maxGenerations: 5;
  maxRevisitsPerGeneration: 10; seats: { carver: Seat; confirmer: Seat } };   // the callbacks directory is the config's top-level callbacksDir, shared with the size callbacks
export type Journal = { issue; generation; status: 'open' | 'done' | 'abandoned'; steps: Array<{ name: JournalStep; target?: number; done: boolean }> };
export type JournalStep = 'claim' | 'applying-record' | 'create' | 'adopt' | 'reference' | 'edge' | 'supersede' | 'pause' | 'unpause' | 'live-record'
  | 'gen-label' | 'carved-label' | 'counters' | 'hand-off-comment' | 'hold-label' | 'callback' | 'released-record' | 'release-size' | 'release-label' | 'release-counters' | 'unclaim';
export type CarveOutcome = { outcome: CarveVerdict | RevisitVerdict | 'busy' | 'resumed' | 'failed'; reason: string; generation?: number; children?: number[] };
export async function carveIssue(ctx: Context, issue: Issue, knobs: CarveKnobs): Promise<CarveOutcome>;
```

The record's grammar: the marker line, one fenced `json` block holding the `Record` object verbatim, then a Markdown table for people. `parseRecord` reads only the JSON; the table is derived. The newest comment by `ctx.botLogin` with a valid marker and JSON is the latest record; anything else on the thread is not a record. Roll-ups (`<!-- carve-rollup child=N event=E at=T -->`), claims (`<!-- carve-claim kind=K run=R at=T -->`), releases (`<!-- carve-unclaim kind=K run=R -->`), and hand-off comments carry markers too; the fingerprint excludes every comment that carries a marker, by marker and not by author, so a person using the same account is still heard.

Criterion ids are stable across generations: the carver receives the previous ledger and reuses an id when a criterion's text matches or is a plain edit of the old text; a criterion that vanished from the thread becomes `withdrawn` citing the edit; new text gets a new id; the confirmer checks the mapping.

## The carver's answer

`loop-carving.json`, a `Carving`, written in the scratch directory. Programmatic validation owns everything mechanical and rejects the file whole on any miss; the confirmer owns meaning.

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
      "seam": "domain", "higherRungs": [], "relation": "layers", "state": "complete", "deferred": [],
      "pieces": [
        { "kind": "author", "title": "…", "body": "…", "points": 5, "role": "work", "criteria": ["A1", "A2"], "dependsOn": [], "order": 1, "orderRung": "source-of-truth" },
        { "kind": "reference", "number": 1240, "points": null, "role": "work", "criteria": ["A3"], "dependsOn": [0], "order": 2, "orderRung": "dependency" }
      ],
      "groundwork": [{ "what": "authors table migration", "owner": 0 }],
      "width": null, "balance": "5 and an existing 3; uneven but each is one thing", "independence": "share the migration; the second depends on the first"
    },
    { "seam": "tier", "higherRungs": [{ "seam": "domain", "why": "…" }], "relation": "layers", "state": "inadmissible", "deferred": [], "pieces": [], "groundwork": [], "width": null, "balance": "", "independence": "three layers of one entity are not separately provable" }
  ]
}
```

A revisit answer has the same envelope with `"mode": "revisit"`; `still-good` and `exhausted` carry `criteria` and `ledger` and no `cuts`; `amend` carries `cuts`, `chosen`, and `supersedes`. A hand-off in either mode carries `verdict`, `reason`, `ledger`, and `affected`, the criteria the question touches, from which the pause set is computed.

- `criteria` is the inventory of the parent's acceptance criteria, numbered, taken from the whole thread. In the ledger every criterion is owned by exactly one piece, or `deferred` with the spike it waits on, or `withdrawn` with the comment cited. This is the 100% rule made checkable.
- `mode` is set by the knife from the latest record, and an answer in the other mode is rejected.
- `kind` is `author` (a new issue), `child` (an issue already in this trunk's tree, adopted as the piece: closed ones complete their criteria, open ones own them), or `reference` (an issue outside the tree: open ones are attached if they have no parent and depended on otherwise; one closed `COMPLETED` completes its criteria as a `closed-completed` reference). A `reference` inside the tree is rejected; that is what `child` is for.
- For a chosen cut below `domain`, `higherRungs` names every rung above it with a non-empty reason it did not apply or was inadmissible; a lower cut is invalid while a higher one is admissible. Unchosen cuts may be `inadmissible` with empty pieces.
- A `carve` or `amend` requires 2 to `maxChildren` pieces (1 allowed when `state` is `partial` and the piece is a spike), every authored piece's `points` on the scale and at most the ceiling, `dependsOn` acyclic, `order` a permutation consistent with `dependsOn`, every authored body carrying the headings Scope, Acceptance, and Proof, every groundwork item owned by exactly one piece, every `supersedes.old` a child of the latest record, and the trunk's `subIssuesSummary.total` plus authored pieces plus references that will be attached at or under 100.
- `width`, when present, makes the pieces chunks, the relation `shards`, and the confirmer's finding a partition one.
- `small-enough` is the carver disputing the size; `nothing-left` is the carver finding every criterion `completed` or `withdrawn` in carve mode. Both are disagreements with the appraiser and go to a person.

## The confirmer's answer

`loop-confirmation.json`, a `Confirmation`. The confirmer sees the parent's whole thread, every child's thread on a revisit (closed ones included), the chosen cut only, the criteria inventory and ledger, the previous ledger when there is one, and the seam list. On a `carve` or `amend` it checks: every criterion in the inventory is real and none is missing from the thread; ids carried forward correctly; cover, or partition integrity for a width cut; mutual exclusivity; one owner per criterion; each piece has one outcome and proof available at its close; the base is usable after each piece lands in its stated order; dependencies are necessary and minimal; every groundwork item has one owner and no groundwork piece lacks a named consumer; an adopted or referenced issue really is the piece it stands in for; proposed sizes include tests and proof; a partial cut's deferred criteria are exactly the ones the spike's questions decide. On `still-good` it checks the ledger against the tree and rejects when any criterion is `orphaned`, or `deferred` while its spike is closed. On `exhausted` it checks that every criterion is `completed` by a child or reference closed `COMPLETED`, or `withdrawn` by a comment it can find, and that no recorded dependency is open. On a hand-off it checks the reason against the thread and that `affected` is exactly the criteria the question touches.

`agree` is true only for `cover`, `partition-intact`, `still-good`, `exhausted`, or `hand-off-agree`, with `seam: agree`. A seam dispute is allowed only when the higher seam the confirmer sees is `domain` or `tier`; between mechanistic rungs any admissible covering cut ships and the alternative is noted in `seamCase`. A dispute of any kind goes back to the carver with the confirmer's case as feedback. `maxCarveRounds` (default 5) is the maximum number of carver-confirmer pairs; the fifth disagreement hands off, so at most five carver turns and five confirmer turns run. On reaching the cap the trunk goes Held with the whole exchange on the thread.

## Normalization

Before any piece is authored, the carver matches every piece against the trunk's own tree first (`child`), then the backlog, open and closed (`gh issue list --state all --search` with the piece's nouns; a match is one the carver would defend as the same ask, and the confirmer checks it). An open `reference` with no parent is attached with `gh issue edit <n> --parent <trunk>`; one that already has a parent stays where it is and the trunk gets `--add-blocked-by <n>`; a `reference` closed `COMPLETED` is recorded as `closed-completed` and completes its criteria; a match that would close a `blocked-by` cycle is rejected and the piece is authored instead. Immediately before apply the fingerprint is re-read and compared with the one the carver started from; any difference restarts from the carver. An adopted or referenced issue that already carries a size keeps it.

## What lands on the tracker

Every write below is a journal step and a tracker-visible one. A generation opens with an `applying` record that holds the accepted cut, so any machine can finish it; the local journal only remembers which steps this machine already saw done. On any entry to a trunk the knife first finishes what a crash left, in this order: an `applying` record without its `live` successor (finish the writes from the record, then revisit at once, pausing every new child if the trunk gained a hold meanwhile); a `released` record with labels still on (finish the release); a stale claim (clear it with a comment). Then it proceeds.

| Verdict | Trunk | Children |
|---|---|---|
| `carve` or `amend`, confirmed | claim; `applying` record; authored children created in delivery order; children adopted; references attached or depended on; edges; superseded children with no work started closed `not planned` with a pointer to their replacements; `live` record; `loop/carve-gen: N`; `loop/carved`; counters cleared; unclaim | authored pieces via `gh issue create --parent`, body from the template, `spike` label on spikes, no size label; `loop/paused` lifted from any child the record paused |
| disputed past the round cap | claim; `live` record with the verdict; `needs-human`; comment with the last cut and the confirmer's case; `on-carve-fail`; unclaim | none |
| hand-off, confirmed | claim; `live` record with the verdict and the pause set; comment; the hold label; `loop/paused` on the pause set; unclaim | the paused leaves wait; the rest keep working |
| `still-good`, confirmed | claim; `live` record with the ledger, `revisits`, and the pause set (empty unless the trunk is Held); unclaim | pauses lifted or applied to match the record |
| `exhausted`, confirmed | claim; `released` record linking every closed child; size label off; `loop/carved` off; counter labels off; unclaim; then the appraiser is run on it directly with the burndown's appraisal options and the age window disabled | none |

"Work started" on a child means any of: a live `loop/working` claim, an open pull request referencing it, an assignee, or a `loop/*` label. A superseded child with any of those is kept and adopted as a piece of the new cut instead of closed.

Spike proof: the worker writes `answer` in its verdict file; the driver runs `confirm-answer.md` on the confirmer seat (does the evidence answer the questions the spike's body asks); on agreement the driver posts the answer with a marker naming the issue and closes with `kind: answered`; on disagreement it parks the leaf as `needs-human` with both opinions. `already-fixed` and `obsolete` from a worker go through `confirmClose` the same way, and the confirmer's engine must differ from the worker's.

## The carving record

Rendered by `record.ts` and posted as one comment; the shape is in Interfaces and the grammar in `references/the-record.md`. Beyond the cut, it carries the ledger, the `revisits` count for this generation, each child's `paused` command, and `seen`, the fingerprint at the moment it was written. The child body's first line points at the trunk and says to read the record; a worker with a parent reads it before starting, and learns whether its leaf is a shard that touches nothing or a layer that assumes the schema child landed.

The ledger's transitions, one row per event, are the contract in `references/the-record.md`: a child or reference closed `COMPLETED` completes its criteria; closed `NOT_PLANNED` or deleted orphans them; a completed child reopened reopens them; a superseded child reopened is an unexpected open child the revisit must adopt or hand off; a spike closed makes its deferred criteria `open` and unowned, which only an `amend` can settle; a withdrawn comment removed reopens the criterion; a child whose body changed since the record is re-judged by the confirmer at the next revisit. Supersession moves criteria to the replacement as `open`; `superseded` is a child status, not a criterion status.

## Ordering

Two ladders, both conceptual-first with the mechanistic rung last, both search orders that fall through when a rung does not discriminate.

Seams: domain, tier, route, area, file, unit, material. The larger the issue, the more the cut must be conceptual; the smaller, the more freedom to cut mechanistically, because at small sizes that may be the only axiom left. Severability outranks symmetry; symmetry is a tie-breaker.

Delivery order within one cut: hard dependency; closeness to the source of truth (definitions, schema, types, tables, API objects; then persistence; then the view); uncertainty and risk; size. The confirmed `order` in the newest record is canonical; issue numbers never encode order. The burndown reads the order from the record for candidates that have a parent (one `gh issue view` per trunk, cached per run) and sorts a trunk's leaves by it, contiguous, in the position the trunk's newest leaf would have had; the rest of the backlog stays newest-first. Order is a dispatch preference; only an edge is a hard constraint, and the carver emits an edge wherever a later piece cannot land before an earlier one. The live gate honours an edge whether it is still on the tracker or only in the record.

## Guards

- **Depth.** The root is depth 0; an issue at depth d is carvable iff d < `maxDepth` (default 3). At the cap the issue is `indivisible` with the depth stated. GitHub's limit is eight.
- **Fan-out.** `maxChildren` (default 8) per cut, and the trunk's `subIssuesSummary.total` plus authored pieces plus references to be attached at or under 100.
- **Floor.** No child under the scale's smallest rung, none over the ceiling, none without its own acceptance and proof. A file, unit, or material cut is admissible only when the physical boundary also owns one change or one reviewable outcome.
- **Counters.** Every cap in this plan trips on reaching N. `loop/carves: N` and `loop/appraisals: N` in the pattern of `loop/reviews: N`, incremented on a `failed` outcome only, cleared as a journal step of a confirmed verdict; `repairDurableState` takes the caps as a parameter and repairs all three. `loop/carve-gen: N` is the generation high-water mark; the knife trusts the larger of the label and the record. `maxGenerations` (5) per trunk; `maxRevisitsPerGeneration` (10), counted in the record. When a person removes a hold from an issue whose counter sits at its cap, the sweep clears that counter before anything else runs; the removal is the reset. The revisit cap is a known unknown: how often a healthy trunk is revisited is unmeasured, the record makes it measurable, and `references/operating.md` says to raise it or rethink the trigger if trunks reach it routinely.
- **Claims.** The knife adds `loop/carving` and posts a claim comment, then re-reads; if an earlier unreleased, unexpired claim of either kind by another run exists, it posts its own release marker, removes nothing else, and returns `busy`. The worker does the same with `loop/working` after the live gate, and its terminal outcome releases it. A claim is stale when older than its holder's bound (the knife: `AGENT_TIMEOUT_MS` times `2 * maxCarveRounds`; a worker: the pipeline's own agent and checks timeouts summed); the sweep clears a stale claim with a comment, and the stranded pass clears a worker's claim as it resumes or abandons the lane. The local `carve-<n>.lock` stays as the cheap first check on one machine.
- **Time.** The knife bounds itself: every agent turn has the runtime's 45-minute cap and rounds are capped, so a carve terminates by construction. The size callback that invokes it runs with no outer timer by default (`sizeCallbackTimeoutMinutes: 0`, validated as a non-negative integer); the burndown's shutdown kills its process group.
- **The worker's live gate and landing checks.** Immediately before spawning, `fixIssue` re-reads the issue and returns `left-alone` when it is Closed, Held, a Trunk, Oversized, or Blocked, and `busy` when a foreign claim is live; then it claims. Immediately before merge and before close the pull master re-reads the same and, on any refusal, parks the pull request with the reason and releases the claim.

## Revisit triggers

- **Inside the loop.** `closeIssue` awaits `ctx.onClosed(event)` after the close, so every close path (the fix pipeline, stranded resume, reconciliation, the appraiser) fires it; a throw is logged and never changes an outcome. The burndown's hook: if the closed issue has a parent, post the roll-up on the trunk (its marker keyed by child, event, and `closedAt`), skipping one the thread already carries; then `carveIssue` on the trunk, at most once per trunk per run (an in-process set; later closes in the same run are seen by the next sweep); after a confirmed `exhausted`, `appraiseIssue` on the trunk with the burndown's appraisal options and the age window disabled. A closed parent is logged and left alone.
- **Outside the loop.** The sweep runs after stranded-pull-request resume, under the loop lock, and in a dry run only logs. Two passes, both through `gh api --paginate`. First, every open issue labelled `loop/carved`, `loop/carve-gen: *`, or `loop/carving`: finish unfinished generations and releases; clear stale claims; clear a tripped counter when the hold is gone; then `needsRevisit(record, tree)` decides, and a trunk with no record at all is handed to the knife as a difference. Second, every open issue that is not in the first pass, not Held, not Claimed, and either sized over the ceiling or with an open child, is handed to the knife. The second pass is the repair path for a lost callback, a trunk that lost both labels, and a released trunk with a reopened child. A third check in the same pass hands a root leaf whose blocker closed `NOT_PLANNED` to a person with `needs-human`.

## The seams reference

`references/seams.md` is the skill's methodology and is written for the carver. Its sections, in order:

1. **Why this ladder differs from the canon.** The story-splitting canon (Lawrence, Cohn, Cockburn) writes cards for people who slice below the card privately, so a card can stay a vertical story and horizontal cuts are called a smell. Here the card is the unit an agent works, so the slice that would have been private is written down. Horizontal cuts happen either way; the only question is whether the tracker records them.
2. **The ladder**, one paragraph per rung: what the seam is, when it applies, what a child cut on it looks like, and its admissibility condition. Domain first because a child cut there is provable on its own; tier keeps its rung because a client-side application with its own state has a real contract at the boundary with its backend, and the admissibility gate ("each tier child provable on its own") does the work a ban would; material last because it is blind to what the work means and is right only for width. A cut below domain must say, for every higher rung, why it did not apply.
3. **The axioms.** Seam order matters more as size grows, and the converse: the smaller the issue, the more freedom to cut mechanistically. Severability outranks symmetry; symmetry is a tie-breaker. The ladder is a search order, not a trump card.
4. **Normalization.** Inventory the criteria and the pieces first (an issue that is a list of unrelated asks becomes one piece per ask), adopt what the tree already has, reference what the backlog already has or already finished, author only what is missing, re-read before apply.
5. **Floor and ceiling.** Too large: still divisible or parallelizable. Too small: the issue costs more to write than to do; operationally, a child without its own acceptance and proof, or under the scale's smallest rung.
6. **Width.** Recognize it (one criterion, many instances); it is a partition, not a count: a stable, deduplicated manifest, each instance in exactly one chunk, the same acceptance per chunk, shared tooling owned by one chunk. The mechanistic rungs are the right cut here because the instances are interchangeable.
7. **Shared groundwork.** Name it per cut and give each item one owner: the earliest piece that exercises it, or its own piece only when it exposes a stable interface with its own proof and a named consumer.
8. **Dependencies and delivery order.** Partition by deliverable first, derive order second. A dependent child must still be acceptable on its own once its prerequisite exists; keep the critical path short. The ordering ladder: hard dependency, source of truth, risk, size; "smallest useful slice first" is a heuristic that usually lands on the risk rung by accident and must not be applied over a dependency. The scoring order for choosing among admissible cuts: seam rank, severability, balance, independence, size within bounds, child count, each consulted only when the one before it ties.
9. **Hand-offs, spikes, and pauses.** `indivisible` is a verdict (we know it cannot be cut here); `too-uncertain` is a pending state (a person has not decided); the two are never blurred. A technical unknown is a `spike` piece whose acceptance is the questions answered; a partial cut lists the deferred criteria and the spike answer each waits on, so the spike plus the deferred list still accounts for the whole parent. A question on a trunk pauses exactly the leaves that own the criteria it touches and their dependents along recorded edges; the rest keep working.
10. **Revisits.** Every child close is followed by a re-check of the trunk; the ledger classifies every criterion; `exhausted` requires every criterion completed or withdrawn and no open dependency; a better cut found later is a re-carve, and children with work started survive it as adopted pieces; an answered question may require a rollback piece for work that landed on the old premise; generations and revisits are capped.
11. **Non-code pieces.** Design, docs, migrations, operations are valid when each names a deliverable and its evidence; an unresolved preference is a hand-off, not a design piece.
12. **Other people's seams**, mapped onto the ladder: Lawrence's nine patterns and his two selection rules (severability, then equal size); Cohn's SPIDR (paths and rules are domain seams, interface a tier seam, spike the technical unknown); Cockburn's Elephant Carpaccio (why domain outranks tier); Parnas (a boundary that hides one decision is the admissibility test for the low rungs and the independence criterion); the WBS 100% rule (the ledger) and 8/80 (floor and ceiling in hours); Google's small-CL guidance (stacked, per-file, horizontal, vertical; a horizontal cut is fine when a stable stub lets each side land alone); Adzic's hamburger method (technical steps when no vertical cut exists); Asthana et al. 2026 (validation gates between sub-tasks, and retrying only the failed phase, which is the journal).

## Scope boundaries

Named here so the lifecycle's claims are read with them.

- **A person who deletes records, markers, or `loop/*` labels is acting.** The knife trusts the larger of the label and the record for generations and counters, and treats a missing record as a difference; it does not defend against deliberate removal of both, which is a person's choice and shows on the thread.
- **The age window** (`ageDays`) is the burndown's existing scope: an issue older than the window is not selected for appraisal or work unless named or `--all`. Trunks, their children, and released trunks are exempt through the sweep and the hook; other old issues are as they were.
- **Dirty-lane recovery** (a worker that modified its worktree and died before a pull request) stays as the fix pipeline's reconciliation leaves it, "for inspection" in the run log; the stranded pass now also releases such a lane's claim so the leaf is not stuck Claimed.
- **Cross-repository sub-issues** are not used; every child is created in the trunk's repository.

## Commits

`<skills>` below is the checkout of this collection; the adopting repository is the checkout holding `burn-down-github-issues.config.ts` from which a gate is run, with `[carve-test]` fixture issues created by the gate (`gh issue create --title "[carve-test] <what>" --body "<criteria>" --label "size: <n>"`) and closed afterward, children included (`gh issue list --search "[carve-test]" --state open --json number` then `gh issue close`). Every commit leaves the burndown runnable, and no commit lets a trunk reach a worker.

### Commit 1: widen the shared runtime

**Goal:** Everything in `fix-github-issue` and `appraise-github-issues` the knife and its gates need, before the skill exists.

**Files created:**
- `skills/fix-github-issue/lib/fixture-runner.ts`: reads `LOOP_ROLE`, copies `argv[3]` to the role's control file in `argv[2]`, exits 0.
- `skills/fix-github-issue/prompts/confirm-answer.md`: the second engine reads the spike's body and the proposed answer, checks each question has evidence a stranger could re-check, and writes `loop-confirmation.json` with `agree` and `reason`.

**Files rewritten:**
- `skills/fix-github-issue/lib/engines.ts`: `fixture` and `fixture2` as in Interfaces.
- `skills/fix-github-issue/lib/agent.ts`: `clearsByRole.carver = [CARVING_FILE, LAST_MESSAGE_FILE]`; `LOOP_ROLE` in the child environment.
- `skills/fix-github-issue/lib/callbacks.ts`: `runCallback(dir, name, payload, log, options?: { timeoutMs?: number })`; default 60 s; `0` means no timer; the process starts in its own group (`setsid` when present, as `agent.ts` does), is added to `children`, drains both pipes concurrently, is removed from `children` on exit, and is killed by group on timeout or shutdown.
- `skills/fix-github-issue/lib/control-files.ts`: `CARVING_FILE = 'loop-carving.json'`.
- `skills/fix-github-issue/lib/shell.ts`: `mutate` pushes `description` onto `ctx.dryRunLog` in a dry run.
- `skills/fix-github-issue/lib/context.ts`: `CloseEvent`, `onClosed`, `dryRunLog`, `botLogin` as in Interfaces; `createContext` resolves `botLogin` once (`gh api user --jq .login`; empty in a dry run).
- `skills/fix-github-issue/lib/config.ts`: `pointScale`; `nonNegativeIntegers`; `blocks`.
- `skills/fix-github-issue/lib/labels.ts`: `ensureLabels` adds `loop/carved` (`5319e7`, "Carved into sub-issues; worked by closing them"), `loop/carving` (`5319e7`, "A carve is in progress; other runs wait"), `loop/working` (`1d76db`, "A worker has this issue; other runs wait"), `loop/paused` (`fbca04`, "Paused by its parent while a question is open"), `spike` (`0e8a16`, "Answer a question with evidence; no pull request"); the counter functions and `repairDurableState` as in Interfaces; `closeIssue` becomes async, takes the event, awaits `ctx.onClosed`.
- `skills/fix-github-issue/lib/pipeline.ts`: `Issue` tree fields, optional; `answered` and `answer`; `settleTerminalVerdict` becomes async and runs `confirmClose` (exported from the appraiser) for `already-fixed` and `obsolete` and `confirm-answer.md` for `answered`, closing on agreement with `kind: closed` or `answered` and parking as `needs-human` with both opinions on disagreement; every `closeIssue` call site passes its event and awaits; `fixIssue` takes `confirmer` and `ceiling`, runs the live gate, claims `loop/working` with a marker comment, and releases the claim in a `finally`; `land` re-reads topology before merge and before close and parks on refusal; `assertDistinctEngines(worker, confirmer)`.
- `skills/fix-github-issue/lib/resume.ts`: `findStranded` and `resumeStranded` re-read topology before landing and release a stale `loop/working` when abandoning a lane; `reconcile` releases the claim of any lane it leaves for inspection.
- `skills/fix-github-issue/fix.ts`: `--confirmer` (config `seats.confirmer`); prompts dirs include `../appraise-github-issues/prompts`; the issue view requests the tree fields.
- `skills/fix-github-issue/prompts/triage-and-fix.md`: when the issue has a parent, read the parent's thread and its latest carving record before starting; when the issue carries `spike`, run the experiments its body names, put the answers with evidence in `answer`, and return `answered`; the verdict schema gains both.
- `skills/appraise-github-issues/lib/appraise.ts`: `sizeCallbackTimeoutMinutes` (default 0) threaded to `runSizeCallback`; `allOpenIssues` paginates; `selectForAppraisal` skips issues with a live record or an open child; `appraiseIssue` refuses such an issue even when named; a hand-off's comment and label are one journaled step in `runs/appraise-<n>.json`, finished on the next visit; a `failed` appraisal records `loop/appraisals: N` and on reaching `maxAppraiseAttempts` (3) parks the issue with the log tail; `confirmClose` exported with the signature `(ctx, issue, verdict, comment, confirmer, say)`.
- `skills/appraise-github-issues/appraise.ts`: passes the timeout and the cap.
- `skills/appraise-github-issues/lib/callbacks.ts`: `SizePayload.repoRoot`; the timeout parameter.
- `skills/appraise-github-issues/prompts/appraise.md`: the age-window sentence reads "when the driver applies a window it is `{{AGE_DAYS}}` days; `any` means no window".
- `skills/appraise-github-issues/references/callbacks.md`: the field and the timeout.

**Gate:** `bunx tsc --noEmit -p <skills>` passes and `bun test <skills>` passes. From the adopting repository, capture `bun run <skills>/appraise-github-issues/appraise.ts --dry-run` and `bun run <skills>/burn-down-github-issues/loop.ts --dry-run` before and after the commit and diff them: only timestamps differ. Create a `[carve-test]` issue labelled `spike` and `size: 1`; `bun run <skills>/fix-github-issue/fix.ts --issue <it> --worker fixture:<a loop-verdict.json with answered and an answer> --reviewer fixture2:<any> --confirmer fixture2:<a loop-confirmation.json with agree true>` posts the answer, closes the issue with `stateReason` `COMPLETED`, and leaves no `loop/working`; repeat with a confirmation file answering `agree: false`: the issue is `needs-human` and open.

### Commit 2: the tree and the record, and the burndown reads them

**Goal:** The parsers exist, and the loop never works a trunk, a paused leaf, or a blocked leaf, works a trunk's leaves in recorded order, and never closes a trunk by reconciliation, before any trunk exists.

**Files created:**
- `skills/carve-github-issue/lib/tree.ts`, `skills/carve-github-issue/lib/record.ts`: as in Interfaces.
- `skills/carve-github-issue/lib/carve.test.ts` (first part): `parseRecord` round-trips `renderRecord`; rejects a wrong author, a missing marker, malformed JSON; `buildLedger` on inline fixture trees for every row of the transition table, including id carry-forward; `fingerprint` excludes marker comments and `loop/*` labels; `needsRevisit` for each fingerprint field; `pauseSet` on a layered cut; `liveClaim` with released, expired, and foreign claims.
- `skills/carve-github-issue/references/the-record.md`: the grammar, the JSON shape, the fingerprint, the ledger transition table, the readers.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: `allIssues`, `selectCandidates`, `openPullRequestIssueRefs`, and `reconcileMergedPullRequests` paginate through `gh api` and request the tree fields; `selectCandidates` drops issues labelled `loop/carved`, `loop/carve-gen: *`, `loop/carving`, `loop/working`, or `loop/paused`, issues with an open child, and issues with a blocker (tracker or record) not closed `COMPLETED`, logging each exclusion with its rule; candidates with a `parent` are grouped contiguously at the position of the group's newest member and sorted within the group by the trunk's latest record (missing record: by number ascending); `reconcileMergedPullRequests` skips issues with a live record or an open child, re-reads the issue immediately before closing, and uses `issueRefs(prs, 'closing')`, which matches only `(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved) #N`, case-insensitive.
- `skills/burn-down-github-issues/status.ts`: `Stage` gains `carved` (🔪), `revisited` (🔁), `released` (🪵) and the emoji map entries.
- `skills/burn-down-github-issues/references/architecture.md`: the selection and reconciliation rules.

**Gate:** `bunx tsc --noEmit -p <skills>` passes and `bun test <skills>` passes; from the adopting repository, `bun run <skills>/burn-down-github-issues/loop.ts --dry-run` prints the same candidates as the Commit 1 capture and logs the new exclusions with zero hits.

### Commit 3: the knife's library, prompts, and tests

**Goal:** `carveIssue` works end to end under test and in dry run; no command yet.

**Files created:**
- `skills/carve-github-issue/lib/carve.ts`: `CarveKnobs`, `CARVE_DEFAULTS`, `assertDistinctEngines`, `validateCarving`, `validateConfirmation`, `normalize`, `claim` and `unclaim`, `finishGeneration` (from an `applying` record), `finishRelease`, `applyGeneration`, `carveIssue`: local lock; read tree; finish unfinished work; guards and counters; mode from the latest record; claim; run carver; validate; re-read the fingerprint; confirm with rounds; apply; callbacks; clear or record the counter; unclaim and unlock in `finally` (a `busy` outcome releases only its own claim marker). `CarveOutcome` as in Interfaces. `--fail-after` is honoured here by `process.exit(70)` immediately after the named step, bypassing `finally` on purpose, so the next run must repair.
- `skills/carve-github-issue/lib/callbacks.ts`: `runCarveCallback(dir, 'on-carve-pass' | 'on-carve-fail', payload, log)`; `on-carve-pass` after a confirmed `carve`, `amend`, `still-good`, or `exhausted`; `on-carve-fail` after a hand-off or the round cap; payload `{ issue, title, mode, verdict, generation: number | null, seam: Seam | null, relation: Relation | null, children: number[], superseded: number[], paused: number[], reason, repo, baseBranch, repoRoot }`.
- `skills/carve-github-issue/prompts/carve.md`, `revisit.md`, `confirm-carve.md`: as described under the answers; the carver prompts load `references/seams.md` by path and receive the previous ledger when there is one; the confirmer prompt is rendered with the round number and, after the first round, the carver's reply.
- `skills/carve-github-issue/references/seams.md`: see "The seams reference".
- `skills/carve-github-issue/references/lifecycle.md`: the states, transitions, invariants, counters, claims, and the board note from this plan's lifecycle section, kept as the skill's durable contract.

**Files rewritten:**
- `skills/carve-github-issue/lib/carve.test.ts` (second part): `validateCarving` (every enum, bounds, cycles, order consistency, headings, criterion ownership, `higherRungs` non-empty below domain, `supersedes.old` against a record, `reference` inside the tree rejected, fan-out with attached references, `affected` present on a hand-off), `validateConfirmation` per mode and finding, `depthOf` at the boundary, `finishGeneration` from an `applying` record with some children present, `finishRelease` from each interrupted step, the counters' thresholds and that `busy` does not count, the revisit and generation caps, the hold-removal reset; and a driven run of `carveIssue` with a dry-run context and fixture seats through a full carve, a disputed carve to the cap, a `still-good`, a hand-off with a pause set, and an `exhausted`, asserting `ctx.dryRunLog` and the journal.

**Gate:** `bunx tsc --noEmit -p <skills>` passes and `bun test <skills>` passes.

### Commit 4: the `carve.ts` command

**Goal:** The skill runs standalone.

**Files created:**
- `skills/carve-github-issue/carve.ts`: `--issue N` (required), `--dry-run`, `--ceiling N`, `--carver`, `--confirmer`, `--fail-after <step>` (refused unless `CARVE_DEV=1`); reads `carve-github-issue.config.ts`, else `burn-down-github-issues.config.ts` (ceiling from `maxPoints`, seats from `seats`, the `carve` block through `blocks: ['carve']` merged over `CARVE_DEFAULTS` and validated with `positiveIntegers`, `callbacksDir` from the top level); builds the context as `appraise.ts` does (`promptsDirs: [own prompts, ../appraise-github-issues/prompts]`, `invokeRoot`, `repoRoot`, the pipeline's seats and knobs from the same config); refuses same-engine seats; tees `runs/carve.log`; the same signal handling as `appraise.ts`; prints the outcome; exit code 0 for every confirmed verdict, 1 on `failed`, 3 on `busy`.
- `skills/carve-github-issue/SKILL.md`: what it does, trunk and leaves, normalization, the record, claims, the lifecycle in brief, run lines, dependencies, the ceiling paragraph (tracker as untrusted instruction channel; the carver and confirmer must be different engines, and even then their independence is model-level: both run as one GitHub account).
- `skills/carve-github-issue/references/adopting.md`: the `carve` config block (`maxDepth: 3, maxChildren: 8, maxCarveRounds: 5, maxCarveAttempts: 3, maxGenerations: 5, maxRevisitsPerGeneration: 10`), `seats.carver`, the labels, what lands on the tracker, the guards, the boundaries.
- `skills/carve-github-issue/references/callbacks.md`: the two slots, both forms, the payload.

**Gate:** `bunx tsc --noEmit -p <skills>` passes and `bun test <skills>` passes; from the adopting repository, with three `[carve-test]` issues labelled `size: 8` and bodies holding three criteria each: `bun run <skills>/carve-github-issue/carve.ts --issue <first> --dry-run` writes only the log; the same without `--dry-run` produces children attached in delivery order, edges, no size label on any child, an `applying` then a `live` record, `loop/carve-gen: 1`, `loop/carved`, no `loop/carving`, and a line from a scratch `on-carve-pass` executable in `callbacksDir`; the same on the second with `--confirmer fixture2:<a loop-confirmation.json answering gap>` logs five rounds, leaves the trunk `needs-human` with a `live` record, creates nothing, and runs `on-carve-fail`; the same on the third with `CARVE_DEV=1 ... --fail-after create` then a plain rerun finishes generation 1 from the `applying` record without a duplicate child.

### Commit 5: revisit on close, inside and outside the loop

**Goal:** Every leaf close is followed by a revisit of its trunk, and a question on a trunk pauses exactly the leaves it touches.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: supplies `ctx.onClosed` and the sweep as under Revisit triggers; passes `confirmer` and `ceiling` to `fixIssue`; the board marks `revisited` and `released`.
- `skills/burn-down-github-issues/references/architecture.md`: the revisit stage, the sweep, the pause.

**Gate:** `bunx tsc --noEmit -p <skills>` passes and `bun test <skills>` passes; from the adopting repository, on the trunk Commit 4 carved: `bun run <skills>/burn-down-github-issues/loop.ts --limit 1` works the first leaf by recorded order (with `loop/working` on it while it runs and gone after), posts one roll-up, and the revisit answers `still-good` with a record whose ledger shows one criterion completed and `revisits: 1`; comment a product question on the trunk and rerun with `--carver fixture:<a loop-carving.json answering too-uncertain with affected>`: the trunk is `needs-decision`, exactly the affected leaves and their dependents carry `loop/paused`, the others are still selected; remove the hold and rerun: the pauses lift; close the remaining leaves by hand and rerun: the sweep revisits, `exhausted` is confirmed, the labels come off in order, and the appraiser handles the trunk in the same run; remove `loop/carved` and `loop/carve-gen: 1` from a second carved fixture by hand, close its leaves, rerun: the second pass finds it and it is exhausted; reopen one closed leaf of the released trunk and rerun: the second pass hands it to the knife in carve mode and the reopened leaf is adopted, not re-authored.

### Commit 6: the shipped size callback

**Goal:** An issue sized over the ceiling is carved without the appraiser knowing the knife exists.

**Files created:**
- `skills/burn-down-github-issues/callbacks/on-size-over-ceiling`: a `#!/usr/bin/env bash` template whose second line is the ownership marker `# rendered by burn-down-github-issues; edits are overwritten`; reads stdin into a variable, extracts the issue number with `bun -e` from the JSON, and runs `bun run '{{CARVE_DIR}}/carve.ts' --issue "$issue"` from `'{{REPO_ROOT}}'` with single quotes and `'\''` escaping for the two substituted paths; exits with the knife's code.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: `placeSizeCallbacks` renders the template to `<callbacksDir>/on-size-over-<maxPoints>` by writing a temporary file and renaming it into place with the executable bit set, refusing to overwrite an unmarked file at that name and logging it; before that it removes any other regular file named `on-size-over-*` whose second line is the marker (directories and symlinks are left alone); in a dry run it logs what it would do and returns.
- `skills/burn-down-github-issues/callbacks/README.md`: the shipped callback, the rendering, the marker.
- `skills/burn-down-github-issues/SKILL.md`, `skills/burn-down-github-issues/references/adopting.md`, `skills/burn-down-github-issues/references/operating.md` (including the revisit-cap note), `README.md`: the carving stage, the `carve` config block and `seats.carver`, the labels, the skill row.

**Gate:** `bunx tsc --noEmit -p <skills>` passes and `bun test <skills>` passes; the adopting repository's config gains the `carve` block and `seats.carver` (that file is the adopter's, edited outside this repository); from there, `bun run <skills>/burn-down-github-issues/loop.ts --appraise-limit 1` on a fresh `[carve-test]` issue the appraiser sizes over the ceiling shows the callback firing and a carve log under `runs/`; change `maxPoints` and rerun `--dry-run`: the log names the re-render and an unmarked `on-size-over-99` placed by hand survives; for every touched `.md`: `grep -oE '\]\([^)]+\.md[^)]*\)' <file> | sed 's/.*(\(.*\))/\1/; s/#.*//' | while read -r p; do test -e "$(dirname <file>)/$p" || echo "broken: $p"; done` prints nothing.

### Commit 7: delete this plan

- Verify: every commit above shipped, the verification checklist green, both validation commands green.
- Propose deletion explicitly, naming the path `add-carve-github-issue.md` at the repository root, and wait for the developer's explicit confirmation.
- On confirmation, check the path ends in `.md`, is repository-relative, and exists in the working tree; then delete and commit the deletion alone.
- The methodology (`references/seams.md`), the lifecycle (`references/lifecycle.md`), and the record (`references/the-record.md`) are skill docs and stay.

**Gate:** `bunx tsc --noEmit -p <skills>` passes and `bun test <skills>` passes; `git grep -n add-carve-github-issue` is empty.

## Verification checklist

- [ ] `bunx tsc --noEmit -p <skills>` and `bun test <skills>` pass at every commit.
- [ ] Appraise and burndown dry runs from the adopting repository match the Commit 1 captures after Commits 1 and 2.
- [ ] One standalone carve produced attached children in delivery order, edges, no size labels on children, an `applying` then a `live` record, the generation label, `loop/carved`, and no lingering claim; one adopted or referenced issue where one matched.
- [ ] One forced dispute ran five rounds, left the trunk `needs-human` with a record, created nothing, and ran `on-carve-fail`.
- [ ] A crash injected after the first child resumed the generation from the `applying` record on the next run without a duplicate.
- [ ] One burndown run claimed a leaf with `loop/working`, worked it by recorded order, released the claim, posted one roll-up, and revisited `still-good` with the ledger and `revisits` updated.
- [ ] One question on a trunk paused exactly the affected leaves and their dependents; removing the hold lifted the pauses.
- [ ] One sweep revisited a trunk whose leaves were closed by hand, confirmed `exhausted`, released it, and the appraiser handled it in the same run.
- [ ] One trunk stripped of both labels by hand was found by the second pass and exhausted.
- [ ] One released trunk with a reopened leaf was carved afresh with the leaf adopted.
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

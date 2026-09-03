# Add `carve-github-issue`: erode oversized issues into sub-issues

**Status:** Draft
**Scope:** cross-stack
**Date:** 2026-09-02
**Last reviewed:** 2026-09-03
**Context:** The appraiser runs a size callback after every `valid` verdict, but nothing answers it: an issue sized above the burndown's ceiling is labelled and then sits, because no skill turns a 13 into an 8 and a 5.

## Goal

The burndown works issues at or under a ceiling (`maxPoints`) and never touches anything above it, so the hardest work in a backlog is exactly what the loop skips. `carve-github-issue`, the knife, takes one oversized issue and expresses it as GitHub sub-issues: it names the parts along the highest natural boundary the work has, matches each against the backlog so nothing is authored twice, and creates only what a second engine has confirmed covers the parent. The parent stays open and is worked by closing its children; every child close is followed by a re-check of the parent; a parent with nothing left goes back to the appraiser. A child still over the ceiling is carved again, so a 13 erodes into 3s. Done looks like: the knife carves or re-checks one issue on demand, the burndown invokes it over its ceiling and never works a parent, and every path a ticket can take ends in a merge, a confirmed close, or a person.

## Domain context

- **Seam.** A line along which one issue can be cut into children that each stand alone. Seams are ranked (domain, tier, route, area, file, unit, material; each a rung of the ladder) and searched from the top. A cut on any rung is admissible only if every child has one bounded outcome, its own acceptance and proof, and leaves the base usable after it lands; the ladder is a search order, not a trump card. The methodology is `references/seams.md`.
- **Piece.** One unit of the parent's work. A piece becomes a child by authoring a new issue, by adopting an issue already in the trunk's tree, or by referencing one from elsewhere in the backlog, open or closed. Normalization (inventory the parent's acceptance criteria, name the pieces, match each against the tree and the backlog, author only what is missing) is a step of every carve.
- **Trunk and leaves.** The parent is the trunk: open, carrying an unreleased carving record, never handed to a worker. Leaves are landable increments the burndown works; an interior node is a trunk of its own. The trunk commands its leaves through the record: their order, their edges, and which of them are paused while a question about the trunk is open. Trunk-first (a person doing the whole thing) closes many leaves at once; leaf-first (the loop) erodes the trunk. Nothing is lost either way, because the tracker holds the tree.
- **Carving record.** A comment with a fixed grammar posted on the trunk by the knife at every step that changes the carving: `applying` before the writes of a generation, `live` after them and after every revisit, `released` when the trunk is handed back to the appraiser. It carries the cut, the ledger (every acceptance criterion of the parent with its owner and status), the per-child commands, and a fingerprint of what the tracker looked like when it was written. The newest is authoritative; its grammar is `references/the-record.md`. Workers, revisits, and people read it.
- **Claim.** A label plus a marker comment that says a run is acting on an issue right now, honoured across machines: `loop/carving` for the knife, `loop/working` for a worker. Each stands off the other. A claim carries its own expiry, its holder renews it while waiting, and one past its expiry is stale and cleared by the sweep.

## Domain categories

- **Cut.** One candidate decomposition along one seam: pieces, their relation, delivery order, shared groundwork with owners, and a reason for every higher rung not taken. The carver proposes a cut on every seam that applies and chooses one; the alternatives stay in its answer.
- **Cover.** The confirmer's verdict that the union of the pieces is the parent: no criterion unowned (`gap`), nothing the parent did not ask for (`overreach`). A width cut, one job over interchangeable instances, is judged for partition integrity instead (`partition-intact` or `partition-broken`).
- **Relation** of one cut's children: `shards` (disjoint slices of one job; any order; parallel), `layers` (each builds on the one before; source of truth first), `mixed` (edges listed per child), `waiting` (everything unlisted depends on a named spike). An edge is a `blocked-by` link on the tracker, recorded in the record as well so its removal by hand is visible.
- **Revisit.** The knife on a trunk whose latest record is `live`, asked one question: is this carving still good? It answers `still-good`, `amend`, `exhausted`, or a hand-off, and the second engine confirms the answer as it confirms a carve. The knife's mode is chosen from the latest record alone: `live` means revisit; none, or `released`, means carve; `applying` means finish that generation first.
- **Generation.** One carve or amend of a trunk, numbered from 1. The number is carried in every record, in the journal, in every authored child's marker, and on a `loop/carve-gen: N` label while the trunk is unreleased, so successive generations never match each other's children.
- **Intent.** Every transition that takes more than one tracker write is announced on the tracker before its first write by a marker comment (the `applying` record, a hand-off marker, a release record, a claim), so that any machine that finds the announcement without its completion finishes it. The local journal, `runs/carve-<n>-gen<g>.json`, only remembers which steps this machine already saw done.
- **Sweep.** The burndown's start-of-run pass that finishes announced intents, clears stale claims, and hands the knife every issue the tracker says needs it, so closes, edits, and holds made outside the loop are seen on the next run.
- **Roll-up.** The comment the loop posts on a trunk when one of its leaves closes: which leaf, how, when, and where the proof is.
- **Hand-offs.** `indivisible` (cannot be cut at this ceiling), `small-enough` (the carver disputes the size), and `nothing-left` (the carver finds every criterion done while the appraiser sized it as work) go to `needs-human`; `too-uncertain` (a product ruling nobody has made) goes to `needs-decision` with the question. A technical unknown is none of these: it becomes a `spike` piece, and the rest of the cut waits on it.
- **Scale.** The adopter's point scale, the values the config's `pointScale` array lists (the Fibonacci rungs by default). Every size in this plan is on it. The ceiling is the adopter's `maxPoints`; the burndown's own default is 2.

## Current surface area

| Where | What | Change |
|---|---|---|
| `skills/fix-github-issue/lib/engines.ts` :17-38 | `ENGINES` | `fixture` and `fixture2` engines for deterministic gates |
| `skills/fix-github-issue/lib/agent.ts` :203-210, :220, :243 | dry run, `clearsByRole`, child env | fixture seats run in a dry run; `carver` entry; `LOOP_ROLE` |
| `skills/fix-github-issue/lib/callbacks.ts` :22, :53-61 | `runCallback` | `timeoutMs` option (0 = none); process group; registered in `children` |
| `skills/fix-github-issue/lib/control-files.ts` | control-file names | `CARVING_FILE` |
| `skills/fix-github-issue/lib/shell.ts` :90 | `mutate` | records dry-run mutations on the context |
| `skills/fix-github-issue/lib/context.ts` :24-51 | `Context` | `onClosed`, `dryRunLog`, `botLogin` |
| `skills/fix-github-issue/lib/config.ts` :70, :192, :221 | `PipelineKnobs`, merge, validator | `pointScale` with a default; nested-block merge; zero-allowed knobs |
| `skills/fix-github-issue/lib/labels.ts` :16-75, :112, :144 | `ensureLabels`, counters, `repairDurableState`, `closeIssue` | new labels; carve and appraisal counters; caps as an optional parameter; async close with an event |
| `skills/fix-github-issue/lib/pipeline.ts` :27, :36-42, :67, :106, :421-503, :507-536, :572-586, :708-722 | types, landing, `settleTerminalVerdict`, `workIssue`, `fixIssue` | tree fields; `answered`; confirmed closes; live gate; worker claim before the lane; topology re-read before merge and before every close |
| `skills/fix-github-issue/lib/resume.ts` :31, :98, :166 | `reconcile`, `findStranded`, resume | stale `loop/working` released; topology re-read on resume |
| `skills/fix-github-issue/fix.ts` :86-122 | standalone command | `--confirmer`; the appraiser's prompts dir; tree fields |
| `skills/fix-github-issue/prompts/triage-and-fix.md` :147-166 | worker prompt and verdict schema | parent record; `answered` and `answer` |
| `skills/appraise-github-issues/lib/appraise.ts` :59-76, :127, :137-147, :203, :243-265, :286-326 | knobs, listing, selection, `confirmClose`, `appraiseIssue` | timeout knob; paginated listing; skip trunks; export `confirmClose`; attempt counter; refuse a trunk by name; hand-off intent marker; re-read before close; `ageDays: number \| null` |
| `skills/appraise-github-issues/appraise.ts` :215 | standalone caller | passes the timeout and the cap |
| `skills/appraise-github-issues/lib/callbacks.ts` | `SizePayload`, `runSizeCallback` | `repoRoot`; timeout passed through |
| `skills/appraise-github-issues/prompts/appraise.md` :23 | age-window sentence | conditioned on the window being in force |
| `skills/appraise-github-issues/references/callbacks.md` | ladder, forms, payload | field and timeout |
| `skills/burn-down-github-issues/loop.ts` :49-72, :87-93, :261-277, :436-470, :485, :497-545, :554-611, :624, :761-768, :775-835 | seats, defaults, line wait, config, listing, reconciliation, selection, claims, callbacks, repair call, `main` | carver seat; claim renewal while waiting on the line; tree fields; paginated listings; reconciliation guard; trunk, blocker, pause, claim, age rules; leaf order; rendered callback; sweep; hook wiring |
| `skills/burn-down-github-issues/status.ts` :11 | `Stage` and emoji map | `carved`, `revisited`, `released` |
| `skills/burn-down-github-issues/callbacks/README.md` | empty slot directory | the shipped callback |
| `skills/burn-down-github-issues/SKILL.md`, `references/{architecture,adopting,operating}.md` | | carving stage, revisit, selection rules, labels, the `carve` config block |
| `README.md` | skill table | row for `carve-github-issue` |

Forge facts (verified 2026-09-02 against `gh` 2.97.0): `gh issue create --parent N` creates a child already attached; `gh issue edit N --parent P` attaches an existing issue; `gh issue edit N --add-blocked-by M` and `--remove-blocked-by M` record and remove a dependency; `gh issue close N --reason "not planned"` sets `stateReason`; `gh issue list --json` and `gh issue view --json` expose `parent`, `subIssues`, `subIssuesSummary {total, completed}`, `blockedBy {nodes: [{number, state, stateReason}]}`, `blocking`, `stateReason`, `body`, `title`, `labels`, and `comments` (with `id`, `author`, `body`, `createdAt`); `gh api --paginate` walks any listing past a page, including `search/issues`; `gh api user` names the authenticated account; a comment is edited with `gh api -X PATCH repos/{r}/issues/comments/{id} -f body=`. GitHub allows 100 sub-issues per parent and eight levels of nesting; each issue has one parent.

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
    │   │   ├── ✏️ appraise.ts                   // timeout knob; paginated listing; skip trunks; attempt counter; export confirmClose; hand-off intent; re-read before close; nullable age
    │   │   └── ✏️ callbacks.ts                  // repoRoot in the payload; timeout passed through
    │   ├── prompts/
    │   │   └── ✏️ appraise.md                   // age-window sentence conditioned
    │   └── references/
    │       └── ✏️ callbacks.md
    ├── burn-down-github-issues/
    │   ├── ✏️ SKILL.md
    │   ├── ✏️ loop.ts                           // carver seat; claim renewal; selection; reconciliation guard; leaf order; sweep; hook; callback rendering
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
        │   ├── ✏️ agent.ts                      // fixture seats in dry run; carver role; LOOP_ROLE
        │   ├── ✏️ callbacks.ts                  // timeoutMs; process group; registered child
        │   ├── ✏️ config.ts                     // pointScale; nested-block merge; zero-allowed knobs
        │   ├── ✏️ context.ts                    // onClosed; dryRunLog; botLogin
        │   ├── ✏️ control-files.ts              // CARVING_FILE
        │   ├── ✏️ engines.ts                    // fixture engines
        │   ├── ✏️ labels.ts                     // labels; counters; caps; async close with event
        │   ├── ✏️ pipeline.ts                   // tree fields; answered; confirmed closes; live gate; claim; topology re-reads
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
    │   │   ├── 🆕 carve.ts                      // carveIssue(ctx, issue, knobs): CarveOutcome; claim; validation; rounds; apply; intents
    │   │   ├── 🆕 carve.test.ts                 // validators, ledger transitions, record round-trip, fingerprint, needsRevisit, resume, counters, claims, pauses; inline fixtures
    │   │   ├── 🆕 tree.ts                       // Tree, readTree, ancestors, depthOf, latestRecord, fingerprint, needsRevisit, claims, intents
    │   │   ├── 🆕 record.ts                     // Record, Ledger, renderRecord, parseRecord, renderChildBody, buildLedger, pauseSet, markers
    │   │   └── 🆕 callbacks.ts                  // on-carve-pass / on-carve-fail on the shared slot mechanism
    │   ├── 🆕 prompts/
    │   │   ├── 🆕 carve.md                      // the carver turn: criteria, normalization, seams, cuts, choice
    │   │   ├── 🆕 revisit.md                    // the carver turn on a trunk with a live record
    │   │   └── 🆕 confirm-carve.md              // the confirmer turn: cover or partition, the checklist, seam dispute, revisit, hand-off, pause set
    │   └── 🆕 references/
    │       ├── 🆕 seams.md                      // the ladder, the axioms, the floor, width, normalization, ordering, literature
    │       ├── 🆕 lifecycle.md                  // the states, transitions, invariants, intents, counters, claims; the board's columns
    │       ├── 🆕 the-record.md                 // the record's grammar, the markers, the ledger and its transitions, the fingerprint, who reads it
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

Only so many things can happen to a ticket. This section names all of them; the rest of the plan is the machinery that makes each transition hold. Every state is derived from the issue itself (its labels, its sub-issue tree, its latest record); nothing in a run directory decides a state, and every multi-write transition is announced on the tracker before it starts so any machine can finish it. That property is deliberate: these states are the columns of the board this work will eventually be shown on, and a state a person cannot read off the issue is a defect.

One rule governs every cost trade-off below: churn spent re-reading an existing issue is cheaper than the churn a wrong carving multiplies into. Where the plan can spend an agent turn or a tracker read to be sure, it does.

### States

Derived in this precedence; every issue is in exactly one. "Unreleased record" means `applying` or `live`.

| Precedence | State | Derived from | Who owns it |
|---|---|---|---|
| 1 | **Closed** | `state: CLOSED`; `stateReason` `COMPLETED` or `NOT_PLANNED` | terminal |
| 2 | **Held** | any of `needs-human`, `needs-decision`, `loop/skip`, `loop/parked`, `loop/dlq`, `loop/paused` on the issue or on any ancestor | a person, or the parent that paused it |
| 3 | **Claimed** | `loop/carving` or `loop/working` with an unexpired, unreleased claim | the run that claimed it |
| 4 | **Trunk** | an unreleased record, or any open child | the knife; workers take its leaves |
| 5 | **Blocked** | a `blocked-by` on the tracker or in any ancestor's record whose target is not closed `COMPLETED` | its blocker; a root leaf whose blocker is closed `NOT_PLANNED`, deleted, or part of a cycle goes Held (`needs-human`) by the sweep |
| 6 | **Oversized** | sized over the ceiling | the knife (carve) |
| 7 | **Leaf** | sized at or under the ceiling | the fix pipeline |
| 8 | **Unsized** | no `size:` label | the appraiser |

`loop/carved` is the trunk's label for people and for the worker's selection; a trunk that lost it is still a trunk by this table and is re-labelled at its next revisit. `loop/carve-gen: N` is the second way the sweep finds an unreleased trunk; both labels come off at release.

### Transitions

| From | Event | To | Notes |
|---|---|---|---|
| Unsized | appraiser: `valid` at or under the ceiling | Leaf | |
| Unsized | appraiser: `valid` over the ceiling | Oversized | fires the size callback, which runs the knife |
| Unsized | appraiser: close confirmed / hand-off | Closed / Held | the close re-reads the issue first and refuses a trunk or a claimed issue; the hand-off is an intent (marker comment) finished by any machine |
| Unsized | appraiser: crash, malformed answer, confirmer failure | Unsized | `loop/appraisals: N`; on reaching `maxAppraiseAttempts` (3) goes Held (`needs-human`) with the log tail |
| Oversized | knife: `carve` confirmed | Trunk | generation 1: claim, `applying` record, children, edges, callback, `live` record, labels, unclaim |
| Oversized | knife: `small-enough`, `indivisible`, `nothing-left`, disputed past the round cap, all confirmed | Held (`needs-human`) | both opinions on the thread; a `live` record with the verdict |
| Oversized | knife: `too-uncertain` confirmed | Held (`needs-decision`) | the question on the thread; a `live` record with the verdict |
| Oversized | knife: `failed` (crash, invalid answer, upstream refusal) | Oversized | `loop/carves: N`; on reaching `maxCarveAttempts` (3) goes Held (`needs-human`) with the log tail; `busy` never counts |
| Oversized | depth cap | Held (`needs-human`) | `indivisible` by definition |
| Oversized | another run's claim, or a worker's claim, is live | Oversized (`busy`) | retried by the sweep once the claim is gone |
| Leaf | worker starts | Claimed (`loop/working`) | after the live gate and before the lane is created; released at the terminal outcome, whatever it is; renewed while the worker waits on the line |
| Claimed (working) | `merged`; `already-fixed`, `obsolete`, `answered` confirmed by the second engine | Closed (`COMPLETED`) | the pipeline re-reads topology before merge and before every close; the close hook posts a roll-up and revisits the parent when there is one |
| Claimed (working) | a close the second engine disputed; `needs-*`; parked; dlq; topology changed under it | Held | the trunk waits; the pull request, if any, is parked with the reason |
| Claimed (working) | `out-of-band` re-sizes over the ceiling | Oversized | recursion; the depth guard bounds it |
| Claimed (working) | the run dies | Leaf | the next run's stranded pass resumes the lane, or any machine's sweep clears the expired claim |
| Leaf | a person closes it | Closed | `COMPLETED` completes its criteria; `NOT_PLANNED` orphans them; a dependent sibling stays Blocked |
| Trunk | anything in the fingerprint changes (a child's state, body, title, labels, or edges; a blocker's state; the trunk's body, title, labels, or the text of any comment by a person) | Trunk | revisit: `still-good` (new record), or `amend` confirmed (new generation), each with its pause set |
| Trunk | revisit: hand-off confirmed | Held | the trunk's hold; the leaves the question touches, and their dependents along recorded edges, get `loop/paused`; the rest keep working. A hand-off forced by a cap on a seam dispute pauses every open leaf, since the whole carving is in question |
| Held (trunk) | a person answers and removes the hold | Trunk | the sweep sees the label change; the revisit lifts every pause it recorded and amends as the answer requires, including a rollback piece for work that landed on the old premise |
| Trunk | revisit: `exhausted` confirmed | Unsized | a `released` record; size label off; `loop/carved` and `loop/carve-gen` off; counters off; unclaim; the appraiser is run on it directly |
| Trunk | revisit disputed past the round cap; `amend` on reaching `maxGenerations` (5); `still-good` on reaching `maxRevisitsPerGeneration` (10) | Held (`needs-human`) | the label and children stay; a person resolves; removing the hold resets the counter that tripped |
| Trunk | knife `failed` | Trunk | `loop/carves: N` as above; the sweep retries while the tracker still differs from the record |
| Trunk | a person closes it with children open | Closed | the sweep lifts every `loop/paused` the trunk's record commanded; children continue as leaves |
| Trunk (released, closed children only) | appraiser sizes the remainder | Leaf or Oversized | closed children do not route; a small remainder is an ordinary leaf; an oversized one is carved afresh with the closed children adopted as completed pieces |
| Held | a person removes the hold label | whatever the table derives | a counter at its cap is cleared by the sweep first; `needs-decision` answered re-enters with the answer in the thread |
| Closed | a person reopens | whatever the table derives | a reopened child changes the tree and triggers a revisit; a reopened child of a released trunk makes the trunk a Trunk again, in carve mode |

A close followed by a reopen before any run sees either leaves the fingerprint as it was; that is not an event, and nothing is lost by treating it as none.

### Terminal cases

Closed, and every Held state. Nothing else is terminal, and every non-terminal state has a retry path with a counter: `loop/appraisals: N` for the appraiser, `loop/carves: N` per generation for the knife, `loop/reviews: N` for the fix pipeline as today, `maxGenerations` and `maxRevisitsPerGeneration` per trunk, `maxDepth` per tree. Recursion is bounded twice: an authored child is at most the ceiling, so strictly smaller than its oversized parent on the scale, and the depth cap ends any tree the scale did not; an adopted or referenced piece keeps its own size and is carved on its own depth.

### Intents and repairs

Every transition with more than one tracker write is announced first and finished by whoever finds it. Finishing always begins with a claim, so two machines that find the same announcement do not both finish it.

| Intent (the announcement) | Finished by | If found unfinished |
|---|---|---|
| `applying` record (generation) | children, adoptions, references, edges, supersessions, callback, `live` record, labels, counters cleared, unclaim | claim, then finish from the record; if the trunk gained a hold meanwhile, pause every new child; then revisit |
| `released` record | size label off, `loop/carved` and `loop/carve-gen` off, counters off, unclaim, appraise | claim, then finish |
| hand-off marker `<!-- carve-handoff verdict=V gen=G -->` on a trunk, or `<!-- appraise-handoff verdict=V -->` on any issue | comment, hold label, pauses, record (knife only), unclaim | claim, then finish; the counter is written before the marker, so a cap reached just before a crash is not mistaken for a redrive |
| pause command in the newest `live` record | `loop/paused` on exactly the commanded children | the sweep reconciles labels to the record; the record wins |
| claim marker | the work, then an unclaim marker and the label off | past its expiry: label off and an unclaim posted by the sweep; a label with no marker, or an unclaim with the label still on, is repaired the same way |

### Invariants

Each has a test or a gate below.

- A confirmed cut is applied only to the trunk it was confirmed against: the fingerprint is re-read after the agreeing confirmer and immediately before the `applying` record, and any difference restarts from the carver.
- A referenced or adopted issue closed `NOT_PLANNED` (which is also how the knife closes a superseded child) or deleted does not complete a criterion; the ledger marks it `orphaned`, `still-good` is invalid while any criterion is orphaned, and the revisit must re-own it.
- A criterion the thread has retracted is `withdrawn`, citing the comment; it counts as done for exhaustion; if the comment disappears or its text changes the criterion is `open` again, and the sweep sees it because comment bodies are in the fingerprint.
- Mode is chosen from the latest record, never from the tree, so a released trunk is never revisited into a second `exhausted`.
- Closed children never route an issue to the knife; only open children, an unreleased record, or an oversized label do. Release removes both trunk labels, so a released trunk sized small is an ordinary leaf.
- Merge reconciliation never closes a trunk, a held, paused, or blocked issue, or a claimed one: it skips them on the snapshot, re-reads immediately before closing, and requires a closing keyword at the start of a line or after a period, not preceded by "not" or "n't", before an issue number.
- A worker never starts on, merges, or closes a trunk, a held or paused issue (itself or any ancestor), an oversized issue, or a leaf whose blocker (on the tracker or in any ancestor's record) is not `COMPLETED`: the live gate re-reads before claiming, and every close and merge path re-reads again.
- The knife never carves under a worker and a worker never starts under the knife: each stands off the other's claim, on every machine, and the appraiser refuses to close an issue that is claimed or a trunk when it re-reads before closing.
- Every close of a leaf, wherever it comes from, is followed by a revisit of its parent: immediately when the loop made the close, on the next run's sweep otherwise, because the fingerprint carries child states.
- Two roll-ups for one close are impossible: the roll-up is keyed by child, event, and the close time, and the hook skips one the thread already carries.
- The knife's own writes never trigger a revisit: the fingerprint excludes marker comments and `loop/*` labels, and a hand-off writes its hold label before its record.
- `busy` never spends an attempt.
- Two trunks that need the same missing piece at the same moment may each author it; the next revisit of either finds the twin through normalization and supersedes one. This is the one duplicate the design heals rather than prevents.

## Interfaces

The types every commit below refers to. They live where the tree says; the shapes are fixed here so no commit invents them. Property types are TypeScript; `number`, `string`, `boolean`, and `Date`-as-ISO-string are spelled out.

```ts
// fix-github-issue/lib/context.ts
export type CloseEvent = { issue: number; kind: 'merged' | 'closed' | 'answered'; pr?: number; mergeSha?: string; closedAt: string; reason: string };
Context.onClosed?: (event: CloseEvent) => Promise<void>;   // awaited by closeIssue; a throw is logged, never propagated
Context.dryRunLog: string[];                                // every mutate() the dry run would have made, in order
Context.botLogin: string;                                   // `gh api user --jq .login` at context creation; empty in a dry run

// fix-github-issue/lib/engines.ts
ENGINES.fixture, ENGINES.fixture2: { command: (cwd: string, prompt: string, model?: string) => string[] }  // ['bun', FIXTURE_RUNNER, cwd, model]
// `fixture:<path>` / `fixture2:<path>`: the runner reads LOOP_ROLE, copies <path> to that role's control file in cwd, exits 0.
// runAgentOnce runs a fixture seat even in a dry run (it mutates nothing), so tests can drive whole flows.

// fix-github-issue/lib/config.ts
PipelineKnobs.pointScale: number[];                 // default [1, 2, 3, 5, 8, 13, 21, 34]; ascending positive integers
loadProjectConfig options.nonNegativeIntegers: ReadonlyArray<string>;
loadProjectConfig options.blocks?: string[];         // nested objects merged one level deep over their defaults, like seats

// fix-github-issue/lib/labels.ts
export async function closeIssue(ctx: Context, issue: number, comment: string, event: Omit<CloseEvent, 'issue' | 'closedAt'>): Promise<void>;
export function carveCount(labels: Array<{ name: string }>): number;
export function recordCarve(ctx: Context, issue: number, previous: number): number;      // returns the new count
export function clearCarves(ctx: Context, issue: number): void;
export function appraisalCount(labels: Array<{ name: string }>): number;
export function recordAppraisal(ctx: Context, issue: number, previous: number): number;
export function clearAppraisals(ctx: Context, issue: number): void;
export function repairDurableState(ctx: Context, all: LabelledIssue[], skipLabels: string[], caps?: { reviews: number; carves: number; appraisals: number }): void;

// fix-github-issue/lib/pipeline.ts
export type Issue = { number: number; title: string; createdAt: string; labels: Array<{ name: string }>;
  parent?: { number: number } | null; subIssuesSummary?: { total: number; completed: number };
  blockedBy?: { nodes: Array<{ number: number; state: string; stateReason: string | null }> } };   // optional until Commit 2 requests them everywhere
Verdict: adds 'answered'; WorkerResult.answer?: string     // Markdown; required with 'answered'
FixOutcome.outcome: adds 'left-alone' (the live gate refused) and 'busy' (a foreign claim)
export async function fixIssue(ctx: Context, issue: Issue, options?: { maxPoints?: number; ceiling?: number; confirmer?: Seat }): Promise<FixOutcome>;
// confirmer defaults to ctx.seats.reviewer when absent, so existing callers keep compiling; assertDistinctEngines(worker, confirmer)

// carve-github-issue/lib/tree.ts
export type Comment = { id: string; author: string; body: string; createdAt: string };
export type Seam = 'domain' | 'tier' | 'route' | 'area' | 'file' | 'unit' | 'material';
export type Relation = 'shards' | 'layers' | 'mixed' | 'waiting';
export type OrderRung = 'dependency' | 'source-of-truth' | 'risk' | 'size';
export type Node = Issue & { body: string; state: 'OPEN' | 'CLOSED' | 'DELETED'; stateReason: string | null; comments: Comment[]; bodyHash: string };
export type Tree = { issue: Node; children: Node[]; blockers: Node[]; ancestors: Array<{ number: number; labels: string[]; record: Record | null }>;
  depth: number; record: Record | null; generation: number; claims: Claim[]; intents: Intent[] };
export type Claim = { kind: 'carving' | 'working'; runId: string; at: string; expires: string; commentId: string; released: boolean };
export type Intent = { kind: 'applying' | 'released' | 'handoff'; generation: number | null; commentId: string; finished: boolean };
export type Fingerprint = { title: string; bodyHash: string; size: number | null; labels: string[] /* loop/* excluded */; parent: number | null;
  comments: Array<{ id: string; bodyHash: string }> /* marker comments excluded */;
  children: Array<{ number: number; state: string; stateReason: string | null; title: string; bodyHash: string; labels: string[]; blockedBy: number[] }>;
  blockers: Array<{ number: number; state: string; stateReason: string | null }> };
export function readTree(ctx: Context, number: number): Tree;   // one gh issue view for the trunk, one per child, one per blocker, one per ancestor; a 404 becomes state DELETED
export function fingerprint(tree: Tree): Fingerprint;
export function needsRevisit(record: Record, tree: Tree): string | null;    // the first differing field, or null; a released record never needs a revisit
export function liveClaim(tree: Tree, now: string, ours?: string): Claim | null;   // the earliest (by comment id) unreleased, unexpired claim of either kind not ours

// carve-github-issue/lib/record.ts
export type CriterionStatus = 'open' | 'completed' | 'deferred' | 'withdrawn' | 'orphaned';
export type ChildStatus = 'open' | 'closed-completed' | 'closed-not-planned' | 'superseded' | 'deleted';
export type Ledger = Array<{ id: string; text: string; owner: number | null; status: CriterionStatus; cite?: string; waitsOn?: number }>;
export type Piece = { kind: 'author' | 'child' | 'reference'; title?: string; body?: string; number?: number; points: number | null;
  role: 'work' | 'spike'; criteria: string[]; dependsOn: number[]; order: number; orderRung: OrderRung };
export type Cut = { seam: Seam; higherRungs: Array<{ seam: Seam; why: string }>; relation: Relation;
  state: 'complete' | 'partial' | 'inadmissible'; deferred: Array<{ criterion: string; waitsOn: number }>;
  pieces: Piece[]; groundwork: Array<{ what: string; owner: number }>; width: { instances: string[]; perInstance: string } | null;
  balance: string; independence: string };
export type RecordChild = { number: number | null /* null in an applying record for a piece not yet created */; piece: number; kind: Piece['kind'];
  link: 'sub-issue' | 'blocker'; points: number | null; order: number; orderRung: OrderRung; dependsOn: number[]; status: ChildStatus; paused: boolean };
export type Record = { generation: number; state: 'applying' | 'live' | 'released'; verdict: string; cut: Cut | null; children: RecordChild[];
  ledger: Ledger; revisits: number; seen: Fingerprint; at: string };
export function renderRecord(r: Record): string;   // `<!-- carve-record gen=N state=S -->`, a fenced json block holding r, then the human table
export function parseRecord(comment: Comment, botLogin: string, log: (m: string) => void): Record | null;  // marker, author, and JSON must all check
export function renderChildBody(trunk: number, generation: number, index: number, piece: Piece): string;
export function buildLedger(previous: Ledger | null, criteria: Array<{ id: string; text: string }>, record: Record | null, tree: Tree): Ledger;
export function carryIds(previous: Ledger, criteria: Array<{ text: string }>): Array<{ id: string; text: string }>;  // same id when the normalized text (lowercased, punctuation and whitespace collapsed) is equal or within a Levenshtein ratio of 0.2; else a new id
export function pauseSet(record: Record, affected: string[]): number[];   // owners of the affected criteria plus their dependents along dependsOn, transitively

// carve-github-issue/lib/carve.ts
export type CarveVerdict = 'carve' | 'small-enough' | 'indivisible' | 'too-uncertain' | 'nothing-left';
export type RevisitVerdict = 'still-good' | 'amend' | 'exhausted' | 'indivisible' | 'too-uncertain';
export type Carving = { issue: number; mode: 'carve' | 'revisit'; verdict: CarveVerdict | RevisitVerdict; reason: string;
  criteria: Array<{ id: string; text: string }>; ledger: Ledger; chosen?: number; cuts?: Cut[];
  supersedes?: Array<{ old: number; replacements: number[]; reason: string }>; affected?: string[] };
export type Confirmation = { issue: number; mode: 'carve' | 'revisit'; agree: boolean;
  finding: 'cover' | 'gap' | 'overreach' | 'partition-intact' | 'partition-broken' | 'still-good' | 'not-still-good' | 'exhausted' | 'not-exhausted' | 'hand-off-agree' | 'hand-off-disagree';
  seam: 'agree' | 'higher-available'; seamCase: string; reason: string };
export type CarveKnobs = { ceiling: number; maxDepth: number; maxChildren: number; maxCarveRounds: number; maxCarveAttempts: number;
  maxGenerations: number; maxRevisitsPerGeneration: number; callbacksDir: string; seats: { carver: Seat; confirmer: Seat } };
export const CARVE_DEFAULTS = { maxDepth: 3, maxChildren: 8, maxCarveRounds: 5, maxCarveAttempts: 3, maxGenerations: 5, maxRevisitsPerGeneration: 10 };
export type JournalStep = 'claim' | 'applying-record' | 'create' | 'adopt' | 'reference' | 'edge' | 'supersede' | 'pause' | 'unpause' | 'callback' | 'live-record'
  | 'gen-label' | 'carved-label' | 'counters' | 'handoff-marker' | 'handoff-comment' | 'hold-label' | 'released-record' | 'release-size' | 'release-labels' | 'release-counters' | 'unclaim';
export type Journal = { issue: number; generation: number; status: 'open' | 'done' | 'abandoned'; steps: Array<{ name: JournalStep; target?: number; done: boolean }> };
export type CarveOutcome = { outcome: CarveVerdict | RevisitVerdict | 'busy' | 'resumed' | 'failed'; reason: string; generation?: number; children?: number[] };
export function validateCarving(c: unknown, ctx: { mode: 'carve' | 'revisit'; knobs: CarveKnobs; tree: Tree; scale: number[] }): { ok: true; carving: Carving } | { ok: false; faults: string[] };
export function validateConfirmation(c: unknown, mode: 'carve' | 'revisit'): { ok: true; confirmation: Confirmation } | { ok: false; faults: string[] };
export async function carveIssue(ctx: Context, issue: Issue, knobs: CarveKnobs): Promise<CarveOutcome>;
```

The record's grammar: the marker line, one fenced `json` block holding the `Record` object verbatim, then a Markdown table for people. `parseRecord` reads only the JSON; the table is derived. The newest comment by `ctx.botLogin` with a valid marker and JSON is the latest record; anything else on the thread is not a record. Markers, all excluded from the fingerprint by their marker and not by author:

- `<!-- carve-record gen=N state=S -->` on the record.
- `<!-- carve-rollup child=N event=E at=T -->` on a roll-up.
- `<!-- carve-claim kind=K run=R at=T expires=T2 -->` on a claim; the holder renews by editing `expires` in place; `<!-- carve-unclaim kind=K run=R -->` releases it. Ties between claims are broken by comment id, lowest first.
- `<!-- carve-handoff verdict=V gen=G -->` and `<!-- appraise-handoff verdict=V -->` on a hand-off's comment.
- `<!-- carve-answer issue=N -->` on a posted spike answer; a second is never posted while one exists.
- `<!-- carve parent=N gen=G piece=I -->` in an authored child's body.

Criterion ids are stable across generations through `carryIds`; the confirmer checks the mapping and a criterion whose text vanished from the thread becomes `withdrawn` citing the edit.

## The carver's answer

`loop-carving.json`, a `Carving`, written in the scratch directory. Programmatic validation owns everything mechanical and rejects the file whole on any miss; the confirmer owns meaning.

```json
{
  "issue": 1282,
  "mode": "carve",
  "verdict": "carve",
  "reason": "two entities end to end; the author side is the smaller leg",
  "criteria": [{ "id": "A1", "text": "…" }, { "id": "A2", "text": "…" }, { "id": "A3", "text": "…" }],
  "ledger": [{ "id": "A1", "text": "…", "owner": 0, "status": "open" }, { "id": "A2", "text": "…", "owner": 0, "status": "open" }, { "id": "A3", "text": "…", "owner": 1, "status": "open" }],
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

`agree` is true only for `cover`, `partition-intact`, `still-good`, `exhausted`, or `hand-off-agree`, with `seam: agree`. A seam dispute is allowed only when the higher seam the confirmer sees is `domain` or `tier`; between mechanistic rungs any admissible covering cut ships and the alternative is noted in `seamCase`. A dispute of any kind goes back to the carver with the confirmer's case as feedback. `maxCarveRounds` (default 5) is the maximum number of carver-confirmer pairs; the fifth disagreement hands off, so at most five carver turns and five confirmer turns run. On reaching the cap the trunk goes Held with the whole exchange on the thread, and every open leaf is paused, because a seam dispute is about the whole carving.

## Normalization

Before any piece is authored, the carver matches every piece against the trunk's own tree first (`child`), then the backlog, open and closed, through `gh api --paginate search/issues` with the piece's nouns (a match is one the carver would defend as the same ask, and the confirmer checks it). An open `reference` with no parent is attached with `gh issue edit <n> --parent <trunk>`; one that already has a parent stays where it is and the trunk gets `--add-blocked-by <n>`; a `reference` closed `COMPLETED` is recorded as `closed-completed` and completes its criteria; a match that would close a `blocked-by` cycle is rejected and the piece is authored instead. Immediately before each reference is attached its parent is re-read, and one that gained a parent meanwhile becomes an edge instead. An adopted or referenced issue that already carries a size keeps it.

## What lands on the tracker

Every write below is a journal step and a tracker-visible one, in the order given, after the intent that announces it. On any entry to an issue the knife first claims, then finishes what a crash left (an `applying` record, a `released` record, a hand-off marker, pause labels that disagree with the newest record, an expired or torn claim), then proceeds.

| Verdict | Trunk | Children |
|---|---|---|
| `carve` or `amend`, confirmed | claim; fingerprint re-read; `applying` record; authored children created in delivery order; children adopted; references attached or depended on; edges; superseded children with no work started closed `not planned` with a pointer to their replacements; pauses lifted or applied to match; callback; `live` record; `loop/carve-gen: N`; `loop/carved`; counters cleared; unclaim | authored pieces via `gh issue create --parent`, body from the template, `spike` label on spikes, no size label |
| disputed past the round cap | claim; counter; hand-off marker; comment with the last cut and the confirmer's case; `needs-human`; `loop/paused` on every open leaf; `live` record with the verdict; `on-carve-fail`; unclaim | all paused |
| hand-off, confirmed | claim; hand-off marker; comment; the hold label; `loop/paused` on the pause set; `live` record with the verdict and the pause set; `on-carve-fail`; unclaim | the paused leaves wait; the rest keep working |
| `still-good`, confirmed | claim; pauses lifted or applied to match; `on-carve-pass`; `live` record with the ledger and `revisits`; unclaim | |
| `exhausted`, confirmed | claim; `released` record linking every closed child; size label off; `loop/carved` and `loop/carve-gen` off; counter labels off; `on-carve-pass`; unclaim; then the appraiser is run on it directly with the burndown's appraisal options and `ageDays: null` | none |

"Work started" on a child means any of: a live `loop/working` claim, an open pull request referencing it, an assignee, or a `loop/*` label. A superseded child with any of those is kept and adopted as a piece of the new cut instead of closed.

Spike proof: the worker writes `answer` in its verdict file; the driver runs `confirm-answer.md` on the confirmer seat (does the evidence answer the questions the spike's body asks); on agreement the driver re-reads the issue, posts the answer with its marker unless one exists, and closes with `kind: answered`; on disagreement it parks the leaf as `needs-human` with both opinions. `already-fixed` and `obsolete` from a worker go through `confirmClose` the same way, and the confirmer's engine must differ from the worker's.

## The carving record

Rendered by `record.ts` and posted as one comment; the shape is in Interfaces and the grammar in `references/the-record.md`. Beyond the cut, it carries the ledger, the `revisits` count for this generation, each child's `paused` command, and `seen`, the fingerprint at the moment it was written. The child body's first line points at the trunk and says to read the record; a worker with a parent reads its parent's record and every ancestor's before starting, and learns whether its leaf is a shard that touches nothing or a layer that assumes the schema child landed.

The ledger's transitions, one row per event, are the contract in `references/the-record.md`: a child or reference closed `COMPLETED` completes its criteria; closed `NOT_PLANNED` or deleted orphans them; a completed child reopened reopens them; a superseded child reopened is an unexpected open child the revisit must adopt or hand off; a spike closed makes its deferred criteria `open` and unowned, which only an `amend` can settle; a withdrawn comment removed or edited reopens the criterion; a child whose body or title changed since the record is re-judged by the confirmer at the next revisit. Supersession moves criteria to the replacement as `open`; `superseded` is a child status, not a criterion status.

## Ordering

Two ladders, both conceptual-first with the mechanistic rung last, both search orders that fall through when a rung does not discriminate.

Seams: domain, tier, route, area, file, unit, material. The larger the issue, the more the cut must be conceptual; the smaller, the more freedom to cut mechanistically, because at small sizes that may be the only axiom left. Severability outranks symmetry; symmetry is a tie-breaker.

Delivery order within one cut: hard dependency; closeness to the source of truth (definitions, schema, types, tables, API objects; then persistence; then the view); uncertainty and risk; size. The confirmed `order` in the newest record is canonical; issue numbers never encode order. The burndown reads the order from the record for candidates that have a parent (one `gh issue view` per trunk, cached per run) and sorts a trunk's leaves by it, contiguous, in the position the trunk's newest leaf would have had; the rest of the backlog stays newest-first. Order is a dispatch preference; only an edge is a hard constraint, and the carver emits an edge wherever a later piece cannot land before an earlier one. The live gate honours an edge whether it is still on the tracker or only in an ancestor's record.

## Guards

- **Depth.** The root is depth 0; an issue at depth d is carvable iff d < `maxDepth` (default 3). At the cap the issue is `indivisible` with the depth stated. GitHub's limit is eight.
- **Fan-out.** `maxChildren` (default 8) per cut, and the trunk's `subIssuesSummary.total` plus authored pieces plus references to be attached at or under 100.
- **Floor.** No child under the scale's smallest rung, none over the ceiling, none without its own acceptance and proof. A file, unit, or material cut is admissible only when the physical boundary also owns one change or one reviewable outcome.
- **Counters.** Every cap in this plan trips on reaching N. `loop/carves: N` and `loop/appraisals: N` in the pattern of `loop/reviews: N`, incremented on a `failed` outcome only and written before the hand-off marker when the increment reaches the cap, cleared as a journal step of a confirmed verdict; `repairDurableState` takes the caps and repairs all three. `loop/carve-gen: N` is the generation high-water mark while the trunk is unreleased; the knife trusts the larger of the label and the newest record of any state. `maxGenerations` (5) per trunk; `maxRevisitsPerGeneration` (10), counted in the record. When a person removes a hold from an issue whose counter sits at its cap and whose hand-off marker is finished, the sweep clears that counter before anything else runs; the removal is the reset. The revisit cap is a known unknown: how often a healthy trunk is revisited is unmeasured, the record makes it measurable, and `references/operating.md` says to raise it or rethink the trigger if trunks reach it routinely.
- **Claims.** The knife adds `loop/carving` and posts a claim with `expires` set to `AGENT_TIMEOUT_MS` times `2 * maxCarveRounds` from now, then re-reads; if an earlier unreleased, unexpired claim of either kind by another run exists (earlier by comment id), it posts its own unclaim, removes nothing else, and returns `busy`. The worker does the same with `loop/working` after the live gate and before its lane is created, with `expires` set from the pipeline's agent and checks timeouts, and renews `expires` by editing the marker every five minutes while it waits on the line or on checks; its terminal outcome releases it. The sweep clears an expired claim, a label with no marker, or an unclaim with the label still on, each with a comment. The local `carve-<n>.lock` stays as the cheap first check on one machine.
- **Time.** The knife bounds itself: every agent turn has the runtime's 45-minute cap and rounds are capped, so a carve terminates by construction. The size callback that invokes it runs with no outer timer by default (`sizeCallbackTimeoutMinutes: 0`, validated as a non-negative integer); the burndown's shutdown kills its process group.
- **The worker's live gate and landing checks.** Immediately before claiming, `fixIssue` reads the issue and its ancestors and returns `left-alone` when the issue is Closed, Held (itself or an ancestor), a Trunk, Oversized, or Blocked (on the tracker or in an ancestor's record), and `busy` when a foreign claim is live; then it claims, then it creates the lane. Immediately before merge, and immediately before every close in `land` and in `settleTerminalVerdict`, the pipeline re-reads the same and, on any refusal, parks the pull request with the reason and releases the claim.

## Revisit triggers

- **Inside the loop.** `closeIssue` awaits `ctx.onClosed(event)` after the close, so every close path (the fix pipeline, stranded resume, reconciliation, the appraiser) fires it; a throw is logged and never changes an outcome. The burndown's hook: if the closed issue has a parent, post the roll-up on the trunk (its marker keyed by child, event, and `closedAt`), skipping one the thread already carries; then `carveIssue` on the trunk, at most once per trunk per run (an in-process set; later closes in the same run are seen by the next sweep); after a confirmed `exhausted`, `appraiseIssue` on the trunk with the burndown's appraisal options and `ageDays: null`. A closed parent is logged and left alone.
- **Outside the loop.** The sweep runs after stranded-pull-request resume, under the loop lock, and in a dry run only logs. Three passes, all through `gh api --paginate`. First, every open issue labelled `loop/carved`, `loop/carve-gen: *`, `loop/carving`, or `loop/working`: finish unfinished intents; reconcile pause labels to the newest record; clear expired or torn claims; clear a tripped counter whose hold is gone and whose hand-off marker is finished; then `needsRevisit(record, tree)` decides, and a trunk with no record at all is handed to the knife. Second, every open issue not in the first pass, not Held, not Claimed, and either sized over the ceiling or with an open child, is handed to the knife. Third, every open root leaf whose blocker is closed `NOT_PLANNED`, deleted, or in a cycle is handed to a person with `needs-human`, and every `loop/paused` child of a closed trunk has its pause lifted.

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
9. **Hand-offs, spikes, and pauses.** `indivisible` is a verdict (we know it cannot be cut here); `too-uncertain` is a pending state (a person has not decided); the two are never blurred. A technical unknown is a `spike` piece whose acceptance is the questions answered; a partial cut lists the deferred criteria and the spike answer each waits on, so the spike plus the deferred list still accounts for the whole parent. A question on a trunk pauses exactly the leaves that own the criteria it touches and their dependents along recorded edges, transitively through interior children; the rest keep working. A seam dispute the confirmer would not drop pauses everything.
10. **Revisits.** Every child close is followed by a re-check of the trunk; the ledger classifies every criterion; `exhausted` requires every criterion completed or withdrawn and no open dependency; a better cut found later is a re-carve, and children with work started survive it as adopted pieces; an answered question may require a rollback piece for work that landed on the old premise; generations and revisits are capped.
11. **Non-code pieces.** Design, docs, migrations, and operations are valid when each names a deliverable and its evidence; an unresolved preference is a hand-off, not a design piece.
12. **Other people's seams**, mapped onto the ladder: Lawrence's nine patterns and his two selection rules (severability, then equal size); Cohn's SPIDR (paths and rules are domain seams, interface a tier seam, spike the technical unknown); Cockburn's Elephant Carpaccio (why domain outranks tier); Parnas (a boundary that hides one decision is the admissibility test for the low rungs and the independence criterion); the WBS 100% rule (the ledger) and 8/80 (floor and ceiling in hours); Google's small-CL guidance (stacked, per-file, horizontal, vertical; a horizontal cut is fine when a stable stub lets each side land alone); Adzic's hamburger method (technical steps when no vertical cut exists); Asthana et al. 2026 (validation gates between sub-tasks, and retrying only the failed phase, which is the intent-and-repair pattern).

## Scope boundaries

Named here so the lifecycle's claims are read with them.

- **A person who deletes records, markers, or `loop/*` labels is acting.** The knife trusts the larger of the label and the record for generations and counters, treats a missing record as a difference, and repairs torn labels; it does not defend against deliberate removal of every trace, which is a person's choice and shows on the thread.
- **Two trunks authoring one missing piece in the same instant** is healed by the next revisit, not prevented; see the last invariant.
- **The age window** (`ageDays`) is the burndown's existing scope for root issues: an old root issue is not selected for appraisal or work unless named or `--all`. Issues with a parent are exempt from the window in selection, and trunks are reached through the sweep and the hook.
- **Dirty-lane recovery** (a worker that modified its worktree and died before a pull request) stays as the fix pipeline's reconciliation leaves it, "for inspection" in the run log; the stranded pass now also releases such a lane's claim so the leaf is not stuck Claimed.
- **Cross-repository sub-issues** are not used; every child is created in the trunk's repository.
- **Reconciliation's closing-keyword parser is lexical.** It rejects the two negations named in the invariant and nothing subtler; a pull request body that quotes a closing phrase for an issue it did not close will close it, as it does today.

## Commits

`<skills>` below is the checkout of this collection; the adopting repository is the checkout holding `burn-down-github-issues.config.ts` from which a gate is run. Live gates create fixture issues with the command in the gate and clean up afterward with:

```bash
gh issue list --search "[carve-test] in:title" --state open --json number --jq '.[].number' | xargs -r -n1 gh issue close --reason "not planned"
```

Authored children carry the trunk's title prefix, so `[carve-test]` reaches them. Fixture answer files are written by the gate into `<skills>/.gates/` (gitignored) with the names given. Every commit leaves the burndown runnable, and no commit lets a trunk reach a worker.

### Commit 1: widen the shared runtime and add the parsers

**Goal:** Everything in `fix-github-issue` and `appraise-github-issues` the knife and its gates need, plus the tree and record parsers those changes read, before the skill exists.

**Files created:**
- `skills/fix-github-issue/lib/fixture-runner.ts`: reads `LOOP_ROLE`, copies `argv[3]` to the role's control file in `argv[2]`, exits 0.
- `skills/fix-github-issue/prompts/confirm-answer.md`: the second engine reads the spike's body and the proposed answer, checks each question has evidence a stranger could re-check, and writes `loop-confirmation.json` with `agree` and `reason`.
- `skills/carve-github-issue/lib/tree.ts`, `skills/carve-github-issue/lib/record.ts`: as in Interfaces; pure functions plus `readTree`.
- `skills/carve-github-issue/lib/carve.test.ts` (first part): `parseRecord` round-trips `renderRecord`; rejects a wrong author, a missing marker, malformed JSON; `buildLedger` on inline fixture trees for every row of the transition table; `carryIds` on equal, edited, new, and vanished text; `fingerprint` excludes marker comments and `loop/*` labels and includes comment bodies, titles, child edges, and blocker states; `needsRevisit` for each field and never for a released record; `pauseSet` transitively through an interior child; `liveClaim` with released, expired, torn, and tied claims.
- `skills/carve-github-issue/references/the-record.md`: the grammar, every marker, the JSON shape, the fingerprint, the ledger transition table, the readers.

**Files rewritten:**
- `skills/fix-github-issue/lib/engines.ts`: `fixture` and `fixture2` as in Interfaces.
- `skills/fix-github-issue/lib/agent.ts`: `clearsByRole.carver`; `LOOP_ROLE` in the child environment; a fixture seat runs in a dry run.
- `skills/fix-github-issue/lib/callbacks.ts`: `runCallback(dir, name, payload, log, options?: { timeoutMs?: number })`; default 60 s; `0` means no timer; own process group (`setsid` when present), added to and removed from `children`, both pipes drained concurrently, killed by group on timeout or shutdown.
- `skills/fix-github-issue/lib/control-files.ts`: `CARVING_FILE = 'loop-carving.json'`.
- `skills/fix-github-issue/lib/shell.ts`: `mutate` pushes `description` onto `ctx.dryRunLog` in a dry run.
- `skills/fix-github-issue/lib/context.ts`: `CloseEvent`, `onClosed`, `dryRunLog`, `botLogin` as in Interfaces.
- `skills/fix-github-issue/lib/config.ts`: `pointScale` with its default (so existing configs load unchanged); `nonNegativeIntegers`; `blocks`.
- `skills/fix-github-issue/lib/labels.ts`: `ensureLabels` adds `loop/carved` (`5319e7`, "Carved into sub-issues; worked by closing them"), `loop/carving` (`5319e7`, "A carve is in progress; other runs wait"), `loop/working` (`1d76db`, "A worker has this issue; other runs wait"), `loop/paused` (`fbca04`, "Paused by its parent while a question is open"), `spike` (`0e8a16`, "Answer a question with evidence; no pull request"); the counter functions and `repairDurableState` as in Interfaces (the caps parameter optional, defaulting to the review cap alone, so the existing call compiles); `closeIssue` async with the event, awaiting `ctx.onClosed`.
- `skills/fix-github-issue/lib/pipeline.ts`: the tree fields, optional; `answered` and `answer`; `settleTerminalVerdict` async, re-reading topology before each close and running `confirmClose` for `already-fixed` and `obsolete` and `confirm-answer.md` for `answered`; every `closeIssue` call site passes its event (`land`: `merged` with `pr` and `mergeSha`; `settleTerminalVerdict`: `closed` or `answered`) and awaits; `fixIssue` with the optional `confirmer` and `ceiling`, the live gate reading ancestors, the claim with expiry before `worktreeFor`, renewal while waiting, release in `finally`, and `assertDistinctEngines(worker, confirmer)`; `land` re-reads topology before merge and before close and parks on refusal. The trunk test in this commit reads `tree.ts` for the record and `subIssuesSummary` for open children.
- `skills/fix-github-issue/lib/resume.ts`: `findStranded` and `resumeStranded` re-read topology before landing, renew or release the claim, and release a lane's claim when abandoning it; `reconcile` releases the claim of any lane it leaves for inspection.
- `skills/fix-github-issue/fix.ts`: `--confirmer` (config `seats.confirmer`); prompts dirs include `../appraise-github-issues/prompts`; the issue view requests the tree fields.
- `skills/fix-github-issue/prompts/triage-and-fix.md`: when the issue has a parent, read the parent's thread and its latest carving record, and every ancestor's, before starting; when the issue carries `spike`, run the experiments its body names, put the answers with evidence in `answer`, and return `answered`; the verdict schema gains both.
- `skills/appraise-github-issues/lib/appraise.ts`: `sizeCallbackTimeoutMinutes` (default 0) threaded to `runSizeCallback`; `allOpenIssues` paginates; `selectForAppraisal` skips issues with an unreleased record or an open child; `appraiseIssue` refuses such an issue even when named, re-reads the issue immediately before a close and refuses a trunk or a claimed issue, posts an `appraise-handoff` marker before a hand-off's comment and label and finishes an unfinished one on the next visit, records `loop/appraisals: N` on `failed` and on reaching `maxAppraiseAttempts` (3) parks the issue with the log tail, and takes `ageDays: number | null` (rendered as `any` when null); `confirmClose` exported as `(ctx, issue, verdict, comment, confirmer, say)`.
- `skills/appraise-github-issues/appraise.ts`: passes the timeout and the cap.
- `skills/appraise-github-issues/lib/callbacks.ts`: `SizePayload.repoRoot`; the timeout parameter.
- `skills/appraise-github-issues/prompts/appraise.md`: the age-window sentence reads "when the driver applies a window it is `{{AGE_DAYS}}` days; `any` means no window".
- `skills/appraise-github-issues/references/callbacks.md`: the field and the timeout.
- `skills/burn-down-github-issues/loop.ts`: only what keeps it compiling and running unchanged: `repairDurableState` called with the caps it knows, `fixIssue` called with `confirmer: SEATS.reviewer` and `ceiling: MAX_POINTS`, and `closeIssue` awaited with a `closed` event in reconciliation.

**Gate:** `bunx tsc --noEmit -p <skills>` passes and `bun test <skills>` passes. From the adopting repository, capture `bun run <skills>/appraise-github-issues/appraise.ts --dry-run > /tmp/appraise-before.log` and `bun run <skills>/burn-down-github-issues/loop.ts --dry-run > /tmp/loop-before.log` before the commit and the same to `-after.log` after it; `diff` each pair shows only timestamp lines. Then:

```bash
n=$(gh issue create --title "[carve-test] spike: which cache wins" --body "Questions: A? B?" --label spike --label "size: 1" --json number --jq .number)
mkdir -p <skills>/.gates
printf '{"issue":%s,"verdict":"answered","reason":"measured","answer":"A: x. B: y."}' "$n" > <skills>/.gates/answered.json
printf '{"issue":%s,"agree":true,"reason":"both answered with numbers"}' "$n" > <skills>/.gates/agree.json
printf '{"issue":%s,"agree":false,"reason":"B has no evidence"}' "$n" > <skills>/.gates/disagree.json
bun run <skills>/fix-github-issue/fix.ts --issue "$n" --worker fixture:<skills>/.gates/answered.json --reviewer fixture2:<skills>/.gates/agree.json --confirmer fixture2:<skills>/.gates/agree.json
```

The issue is closed `COMPLETED`, carries the answer with its marker, and has no `loop/working`. Repeat on a second fixture with `--confirmer fixture2:<skills>/.gates/disagree.json`: it is open and `needs-human`. Clean up with the command above.

### Commit 2: make the burndown read the tree

**Goal:** The loop never works a trunk, a paused leaf, or a blocked leaf, works a trunk's leaves in recorded order, and never closes a trunk by reconciliation, before any trunk exists.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: `allIssues`, `selectCandidates`, `openPullRequestIssueRefs`, and `reconcileMergedPullRequests` paginate through `gh api` and request the tree fields; `selectCandidates` drops issues labelled `loop/carved`, `loop/carve-gen: *`, `loop/carving`, `loop/working`, or `loop/paused`, issues with an open child, issues with a Held or paused ancestor, and issues with a blocker (tracker or ancestor record) not closed `COMPLETED`, logging each exclusion with its rule, and exempts issues with a parent from the age window; candidates with a `parent` are grouped contiguously at the position of the group's newest member and sorted within the group by the trunk's latest record (missing record: by number ascending); `reconcileMergedPullRequests` skips issues with an unreleased record, an open child, a hold, a pause, a live claim, or an incomplete blocker, re-reads the issue immediately before closing, and uses `issueRefs(prs, 'closing')`, which matches `(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved) #N` case-insensitively only at the start of a line or after a period and not when preceded by `not` or `n't`.
- `skills/burn-down-github-issues/status.ts`: `Stage` gains `carved` (🔪), `revisited` (🔁), `released` (🪵) and the emoji map entries.
- `skills/burn-down-github-issues/references/architecture.md`: the selection and reconciliation rules.

**Gate:** `bunx tsc --noEmit -p <skills>` passes and `bun test <skills>` passes; from the adopting repository, `bun run <skills>/burn-down-github-issues/loop.ts --dry-run > /tmp/loop-c2.log` and `diff /tmp/loop-after.log /tmp/loop-c2.log` shows only timestamp lines and the new exclusion lines, each with zero hits.

### Commit 3: add the knife's library, prompts, and tests

**Goal:** `carveIssue` works end to end under test and in dry run; no command yet.

**Files created:**
- `skills/carve-github-issue/lib/carve.ts`: `CarveKnobs`, `CARVE_DEFAULTS`, `assertDistinctEngines`, `validateCarving`, `validateConfirmation`, `normalize`, `claim` and `unclaim`, `finishIntent` (from an `applying` or `released` record or a hand-off marker), `reconcilePauses`, `applyGeneration`, `carveIssue`: local lock; read tree; claim; finish unfinished intents; guards and counters; mode from the latest record; run carver; validate; confirm with rounds; fingerprint re-read; apply; unclaim and unlock in `finally` (a `busy` outcome releases only its own claim marker). `CarveOutcome` as in Interfaces. `--fail-after <step>` is honoured here by `process.exit(70)` immediately after the first journal step of that name, bypassing `finally` on purpose, so the next run must repair.
- `skills/carve-github-issue/lib/callbacks.ts`: `runCarveCallback(dir, 'on-carve-pass' | 'on-carve-fail', payload, log)`; the directory is `knobs.callbacksDir`; payload `{ issue, title, mode, verdict, generation: number | null, seam: Seam | null, relation: Relation | null, children: number[], superseded: number[], paused: number[], reason, repo, baseBranch, repoRoot }`.
- `skills/carve-github-issue/prompts/carve.md`, `revisit.md`, `confirm-carve.md`: as described under the answers; the carver prompts load `references/seams.md` by path and receive the previous ledger when there is one; the confirmer prompt is rendered with the round number and, after the first round, the carver's reply.
- `skills/carve-github-issue/references/seams.md`: see "The seams reference".
- `skills/carve-github-issue/references/lifecycle.md`: the states, transitions, intents, invariants, counters, claims, and the board note from this plan's lifecycle section, kept as the skill's durable contract.

**Files rewritten:**
- `skills/carve-github-issue/lib/carve.test.ts` (second part): `validateCarving` (every enum, bounds, cycles, order consistency, headings, criterion ownership, `higherRungs` non-empty below domain, `supersedes.old` against a record, `reference` inside the tree rejected, fan-out with attached references, `affected` present on a hand-off), `validateConfirmation` per mode and finding, `depthOf` at the boundary, `finishIntent` from an `applying` record with some children present and from each interrupted release step and hand-off step, `reconcilePauses` in both directions, the counters' thresholds and that `busy` does not count, the revisit and generation caps, the cap-before-marker ordering, the hold-removal reset; and a driven run of `carveIssue` with a dry-run context and fixture seats through a full carve, a disputed carve to the cap (every leaf paused), a `still-good`, a hand-off with a pause set, and an `exhausted`, asserting `ctx.dryRunLog` and the journal.

**Gate:** `bunx tsc --noEmit -p <skills>` passes and `bun test <skills>` passes.

### Commit 4: add the `carve.ts` command

**Goal:** The skill runs standalone.

**Files created:**
- `skills/carve-github-issue/carve.ts`: `--issue N` (required), `--dry-run`, `--ceiling N`, `--carver`, `--confirmer`, `--fail-after <step>` (refused unless `CARVE_DEV=1`); reads `carve-github-issue.config.ts`, else `burn-down-github-issues.config.ts` (ceiling from `maxPoints`, seats from `seats`, the `carve` block through `blocks: ['carve']` merged over `CARVE_DEFAULTS` and validated with `positiveIntegers`, `callbacksDir` from the top level into `CarveKnobs.callbacksDir`); builds the context as `appraise.ts` does (`promptsDirs: [own prompts, ../appraise-github-issues/prompts]`, `invokeRoot`, `repoRoot`, the pipeline's seats and knobs from the same config); refuses same-engine seats; tees `runs/carve.log`; the same signal handling as `appraise.ts`; prints the outcome; exit code 0 for every confirmed verdict, `resumed`, and `left-alone`, 1 on `failed`, 3 on `busy`.
- `skills/carve-github-issue/SKILL.md`: what it does, trunk and leaves, normalization, the record, claims and intents, the lifecycle in brief, run lines, dependencies, the ceiling paragraph (tracker as untrusted instruction channel; the carver and confirmer must be different engines, and even then their independence is model-level: both run as one GitHub account).
- `skills/carve-github-issue/references/adopting.md`: the `carve` config block (`maxDepth: 3, maxChildren: 8, maxCarveRounds: 5, maxCarveAttempts: 3, maxGenerations: 5, maxRevisitsPerGeneration: 10`), `seats.carver`, the labels, what lands on the tracker, the guards, the boundaries.
- `skills/carve-github-issue/references/callbacks.md`: the two slots, both forms, the payload.

**Gate:** `bunx tsc --noEmit -p <skills>` passes and `bun test <skills>` passes. From the adopting repository:

```bash
body=$'Criteria:\n- A1: a posts table with title and body\n- A2: a posts API with create and list\n- A3: an authors table with a name'
for i in 1 2 3; do gh issue create --title "[carve-test] carve $i" --body "$body" --label "size: 8" --json number --jq .number; done   # note the three numbers as N1 N2 N3
printf '{"issue":%s,"mode":"carve","agree":false,"finding":"gap","seam":"agree","seamCase":"","reason":"A3 unowned"}' "$N2" > <skills>/.gates/gap.json
printf '#!/usr/bin/env bash\ncat >> <skills>/.gates/pass.log\n' > "$(bun -e 'console.log(process.env.CB)' )"/on-carve-pass   # CB is the adopter's callbacksDir; chmod +x it
bun run <skills>/carve-github-issue/carve.ts --issue "$N1" --dry-run
bun run <skills>/carve-github-issue/carve.ts --issue "$N1"
bun run <skills>/carve-github-issue/carve.ts --issue "$N2" --confirmer fixture2:<skills>/.gates/gap.json
CARVE_DEV=1 bun run <skills>/carve-github-issue/carve.ts --issue "$N3" --fail-after create; bun run <skills>/carve-github-issue/carve.ts --issue "$N3"
```

The dry run writes only the log. `N1` has children attached in delivery order, edges, no size label on any child, an `applying` then a `live` record, `loop/carve-gen: 1`, `loop/carved`, no `loop/carving`, and one line in `pass.log`. `N2` logs five rounds, is `needs-human` with a `live` record, has no children, and ran `on-carve-fail`. `N3` after the second run has one generation, no duplicate child, and a `live` record. Clean up with the command above.

### Commit 5: revisit on close, inside and outside the loop

**Goal:** Every leaf close is followed by a revisit of its trunk, and a question on a trunk pauses exactly the leaves it touches.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: `seats.carver` in the config and `--carver` on the command line; `CARVE_KNOBS` from the `carve` block; supplies `ctx.onClosed` and the three-pass sweep as under Revisit triggers; the board marks `revisited` and `released`.
- `skills/burn-down-github-issues/references/architecture.md`: the revisit stage, the sweep, the pause.

**Gate:** `bunx tsc --noEmit -p <skills>` passes and `bun test <skills>` passes. From the adopting repository, on `N1` from Commit 4 (re-created if cleaned):

```bash
bun run <skills>/burn-down-github-issues/loop.ts --limit 1
gh issue comment "$N1" --body "Product question: do we want authors as an entity, or a byline?"
printf '{"issue":%s,"mode":"revisit","verdict":"too-uncertain","reason":"authors are undecided","criteria":[],"ledger":[],"affected":["A3"]}' "$N1" > <skills>/.gates/uncertain.json
bun run <skills>/burn-down-github-issues/loop.ts --limit 0 --carver fixture:<skills>/.gates/uncertain.json
gh issue edit "$N1" --remove-label needs-decision
bun run <skills>/burn-down-github-issues/loop.ts --limit 0
```

The first run works the first leaf by recorded order (with `loop/working` on it while it runs and gone after), posts one roll-up, and the revisit answers `still-good` with a record whose ledger shows one criterion completed and `revisits: 1`. The second leaves `N1` `needs-decision` with exactly the owner of A3 and its dependents carrying `loop/paused` and the others still selected. The third lifts the pauses. Then close the remaining leaves by hand and run `--limit 0`: the sweep revisits, `exhausted` is confirmed, both trunk labels come off, and the appraiser handles the trunk in the same run. Then on a second carved fixture: remove `loop/carved` and `loop/carve-gen: 1` by hand, close its leaves, run `--limit 0`: the second pass finds it and it is exhausted. Then reopen one closed leaf of the released trunk and run `--limit 0`: the second pass hands it to the knife in carve mode and the reopened leaf is adopted, not re-authored. Clean up.

### Commit 6: ship the size callback

**Goal:** An issue sized over the ceiling is carved without the appraiser knowing the knife exists.

**Files created:**
- `skills/burn-down-github-issues/callbacks/on-size-over-ceiling`: a `#!/usr/bin/env bash` template whose second line is the ownership marker `# rendered by burn-down-github-issues; edits are overwritten`; reads stdin into a variable, extracts the issue number with `bun -e` from the JSON, and runs `bun run '{{CARVE_DIR}}/carve.ts' --issue "$issue"` from `'{{REPO_ROOT}}'` with single quotes and `'\''` escaping for the two substituted paths; exits with the knife's code.

**Files rewritten:**
- `skills/burn-down-github-issues/loop.ts`: `placeSizeCallbacks(dir, template, vars, log, dryRun)` exported and pure over its arguments so it is testable; it renders the template to `<dir>/on-size-over-<maxPoints>` by writing a temporary file and renaming it into place with the executable bit set, refusing to overwrite an unmarked file at that name and logging it; before that it removes any other regular file named `on-size-over-*` whose second line is the marker (directories and symlinks are left alone); in a dry run it logs what it would do and returns.
- `skills/burn-down-github-issues/callbacks/README.md`: the shipped callback, the rendering, the marker.
- `skills/burn-down-github-issues/SKILL.md`, `skills/burn-down-github-issues/references/adopting.md`, `skills/burn-down-github-issues/references/operating.md` (including the revisit-cap note), `README.md`: the carving stage, the `carve` config block and `seats.carver`, the labels, the skill row.
- `skills/carve-github-issue/lib/carve.test.ts`: `placeSizeCallbacks` against a temporary directory: render, re-render on a ceiling change, marked file removed, unmarked file kept, dry run writes nothing.

**Gate:** `bunx tsc --noEmit -p <skills>` passes and `bun test <skills>` passes; the adopting repository's config gains the `carve` block and `seats.carver` (that file is the adopter's, edited outside this repository); from there, create a `[carve-test]` issue with the three-criteria body and no size label, run `bun run <skills>/burn-down-github-issues/loop.ts --appraise-limit 1 --limit 0`: the log shows the appraiser sizing it over the ceiling, the callback firing, and a carve log under `runs/`; place an unmarked file at `<callbacksDir>/on-size-over-99`, change `maxPoints` in the config, run `--dry-run`: the log names the re-render and the unmarked file survives. Link check:

```bash
git diff --name-only <base>...HEAD -- '*.md' | while read -r f; do grep -oE '\]\([^)]+\.md[^)]*\)' "$f" | sed 's/.*(\(.*\))/\1/; s/#.*//' | grep -v '^https\?://' | while read -r p; do test -e "$(dirname "$f")/$p" || echo "broken in $f: $p"; done; done
```

prints nothing. Clean up.

### Commit 7: delete this plan

- Verify: every commit above shipped, the verification checklist green, both validation commands green.
- Propose deletion explicitly, naming the path `add-carve-github-issue.md` at the repository root, and wait for the developer's explicit confirmation.
- On confirmation, check the path ends in `.md`, is repository-relative, exists in the working tree, and is the path this plan was created at, `add-carve-github-issue.md`; then delete and commit the deletion alone.
- The methodology (`references/seams.md`), the lifecycle (`references/lifecycle.md`), and the record (`references/the-record.md`) are skill docs and stay.

**Gate:** `bunx tsc --noEmit -p <skills>` passes and `bun test <skills>` passes; `git grep -n add-carve-github-issue` is empty.

## Verification checklist

- [ ] `bunx tsc --noEmit -p <skills>` and `bun test <skills>` pass at every commit.
- [ ] Appraise and burndown dry runs from the adopting repository match the Commit 1 captures after Commits 1 and 2.
- [ ] One standalone carve produced attached children in delivery order, edges, no size labels on children, an `applying` then a `live` record, the generation label, `loop/carved`, and no lingering claim; one adopted or referenced issue where one matched.
- [ ] One forced dispute ran five rounds, left the trunk `needs-human` with a record and every leaf paused, created nothing, and ran `on-carve-fail`.
- [ ] A crash injected after the first child resumed the generation from the `applying` record on the next run without a duplicate.
- [ ] One burndown run claimed a leaf with `loop/working`, worked it by recorded order, released the claim, posted one roll-up, and revisited `still-good` with the ledger and `revisits` updated.
- [ ] One question on a trunk paused exactly the affected leaves and their dependents; removing the hold lifted the pauses.
- [ ] One sweep revisited a trunk whose leaves were closed by hand, confirmed `exhausted`, released it (both labels off), and the appraiser handled it in the same run.
- [ ] One trunk stripped of both labels by hand was found by the second pass and exhausted.
- [ ] One released trunk with a reopened leaf was carved afresh with the leaf adopted.
- [ ] One spike leaf ended in `answered` with confirmed proof on the thread and no pull request; one worker `already-fixed` went through the confirmer.
- [ ] The shipped size callback fired for an issue sized over the ceiling; the rendered file carries the marker; an unmarked adopter file survived a ceiling change.
- [ ] Every transition in the lifecycle table and every intent in the intents table is exercised by a test in `carve.test.ts` or a gate above, and none ends in a state without an owner.
- [ ] Every relative link in the touched Markdown files resolves.
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

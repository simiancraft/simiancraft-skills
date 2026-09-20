# The state machine

The burndown is a hierarchical state machine, and the operator's board is that machine drawn as
kanban: every leaf state is a lane, every phase is a group of lanes, and a card moves when an
event fires. This file is the prose of `lib/machine.ts`, which is the specification the tests
check and the charts are drawn from. Where the two disagree, the code is wrong or this file is
stale; neither is allowed to drift silently, because `lib/machine.test.ts` ties the machine to
the lane table in `lib/lanes.ts`.

The vocabulary is XState's (https://stately.ai/docs): compound states, leaf states, events,
guards, entry actions, `always` transitions, a parallel region, and final states. Paste the
output of `export-machine.ts` into https://stately.ai/viz to walk it; render `chart-machine.ts`
with Graphviz to look at one phase at a time.

## Why a statechart, and why every state is a lane

A flat loop with branches hides its state in control flow: which branch a lane is inside is known
to the process and to nobody else, and when the process dies the knowledge dies with it. A
statechart names every state, so the state can be written somewhere durable (the board, the
labels, the records on the thread) and read back by any run on any machine. The board is the
readable form; a person looks at a lane and knows what is happening to the card without opening
it. The console's old Stage was the coarse form, and its `working` value covered eleven of these
lanes, which is why a stalled run could not be diagnosed from the log.

Collapsing is the direction that works. The `Phase` field on each card is written from a fixed
lane-to-phase table, and a view grouped by Phase is the ten-column board. Nothing can go the other
way: a coarse state cannot be disassembled into the fine one it hides.

## The root: two regions in parallel

```
burndown (parallel)
├── line:   active | paused                 the operator's switch
└── ticket: appraisal | ready | carving | work | review | landing | waits | deadLetters | human | terminal
            + reconcile (transient) + offBoard (final)
```

`line` is the file switch `<worktreeRoot>/runs/line-switch`. It is a region of its own rather than
a state of the ticket so that a pause moves no card: the three seams the loop holds at (appraiser
dispatch, worker dispatch, and the knife's dispatch and revisit) are guards named `lineActive` on
those events, and a card waiting on a paused line stays in its lane while the board's banner says
why. `lib/machine.test.ts` asserts that `lineActive` guards exactly those events and no others.

## Ticket-wide events

Every ticket state inherits these; a leaf does not repeat them.

| Event | Target | Meaning |
|---|---|---|
| `ISSUE_CLOSED` | `terminal.merged` when a merged PR references it, else `terminal.closedWithoutCode` | GitHub is the fact; a closed issue is done whatever the lane said |
| `PR_MERGED` | `terminal.merged`, closing the issue with a pointer | the pull master died between the merge and the close |
| `HOLD_ADDED_BY_PERSON` | the human lane the label names | a person owns it now |
| `SKIPPED` | `offBoard` (final) | `loop/skip`; a person's never |
| `FOREIGN_CLAIM` | `waits.claimedElsewhere` | another run holds a live lease |
| `RUN_STARTED`, `HAND_MOVED` | `reconcile` | re-derive from facts |

## Reconcile: the transient state the precedence lives in

`ticket.reconcile` has no lane. Its entry actions read the issue, its pull requests, its claims,
its records, its labels, and its card; its `always` transitions, tried top to bottom, put the card
where the facts say. Every hold removal, claim release, hand move, and run start enters it. The
order is the rule "GitHub facts beat the lane; the lane beats labels for intent":

1. Issue closed: `terminal.merged` if by a merge, else `terminal.closedWithoutCode`.
2. PR merged, issue open: close with a pointer; `terminal.merged`.
3. Hold labels: `needs-decision`, `needs-human`, `loop/parked`, the five `loop/dlq: <phase>`
   labels, `loop/paused` on the issue or an ancestor.
4. A foreign live claim: `waits.claimedElsewhere`.
5. An own live claim: a trunk by its record (`spawningChildren` on an `applying` record,
   `revisiting` on a moved fingerprint, `carving` when oversized with no record); a leaf by its
   pull request (`landing.approved` with a ready PR and a merge verdict, `review.readyForReview`
   with a ready PR, `work.drafted` with a draft, else `work.coding`).
6. A dead claim, cleared: a draft with pushed work is `deadLetters.work` (finished, never
   declared); a ready PR with a trusted verdict is reclaimed into `review.readyForReview`.
7. Records: `applying` is `spawningChildren`; a `live` record or any open child is
   `childrenInFlight`; `loop/released` is `rollingUp`.
8. An open blocker: `waits.blockedBySibling`.
9. A size label: over the ceiling `carving.toCarve`, within it `ready.ready`; none, `inbox`.

There is deliberately no history state. XState's history would return a card to the state it
left, but entering a state runs its entry actions, and most entry actions here start an agent.
A card that left for a wait comes back through reconcile, which starts nothing it should not.

## The phases and their lanes

Each lane names its entry actions (what starts the moment a card arrives, an agent seat among
them), the events that leave it, and the guards that choose between targets. Counters are the
labels `loop/appraisals`, `loop/carves`, `loop/attempts`, `loop/reviews`, and `loop/redrives`,
mirrored to Number fields on the card.

### Appraisal (read-only; the appraiser and its confirmer)

| Lane | Entry | Leaves on |
|---|---|---|
| A1 Inbox | move card | `APPRAISER_DISPATCHED` [lineActive] to A2 |
| A2 Appraising | run appraiser | `APPRAISED`: close verdict to A3; needs-decision to H1; needs-human to H2; over ceiling to C1 (size label, size callback); within to B1 (size label). `AGENT_FAILED`: under cap back to A1 (count); else Q1 |
| A3 Confirming close | run confirmer | `CONFIRMED` to T2 (both receipts, close); `DISPUTED` to H2 (both opinions); `AGENT_FAILED` to Q1 |

### Ready

| Lane | Entry | Leaves on |
|---|---|---|
| B1 Ready | move card | `DISPATCHED` [lineActive and no open PR] to D1 (claim, worktree); `BLOCKER_OPENED` to W1; `PAUSED_BY_TRUNK` to W2 |

### Carving (the knife; the epic lanes)

| Lane | Entry | Leaves on |
|---|---|---|
| C1 To carve | move card | `KNIFE_DISPATCHED` [lineActive] to C2 (carving claim) |
| C2 Carving | run carver | `CUT_PROPOSED` to C3; `KNIFE_VERDICT`: too-uncertain to H1, indivisible (small-enough, nothing-left, depth cap) to H2; `AGENT_FAILED`: under cap to C1, else Q2 |
| C3 Confirming cut | run carve confirmer | `CUT_CONFIRMED` to C4; `CUT_DISPUTED`: under the round cap to C2, else Q2; `AGENT_FAILED` to Q2 |
| C4 Spawning children | post `applying` record, create children in delivery order, add edges, adopt references, post `live` record, label trunk | `SPAWN_COMPLETE` to C5 (release claim, admit children to the board); `AGENT_FAILED` to Q2 |
| C5 Epic: children in flight | move card | `FINGERPRINT_CHANGED`, `ALL_CHILDREN_CLOSED` [lineActive] to C6 |
| C6 Revisiting | run carver, run carve confirmer | `REVISITED`: still-good to C5; amend to C4 (new generation); exhausted to C7; a question to H1 (pause the touched leaves); anything else to Q2. `CAP_REACHED` to Q2; `AGENT_FAILED`: under cap to C5, else Q2 |
| C7 Rolling up | roll-up comment, `released` record, trunk labels off, `loop/released` on | `ROLLED_UP`: nothing remains to T2; else to A2 (size label off; the release appraisal sizes the remainder) |

A trunk never enters B, D, E, or F. Its children are cards of their own, entering at A1, B1, C1,
or W1 by their own facts. Every child that reaches T1 or T2 fires `FINGERPRINT_CHANGED` on the
trunk. The entry actions of C4 are the `applying` intent the carve lifecycle already announces,
so any run can finish a spawn another run started.

### Work (the worker; one worktree per card)

| Lane | Entry | Leaves on |
|---|---|---|
| D4 Sent back | PR to draft, run worker revision | `DRAFT_PUSHED` to D3; `WORKER_VERDICT` as D1 (with the PR parked on a hold); `AGENT_FAILED` to Q3 (a failed revision parks at once; the attempt counts) |
| D1 Coding | run worker | `WORKER_STARTED_PROOF` to D2; `WORKER_VERDICT`: already-fixed, obsolete, answered to A3 (a close is confirmed by the second engine whoever proposes it); needs-decision H1; needs-human H2; out-of-band over ceiling C1; `AGENT_FAILED`: under cap to B1 (count, release, remove worktree), else Q3 |
| D2 Proving | move card (the worker moves its own card at step 3) | `DRAFT_OPENED` to D3; `AGENT_FAILED` to Q3 |
| D3 Drafted | move card | `PR_READY` to E1; `RUN_DIED` to Q3 (finished work never declared) |

D4 sits left of D1 on the board so a rejection is a visible leftward move.

### Review (the reviewer; concurrent, no writes)

| Lane | Entry | Leaves on |
|---|---|---|
| E1 Ready for review | move card | `REVIEWER_DISPATCHED`: behind the base at all to F2 (no review begins on a stale lane); else E2 |
| E2 Evidence under review | run reviewer | `REVIEWED`: merge to F1 (pin the reviewed head); gather-more or block under the round cap to F2 when the lane fell behind during the review (spend a round; the rejection stands through the catch-up, which hands the card to D4), else to D4 (spend a round); past the cap Q4 (spend, clear rounds). `AGENT_FAILED` to Q4; `PR_TO_DRAFT` to D3 |

### Landing (the pull master; serial)

| Lane | Entry | Leaves on |
|---|---|---|
| F1 Approved | enqueue, ask the merge boundary | `BOUNDARY_REFUSED` to H3 (the boundary is a fact about the change, asked once, before anything waits); `HEAD_MOVED` to E1 (the lane moved past the reviewed commit); `FRONT_OF_QUEUE`: behind the base at all to F2 (nothing lands that lacks the current base); else F3 |
| F2 Catching up | leave queue, merge base into branch | `CAUGHT_UP`, where the closure decides the cost and never the catch-up: a standing approval with the movement outside the closure and the branch's change intact to F3 (pin the caught-up head); a standing approval otherwise, refreshes under cap, to E1 (count refresh); a standing rejection to D4; no verdict yet with the movement outside the closure to E1; no verdict yet otherwise, refreshes under cap, to D2 with a reproof brief (count refresh; the proof is reacquired on the existing pull request and `PROOF_REACQUIRED` returns the card to E1); else Q5. `CONFLICT` to Q5 |
| F3 Checks pending | wait on checks | `CHECKS`: green but behind the base to F2 under the refresh cap, to Q5 past it; green and smoke configured to F4; green to F5; else Q5 |
| F4 Smoke | run smoke | `SMOKE`: passed but behind the base to F2 under the refresh cap, to Q5 past it; passed to F5; else Q5 (tail as the reason) |
| F5 Merging | ask `mayMerge`, check the boundary, merge with the pinned head, confirm | `MERGED` to T1 (close with pointer, put on the floor, follow base); `BOUNDARY_REFUSED` to H3 (a policy handoff, not a failure); `MERGE_UNREPORTED`, `LINE_GAVE_UP` to Q5 |

Only F5 holds the merge lock; F2, F3, and F4 run outside it so one stale branch does not stall
the queue, and F5 re-checks freshness on re-entry.

### Waits (nothing is wrong; something else must move first)

| Lane | Entry | Leaves on |
|---|---|---|
| W1 Blocked by sibling | move card | `BLOCKER_CLOSED`: completed to B1; not completed with an open parent to reconcile (revisit the parent); else H2 |
| W2 Paused by epic | move card | `PAUSE_LIFTED` to reconcile |
| W3 Claimed elsewhere | move card | `CLAIM_RELEASED`, `CLAIM_EXPIRED` to reconcile |

### Dead letters (a machine gave up; its triage may retry)

Each DLQ's entry action runs a triage seat for its phase, which reads the reason and answers
`TRIAGED` with a decision; redrives are counted per epoch and capped. Redrive re-enters the
phase, never Ready.

| Lane | Lands here | Triage decisions and targets |
|---|---|---|
| Q1 Appraisal DLQ | appraiser or confirmer failed past the cap | retry [redrives under cap] to A2 with a strategy (other seat, thread changed, cooling period); else H2 |
| Q2 Carve DLQ | carve failed past the cap; disputed past the round cap; depth, generation, or revisit cap; a spawn that could not finish; a malformed revisit | retry with an `applying` record to C4 (finish, do not redo); retry to C2 (other seat, ceiling raised one rung, ladder started one rung lower, objections as the brief); else H2 with both opinions |
| Q3 Work DLQ | worker failed past the cap; failed on a revision; run died with a dirty worktree or an undeclared draft | oversize to C1; retry with a draft to D3 (reclaim); retry to D1 (other engine, appraisal re-checked, dirty diff attached; attempts cleared); else H3 when a PR exists, H2 otherwise |
| Q4 Review DLQ | review rounds exhausted; no trusted verdict | rerun a crashed reviewer to E1; retry to D4 (reviewer's words as the brief, other engine); a design objection to H1 with the question extracted; else H3 |
| Q5 Landing DLQ | conflicts; red or unfinished checks; smoke failure; refresh cap; unreported merge | resolve conflict to F2 (one bounded catch-up turn); retry to F1 (rerun red checks once, wait for a quiet base, smoke retried once); else H3 |

### Human (only a person can move it)

| Lane | Leaves on |
|---|---|
| H1 Needs decision | `HOLD_REMOVED`: a trunk to C6 (new epoch, forced revisit); a leaf to A1 (size label off; the answer may change the size) |
| H2 Needs human | `HOLD_REMOVED` to reconcile (the capped counter cleared first) |
| H3 Parked | `HOLD_REMOVED` to B1 (PR unparked and kept for reuse; the redrive continues the branch, never opens a second PR); `LANDED_BY_HAND` to T1 |

### Terminal

| Lane | Leaves on |
|---|---|
| T1 Merged | `WALKED`: passed to T3; failed stays with the incident noted. `REOPENED` to reconcile as a new episode |
| T2 Closed without code | `REOPENED` to reconcile |
| T3 Verified on the floor | `REOPENED` to reconcile |

T1 and T2 roll up to the parent on entry. T3 exists only when `floor` is configured.

The worker's turn is atomic to the driver. Proving and Drafted are the worker's own progress
reports from inside one agent turn (it moves its own card with `card.ts`); the event the driver
acts on is `WORKER_VERDICT`, answered at the Work phase from whichever of its four lanes the card
was last reported in: fixed with a ready pull request to E1, fixed without one to Q3, a close to
A3, and the hand-offs to their human lanes. A person's `fix.ts --issue N` is `PERSON_DISPATCHED`
from the Inbox straight to Coding, skipping the sizing pass but not the worker's own appraisal.

Merging parks only when the issue changed under the review (`ISSUE_CHANGED_UNDER_REVIEW`). Its
last act before the merge is one more look upstream: `BASE_MOVED_WHILE_WAITING` returns the card
to F2 under the refresh cap, and to Q5 past it, since a paused line can hold a card here long
enough for something else to land. Checks and smoke take time too, so upstream is looked at as
each one finishes and before the card enters the next lane: no card is ever in Smoke or Merging
lacking the base.

A redrive (`REDRIVEN`, from H3, Q3, Q4, or Q5) continues the pull request the work left: to F2
when the lane is behind the base, else to D4 with the objection as the brief, else through
reconcile when there is no pull request. Reconcile puts an unclaimed pull request in E1 or D3,
never back in Ready, so a hold a person lifts by removing the label lands where a redrive would.

## Demotions the loop makes

E2 to D4 (rejection, round spent); E2 to F2 (rejection on a lane that fell behind; then F2 to D4); F3 or F4 to F2 (the base moved while a gate ran); E1 to F2 (the base moved before the review); F2 to E1 (stale approval, no round spent); F2 to D2 (stale proof, no round spent); F2 to D4 (the
standing verdict was a rejection); D1 to B1 (failed attempt, attempts remain); C3 to C2 (cut
disputed); C6 to C5 (still-good) and C6 to C4 (amend); C7 to A2 (release appraisal); every Q lane
to its phase's entry on redrive; every H lane through reconcile on hold removal; every W lane
through reconcile when the wait clears; any B, D, E, or F lane to a W lane when a wait appears.

Any other move is a person's override. A backward hand move is honored at the next reconcile when
the facts allow it. A forward hand move is never honored past an entry event that has not
happened: a card dragged to Approved without a merge verdict goes back to where its facts put it,
with a log line saying so.

## What is not a state

The line switch (a parallel region). `loop/skip` (a final state, off the board). Claims and
leases (locks; `ownClaimLive`, `foreignClaimLive`, and `deadClaim` are guards). The counters
(guards `appraisalsUnderCap`, `carvesUnderCap`, `attemptsUnderCap`, `reviewRoundsUnderCap`,
`refreshesUnderCap`, `redrivesUnderCap`, each with an unguarded fallback into a DLQ). Size
(guards `sizedOverCeiling`, `sizedWithinCeiling`). The reason for a park, hold, or dead letter
(a Text field on the card).

## Pressure tests, and what they found

The machine is data so it can be checked. `lib/machine.test.ts` asserts:

- every lane in the lane table is exactly one leaf state, and every leaf state under `ticket`
  is a lane unless it is transient, history, or final;
- every transition target resolves to a state;
- every lane state has at least one transition of its own;
- every lane state is entered by some transition or is its phase's initial state;
- every guarded list of transitions ends in an unguarded fallback, except the four events whose
  verdict sets the pipeline already rejects outside of (`APPRAISED`, `KNIFE_VERDICT`,
  `WORKER_VERDICT`, `HOLD_ADDED_BY_PERSON`);
- `lineActive` guards exactly the seam events, and the `line` region has its paused state;
- every lane can reach a terminal lane or a human lane with guards treated as optimistic edges
  (a guard only removes an edge at run time), and the lanes that can reach only a human lane are
  the waits and the dead letters, by construction;
- no two transitions in one list share a guard, so no transition is dead;
- every counter guard (`...UnderCap`) has an unguarded sibling into a dead-letter or human lane,
  so no retry is unbounded;
- every state whose entry starts an agent handles `AGENT_FAILED` (the smoke lane's `SMOKE` event
  carries its own failure);
- a dead-letter lane exits only into its own phase, a human lane, or the two named
  re-classifications (work to carving on oversize, review to a revision);
- there are no history states.

## Where the checks come from

The checklist is borrowed, not invented. crucible's static analysis of its own machines
(unreachable states, dead transitions, nondeterministic guards, dead ends, cannot-reach-final,
undefined targets) and itemis CREATE's editor findings are the structural half; Step Functions'
rule that `States.ALL` must be alone and last, SQS's `maxReceiveCount` and per-source redrive
allow policy, EventBridge's per-target DLQ with a closed `ERROR_CODE` set, and Temporal's
unlimited-attempts default are the retry half; XState's guard and eventless-transition docs are
the semantics. Two ideas from that survey are not yet built and should be: every dead-letter card
should carry which state failed it, the reason class, and whether a count or an age ran out
(EventBridge's attributes), and a person's close should not be able to teleport a card past the
machine, so GitHub's built-in "item closed sets Status to Done" workflow must be checked on each
new board; the lane writer rewrote every Status option, so whatever that workflow pointed at no
longer exists.

Beyond the home-grown tests, `@xstate/graph` can walk the exported machine for shortest and
simple paths (seed the counter guards at zero, cap minus one, and cap, or the fallback edges are
never walked), `eslint-plugin-xstate` lints the literal for the `always` loop smell, and a
translation to Quint or Alloy would let "every card eventually reaches a terminal or human lane"
be checked as a liveness property rather than a reachability one. No tool was found that renders
a statechart as a kanban board; the one-lane-per-leaf projection appears to be this skill's own.

Writing the machine down found three defects in the prose design that preceded it: a `REVISITED`
answer outside the four named verdicts fell through with no target (now Q2); the return from
"claimed elsewhere" went through a history node, which would have restarted the agent whose
state it returned to (now reconcile); and two references disagreed with the carve path (an
oversized issue was "left alone" in one and "handed off" in another; both now say carving).

Looking at the rendered chart found one more: the whole machine is unreadable at any size, and
the reconcile fan-out swamps every phase, so the chart script draws one phase with its exits by
default and draws reconcile edges only where they land inside that phase.

## Tools

```bash
bun test <skill-dir>/lib/machine.test.ts                       # the checks above
bun test <skill-dir>/lib/simulate.test.ts                      # the machine executed: no leaks, no orphans, single-file landing, and the recorded real runs replayed as legal moves
bun test <skill-dir>/lib/scenarios.test.ts                     # several cards against one moving base: overlap, revoked proof, failures, the base moving during checks
bun run <skill-dir>/export-machine.ts > burndown.machine.js    # XState v5 createMachine, for stately.ai/viz
bun run <skill-dir>/chart-machine.ts --phase landing | dot -Tsvg > landing.svg   # one phase, Graphviz
bun run <skill-dir>/lanes.ts                                   # write the lanes and the Phase field onto the board
```

The exporter and the chart read the same data as the tests, so a chart that looks wrong is a
machine that is wrong, and the fix is in `lib/machine.ts`.

## The agent pool: seats are polymorphic, the lane picks the prompt

An agent is not a role that owns a ticket. It is a seat that runs whatever the card's lane
calls for, then lets go. Every lane whose entry action starts an agent names the prompt it
runs (appraiser, confirmer, carver, carve confirmer, worker, worker in revision, reviewer,
triage), so a pool of seats is lane-agnostic: a seat takes a card, reads its lane, runs that
lane's prompt, writes the result, moves the card, releases. The issue's position in the matrix
is the only input that changes what the seat does.

The dispatcher this implies is a pull over the board, not a push over a selection list:

1. Read every card whose lane has an agent entry action and whose claim is free, in board
   order within each phase (A2, A3, C2, C3, C6, D1, D4, E2, F4, Q1 to Q5).
2. Respect the WIP limit of the card's phase (the Kanban Guide's WIP control, a per-phase
   concurrency in the config), and the line switch at the three seams.
3. Take the claim. The claim is the lock: two seats never take the same card, on one machine
   or across machines, and a second operator's board shows the card as Claimed elsewhere.
4. Run the lane's prompt on an engine of the class the lane names (below), write the verdict,
   raise the lane event, release the claim.

Three rules carry over from the per-issue loop and must survive the change:

- **Engine per seat still matters.** The prompt is polymorphic, but the reviewer and confirmer
  lanes must run on a different engine than the worker and carver lanes, or the merge gate
  inherits the author's blind spots. A pool slot has an engine; a lane names the engine class it
  wants (author or judge); the dispatcher matches them.
- **Claims are the lock.** The thirty-minute lease with five-minute renewal on the issue
  thread, posted then re-read, tie broken by comment id. `claim-race.ts` proves it on the real
  tracker: N contenders at one instant, one winner per round, every loser posting and
  withdrawing. The claim outlives a lane step only when the next step is the same seat's.
- **The pull master stays singular.** Merging (F5) is the one serial lane; every other lane runs
  as wide as its phase's WIP limit allows.

How far that is built: `loop.ts` dispatches from the placement by lane. The run start computes
where every card's facts put it (the `reconcile` above, for the whole window at once), writes the
cards whose lane differs, and takes the appraisers' queue from the Inbox and the workers' queue
from Ready; nothing is selected by reading labels a second way. Each seat moves the card it
holds: the driver at the appraisal verdicts, the knife at its outcomes, the worker itself at
Proving and Drafted (through `card.ts`, rendered into its prompt), and the fix pipeline at every
seam from Coding to Merged. What is not yet built is the split past the driver's seams: a Ready
card still runs from Coding to Merged inside one process, so a dispatcher cannot hand Evidence
under review to a different seat than the one that coded, and the per-phase WIP limit is the
single `concurrency` knob. That split is the pipeline's functions cut at the lane events they
already raise, and until it lands the per-issue pipeline at concurrency N is the pool, and it
exercises the same locks.

## What the loop does not yet do

The machine is the specification. The gaps between it and the code, each a change to code rather
than to this file:

- no triage seat: every dead-letter lane waits for a person, and `redrivesUnderCap` is counted
  (`loop/redrives: N`) but not enforced, since only a person redrives today;
- the appraisal and carve queues (Q1, Q2) are labels the placement reads, but the appraiser and
  the knife still hand their capped failures to `needs-human` rather than write them;
- the pipeline runs Coding through Merged in one process, so the Review and Landing phases
  cannot be staffed by a different seat than Work, and there is one WIP limit rather than one
  per phase;
- a hand move on the board is not read back: the next run's placement overrides it with the
  facts, with a log line saying so, which is right for a forward move and loses a deliberate
  backward one;
- the fix pipeline's verdicts live in local lane files, so two resume windows stay unrecoverable
  by a run on another machine; the carve lifecycle's announced intents are the model to follow.

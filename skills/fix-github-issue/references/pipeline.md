# The fix pipeline

What happens between "this issue is real" and "this pull request merged", and why each step is
where it is. The driver that selects issues is somebody else's concern; this file is the machinery
one issue passes through.

## Shape

```
coder ──▶ push ──▶ prover ──▶ ready PR ──▶ review ──────────────────▶ pull master ──▶ merge
  ▲                  │                    (concurrent, no writes)    (one at a time)  ├▶ stale  ──▶ catch up, review again
  └── unprovable ────┘                                                                ├▶ revise ──▶ gather-more to the prover, block to the coder
                                                                    ├▶ park   ──▶ leave for a human
                                                                    └▶ dlq    ──▶ the landing dead-letter queue
```

Coding and reviewing are concurrent; merging is not. The **pull master** is the only serial stage,
because the base branch is the one thing every lane shares. It holds no agent and starts none, so
the serial section stays short: it decides whether a finished review still applies, and merges.

A review is a judgement about **one commit**, recorded with the SHA it read. The pull master decides
separately whether that judgement still holds when the branch reaches the front of the queue. An
earlier version updated branches from the base after they were reviewed, which moved the head out
from under a finished approval and forced lanes to park.

**One engine implements, another judges.** The two seats are set separately on purpose: a reviewer
built from the same model as the author shares its blind spots by construction, and the merge gate
exists precisely to have blind spots the author does not. The reviewer runs as its own process with
no shared context, reads the pull request and its receipts, re-runs the configured check and install
commands rather than trusting a claim of green, and returns a verdict.

## One terminal outcome per issue

| Outcome | What it means |
|---|---|
| `merged` | the reviewer approved, the proof was still fresh, the checks were green, and the branch landed |
| `closed` | a verdict ended the issue without code: already fixed, or obsolete; the receipt is a comment |
| `handed-off` | a person is needed: a product decision, or access an agent lacks. Work the worker finds larger than its appraisal is `out-of-band`, which a driver hands to carving, not to a person |
| `parked` | a pull request exists and a person owns the next call: the merge boundary refused it, or the issue changed under the review; the issue carries the reason |
| `dlq` | a machine gave up: the issue carries `loop/dlq: <phase>` (work, review, or landing from this pipeline) and the reason that put it there |
| `failed` | the worker or its confirmer failed with attempts remaining: the attempt is counted on the issue (`loop/attempts: N`) and the card goes back to Ready |
| `left-alone` | the live gate refused the issue (a hold, a closed issue, a size over the ceiling); nothing was written, except under `--redrive` or `--land`, whose lift and released claim stand |
| `busy` | another run's claim on the issue stands; nothing was written, and the driver places the card for it |
| `not-run` | a dry run reached a seat it does not run; nothing was tried, so nothing failed |
| `stopped` | the operator's stop unwound the lane; nothing was settled, and the lane is kept for the next run |
| `lease-lost` | this run's lease on the issue ran out unrenewed; its agents were stopped and nothing more was written |
| `unjudged` | the lane ended on an environment fault (`fault` names it: `ENOSPC`, `ENOMEM`, or `stopped`); nothing was counted or held, the claim is released, the lane cleared, and the work is rerun later; on a host fault the driver's `onHostFault` hook was told, which the burndown answers by pausing the line. The same host fault again on the rerun is charged instead; see "Environment faults" |

## The verdict-file contract

Agents answer on disk, not in prose. Each role writes one JSON file into its lane, and the driver
reads that file; the agent's last message is a fallback channel, parsed for the first JSON object
it contains, because an agent that answered in chat has still done the thinking.

The Work phase is two seats. The coder (`code-github-issue`, `loop-code.json`) writes a verdict
naming its issue, one of `coded`, `already-fixed`, `obsolete`, `needs-decision`, `needs-human`,
`out-of-band`, `answered` (a `spike` issue's questions, answered with evidence and no pull request),
or `failed`, a reason, and for `coded` the branch, the pushed commit, the commit the gate passed
on, a hand-off for the prover, and what the change touches. `coded` is believed only when that
commit is the lane's head and the remote's head of the branch; the driver then announces it on
the issue as a `<!-- loop-step coded ... -->` comment carrying the hand-off. The prover
(`prove-github-issue`, `loop-proof.json`) writes `proved` with the ready pull request and the head
it proved, `unprovable` with what the coder must fix, a hand-off verdict, or `failed`. The coder's
file is spent once its verdict is read, so the driver deletes it, with any old proof, before the
prover starts; a `loop-code.json` found after the prover's turn is the prover's misplaced answer,
and the failure says so. Together they
are one `WorkerResult` (`fixed` with the pull request, or the escape either seat took), which is all
the review and landing read. A verdict outside either set reads as no verdict at all.

Where a first attempt starts is read from facts, never from a dead process's memory (`placeWork`):
a `coded` announcement whose commit is still its branch's head on the remote is proved, not coded
again; an `unproved` one is coded again on its branch with what could not be shown; a branch that
moved past its announcement is continued by a coder; anything else starts from the base. A refused
proof spends one attempt and goes straight back to a coder in the same process, until the attempts
run out.

The reviewer writes a decision of `merge`, `gather-more`, or `block`, its adequacy judgement, its
confidence, the blocking items, and its own classification of the diff. A decision outside that
set, or one naming a different pull request, reads as no verdict: anything that is not an explicit
rejection would otherwise fall through to the merge path.

A verdict from a process that exited non-zero is never a verdict. Treating one as trustworthy is
how a crashed reviewer's parting words could approve a merge.

## The review budget

`maxReviewRounds` is a **per-issue high-water mark, not a per-run allowance**. The count lives on
the issue as a label, so rounds spent in an earlier run are already spent. At the cap the issue is
ejected to the **review dead-letter queue** (`loop/dlq: review`): retained with the objection that
outlived the budget, and invisible to selection. The ejection clears `loop/reviews: N` (every
phase's dead letter clears its own counter), so removing the label, or `fix.ts --redrive`, is a
redrive with a fresh budget, and each redrive is counted on the issue as `loop/redrives: N`. This is what stops an
issue nobody can get right from cycling between worker and reviewer forever, one restart at a
time.

`fix.ts --redrive` and `--land` take the issue's claim before they lift its hold, then run the live
gate. A run that starts between those writes finds the hold or the claim, never neither, so its
startup walk leaves the lane alone instead of judging it stranded. A gate that still refuses the
issue, or a lift that fails, releases the claim.

A round is spent whenever a rejection sends the work back or parks it, and recorded before the
revision starts, so a run killed mid-revision refunds nothing. Four things deliberately cost no
round: a reviewer that crashes or exits nonzero without a trusted verdict, which is not evidence
the issue is unworkable; a `stale` outcome, which is upstream churn rather than a defect in the
change; an approval the pull master declines to land (the merge boundary, a red check, a failed
smoke, a conflict, a refused line), which is not an objection a revision could answer; and a
merge, which ends the accounting because the issue is closing.

Parked and dead-lettered are different states. Parked means a person owns the next call, and
only three things park: the merge boundary refusing an approved change, the issue changing under
the review (a hold, a pause, a claim), and a person's hold on the pull request itself. A dead letter means a machine gave up, and which queue says
which machine: `loop/dlq: work` for a worker that failed past its attempts, failed on a revision,
named no pull request, or left a draft or a dirty tree; `loop/dlq: review` for a spent budget or
a reviewer with no trusted verdict; `loop/dlq: landing` for a conflict, red or unfinished checks,
a failed smoke, the refresh cap, a refused line, or an unreported merge. The burndown's appraisal
and carve queues are its own. Each queue is meant to be triaged differently
(`burn-down-github-issues/references/state-machine.md`, "Dead letters"); today every one waits
for a person, and the pull request carries the same label so the branch says what the issue says.

A hand-off is not a park either, and which seat made it decides what happens to a pull request.
A coder's `needs-decision`, a prover's `needs-decision`, and a coder's `needs-human` with no pull
request close any pull request the work had: nothing behind them is proved. A coder's `needs-human`
on a pull request it was continuing is an outside stop that waits on a person: the pull request goes
back to draft and stays open with its approval and receipts, the issue and the pull request carry
`needs-human`, and the issue gets an `outside` stop record (cause `base` when the coder answered
`"outside": "base"` because the gate fails on the untouched base, else `needs-person`). Lifting the
hold continues the work, with the record's words as the coder's brief. A prover's `needs-human` comes after the code
was pushed and announced, so the work is held where it stands (`WorkerResult.seat` says which seat
answered): the pull request stays open, the issue and the pull request both carry `needs-human`,
the issue gets a `proof-held` stop record with the reason and how the hold comes
off, and the lane is retired (the branch is on the remote). Removing the issue's label is the whole
pickup. With a pull request, the facts put the card in Drafted or Ready for review, the burndown
resumes it with no objection (the held proof is none), and the prover makes the proof current on
the same pull request; with none, Ready, where the `coded` announcement is proved, not coded again.
`fix.ts --issue N` continues the pull request of a held proof once the hold is off, and
`fix.ts --issue N --redrive` lifts that hold itself. The pickup takes `needs-human` off the pull
request with the issue's, but only while the held proof is the newest stop on the thread; the merge
gate refuses a pull request that carries `needs-human`, `needs-decision`, or `loop/skip`, and parks
the issue saying so.

A reviewer rejection, whether `gather-more` or `block`, sends the work back for a revision rather
than parking it. Both name something a worker can act on, so giving up on the first one throws away
budget the issue never used.

## The merge boundary

`autoMerge` says what may land without a person: `always`, `code-only`, or `never`.

The five kinds are `code`, `ci`, `data`, `migration`, and `stored-string`. `ci` is the pipeline
itself, which is what the config's `touchPaths.ci` points at (workflow files) and, for the two
self-reports, any change to which commands CI runs or how it judges them; a test, a story, a
fixture, or a runner's configuration that the existing commands read is `code`. Both prompts say
so, because the union below means one over-report on either side parks the change.

The boundary does not rest on the worker's self-report alone. The classification the merge decision
uses is a union of three accounts: what the worker declared, what the reviewer independently
declared, and what a scan of the diff's paths against the configured `touchPaths` mechanically
shows, so an omission on any side can never widen what may merge. The residue is honest: `data` and
`stored-string` name runtime effects a path cannot reveal, so for those two the union of two
self-reports is the best available account, and it is why `code-only` parks them outright rather
than trusting a classifier. A missing classification from either agent fails closed: for the two
runtime-effect categories the reviewer's report is the only independent check on the worker's, and a
merge without it would rest on one self-report.

A driver can hold an issue at the boundary whatever `autoMerge` says, through the context's
`holdAtBoundary` hook: given the issue about to land and its change (the lane's worktree and the
base ref it lands on), it returns a reason or null. A held change parks like any other boundary
park, its reason appended to the boundary's, so `fix.ts --land` still waives it. The burndown holds
a floor incident's fix this way when the fix undoes a recently merged pull request.

Two boundaries are not knobs, deliberately. The worker never edits production data, and it never
makes a product decision: an issue whose body asks a person to decide, settle, or rule on something
comes back as `needs-decision` with the question stated, however small the diff would have been.
That category is common in most trackers and it is the one place a plausible-looking diff can do
real harm.

A person can land an approved change the boundary parked with `fix.ts --issue <n> --land`. It
refuses anything else before it changes a label: no open pull request, a dead letter, or a newest
park that is not the boundary's (`--redrive` is the command for those). Then it lifts only the park,
on the issue and the pull request, leaving the review and attempt budgets alone, and continues the
pull request with no objection, so it is re-proved and re-reviewed rather than recoded. The pull
master then lands it with every other gate in force: freshness, checks, the smoke command, the line,
and the pinned merge. Only the boundary is waived, only for that issue, and only when both agents
classified the change: a missing classification still fails closed. The pull request carries a
comment that a person cleared it, posted before the remaining gates run.

A lease that cannot be renewed is a lease running out. A renewal that fails is tried again every
minute; when the last confirmed expiry is about to pass, the run marks the lease lost, stops the
agents it has on that issue, and its live gate refuses every merge and close from then on, since
another run may hold the issue by then.

A failing or unfinished build never merges. The pull master waits on the pull request's checks at
the last moment before merging, and when they fail or never finish the landing is a dead letter
(`loop/dlq: landing`) instead; a green local gate is not a substitute. The merge pins the head it read and confirms afterwards that the pull request
actually reports a merge, cancelling anything a merge queue scheduled instead.

The merge pins the head that lands, not the base it lands on. One driver's queue is single file,
and it looks upstream after every gate, but a person or another operator's loop can still merge in
the seconds between the last look and the merge. A repository closes that window by requiring
branches to be up to date before merging; without that rule the pipeline cannot prevent it, so it
detects it: after the merge it compares the base commit the merge landed on with the one the lane
last saw, and when they differ it says so on the pull request and tells the driver
(`unseenBase` on the merge event), so the floor checks that base first.

An observation of the checks is never proof of the whole list: they register one at a time after
a push, so neither an empty list, nor a short green one, nor one that has stopped changing says
that nothing else is coming. What complete looks like is therefore written down: `requiredChecks`
in the config, or the status checks the base branch's protection requires. The checks the reviewed
head carried are added to that list but cannot replace it, since a fast review sees a partly
registered list too. A landing waits until every expected check is present and green on the landing
head, every other check shown is green, and no check suite GitHub has opened on the head is
incomplete; suite data that cannot be read is waited on, never assumed. Checks are judged by name, since
a head can carry several nodes under one name (a run the repository's concurrency rule cancelled, the
skipped jobs of a run made while the pull request was a draft, and the run that counts): a name passes
on a node that succeeded, fails on a node that failed, and has no verdict yet when all it carries is
skipped or cancelled. A check that need not have run may rest on skipped; one that must may not, or a landing
could merge with no check having run, which branch protection alone does not prevent. Which checks
must have run is the written list (`requiredChecks` and the base branch's required status checks) and
every check that had passed on the head the reviewer read, since the approval counted on those. It is
not every name that head carried: a job skipped on every pull request by design (a release, a deploy on
push) was skipped at review too, and is passed over; a check that passed at review and is only skipped
on the landing head has stopped running, and is waited on. Three things this
rule deliberately allows, all on the one head that would land: a node that passed excuses a skipped or
cancelled sibling of the same name, whichever came later, since no ordering is read; `NEUTRAL` counts as
passed; and a check that was already skipped at review, and that the written list does not name, may be skipped. One thing it holds that it used not to: a cancelled
check with no passing sibling waits to `checksTimeoutMinutes` even under a name nobody expects, so a
repository whose concurrency rule cancels runs wants the run that counts to finish, or to be rerun by a
person. The loop never reruns a repository's checks itself. An installed app that opens a
suite on every push and runs nothing in it leaves that suite queued for ever, so such apps are
written down too, by slug, in `idleCheckSuiteApps`: a listed app's suite is passed over while it has
no run in it, and holds the landing like any other once it has one. The list is a person's statement
that the app runs nothing here, not a detection: a listed app that registers its first run after the
landing has passed is not seen, exactly as no observation could have seen it. With no written list the
landing is a dead letter that says so. Only `checks: 'none'` says the repository runs no checks on
a pull request, and every wait ends at `checksTimeoutMinutes`.

## Staying current, and when proof goes stale

**Upstream is more correct until the work is merged.** Every merge moves the base under everything
still in flight, and the base is the truth while a branch is a proposal against it. So no seat
begins on a stale lane, and nothing lands that lacks the current base. There are five moments, and
each one fetches, and merges the base forward (never a rebase) when the lane is behind at all:

| Moment | Who | What a base that moved costs |
|---|---|---|
| before the first line of a fix | the lane is cut from the fetched base | nothing; there is no work yet |
| before proving, at the seam between the two seats | the driver | the prover reruns the checks once, because its head is no longer the gated one |
| before a revision or a redrive | the driver | nothing beyond the merge; the author revises against current code |
| before a review | the driver | see the table below: the proof stands, or goes back to be reacquired |
| before the merge, at the front of the queue | the pull master | see the table below: the approval stands, or the head is reviewed again |

A branch is never updated **while** a review is running against it, because that moves the head out
from under the verdict. The catch-up happens before the reviewer starts and again when the pull
master takes the branch, and the head that lands is the caught-up one: the merge pins it, and the
checks that gate it are the checks of that head.

No seat merges the base itself or chases it mid-turn: staying current happens at the seams, where
the driver catches the lane up before the next seat starts. The driver never resolves a conflict;
one it meets at a seam fails the attempt, and one it meets before a review or the merge is a landing
dead letter.

Catching up and having stale proof are different questions. Whether a lane catches up is decided
by whether it is behind at all. What that catch-up costs is the freshness rule in
[`prove-work-on-github`](../../prove-work-on-github/references/freshness-and-reproof.md): did the
world move beneath the proof. Decay is a function of how much of the incoming change intersects the
paths the proof covers, judged against the commit the proof or the verdict was pinned to, and
judged before the merge, since afterwards the merge base is the base's own tip and every
comparison against it is vacuously empty.

**Covered paths are the import closure, not the edited files.** That distinction is the whole
mechanism. A check-command receipt or a rendered frame depends on every module beneath the
component, so a base change to a shared chassis file invalidates the proof while touching nothing
the diff touched. Comparing filenames alone calls that fresh and merges it. At merge time the
pipeline therefore walks the branch's imports transitively and intersects the incoming change
against that graph. A component's closure can run to dozens of modules, including shared helpers a
filename comparison misses entirely.

Some paths are outside any import graph and invalidate everything in flight: whatever the config's
`alwaysInvalidates` names, typically the lockfile, the manifest, the schema and its migrations,
generated output, build configs, and the workflows. Those short-circuit to stale. The mirror of
that list is `releaseArtifacts`: files the repository's own release machinery rewrites on every
landing, whose movement alone never invalidates an approval, plus a version-only manifest bump,
which is recognized as release noise without an entry. A version bump that also changes anything
else in the manifest (a dependency, a script) is movement. Which commit made the change, and who
authored it, does not enter into it: the files decide. Every catch-up applies the same rule: at
the seam before proving, before a review, before a revision, before a redrive or `--land`, and
before the merge.

Freshness gates an **approval**, not a rejection. A rejection names a gap in the work, and the base
moving does not fill it, so a rejected change catches up and goes straight to its revision rather
than being re-reviewed first. Re-reviewing one only re-derives it, at the cost of a full review
reaching the same verdict twice.

| Incoming change | Before a review | Before the merge |
|---|---|---|
| none | the review starts | the merge proceeds |
| only release noise (files `releaseArtifacts` names, or a version-only manifest bump), none of it in the work's import closure, and protection is known not to require an up-to-date branch | no catch-up; the proof stands and the review starts on the head as it is | no catch-up and no new CI run: the merge itself brings them in, on the head that was checked. Protection that requires an up-to-date branch, or cannot be read, catches up as usual |
| nothing the closure reaches, and the branch's own change is byte-identical across the merge (compared by patch id) | the base is merged in; the proof stands; the review starts on the caught-up head | the base is merged in; the approval stands; the pull master waits on the caught-up head's checks and lands that head |
| inside the closure, or a global invalidator, or the merge altered the branch's own change | the base is merged in; the proof is stale; the card goes back to Proving, not to a revision: the author reruns the checks and reacquires what the movement reached on the same pull request, spending no review round | the base is merged in; the approval no longer describes what would land; the head is **re-reviewed**, spending no round |
| any, on a **rejection** | | the base is merged in and the author revises; the verdict still stands |
| a closure too large to compute | treated as inside the closure; the conservative answer is the cheap one | the same |
| conflicts | a landing dead letter; the driver does not resolve conflicts | the same |

Reproofs and re-reviews caused by the base are bounded together by the refresh cap; past it the
landing is a dead letter, because a base that keeps landing into these files needs a quiet moment
or a person.

A landing also looks upstream after each gate (checks, smoke, the line), and a base that moved
while a gate ran sends it back to catch up. A move made only of release noise needs no catch-up
unless protection requires an up-to-date branch; then it catches up but is not counted against the
refresh cap (`MAX_BASE_REFRESHES`, 2), and has a bound of its own (`MAX_NOISE_REFRESHES`, 6), so a
stream of release commits still ends in a dead letter rather than a loop. Any other move counts,
whoever authored it. The dead letter names the commits that moved the base: short sha, subject,
and author.

Only the merge is serialized. A catch-up and its re-review run outside the lock, because holding it
across a review would stall every other lane behind one stale branch; the lock is then re-entered
with a fresh staleness check, since the base can move again while queued.

## Draft until complete, to protect the CI budget

Every push to an open pull request spends a CI run, and a driver working several issues at once
multiplies that. So the coder pushes before any pull request exists, the prover pushes nothing to
the branch, opens the pull request as a draft, attaches its proof, and marks it ready only as a
statement that the work is proved. A revision round puts it back to draft first, so the pushes in
between are free. Because the coder pushes with no pull request open, a workflow's `on: push`
should be limited to the base branch, or every Coding push spends CI.

The pipeline refuses to review a draft: a draft is the prover's own statement that the work is
unproved, and approving one can bless a branch a coder still intends to push to.

The adopting repository's workflow has to cooperate: gate the job on the pull request not being a
draft and carry the ready-for-review event in the trigger types, so a draft queues nothing and the
checks run once, at the moment the branch is declared finished.

## Resuming what a crash left

The pull master runs inside the driver's process rather than as its own, so merging happens only
while a run is alive. A run that dies after opening pull requests does not strand them outright: the
next start resumes each stranded pull request from the prover's verdict file its lane still holds
(or, in a lane an older run left, the single worker's),
in the same work pool as new lanes and ahead of them in its queue, so a resume waiting on its
checks holds one slot rather than the run. Result-file clearing is role-specific precisely so that starting a
reviewer does not destroy the verdict this resume depends on.

The verdict is trusted only as far as it can be corroborated: it must name the issue whose lane it
sits in, the pull request must still be open, and the lane must sit at that pull request's remote
head, or the resume would review a tree that is not what would merge. The safety labels that gate
selection gate resumption too. So does another run's live claim: a lane whose issue another run holds,
or whose claim cannot be read, is neither judged nor resumed.

Two windows remain unrecoverable, because no trusted verdict exists on disk during them: after the
pull request opens and before the verdict file is written, and during a revision between clearing
the old verdict and landing the new one. Both are reported rather than resumed.

## Embedding the pipeline

A driver hands the pipeline a context and gets one outcome per issue back. Three optional points
let a driver shape the merge without the pipeline learning why:

- **`project.smokeCommand`** runs in the lane after the pull request's checks are green and before
  the merge, against the exact head that would land. A non-zero exit or a timeout
  (`smokeTimeoutMinutes`, ten by default) sends the landing to `loop/dlq: landing` with the
  command's last lines as the reason. A build is not a boot: a change can
  compile, type-check, and pass every test and still fail the moment the result starts, and this
  is the only gate that starts it.
- **`ctx.mayMerge`** is asked once, just before every merge. A driver holding its line waits before
  answering; one that gives up answers with a reason, and the landing is a dead letter
  (`loop/dlq: landing`) without spending a review round. Absent means always allowed.
- **`ctx.afterMerge`** is told once after every confirmed merge, with the issue, the pull request,
  the merged SHA, the time, and the paths that landed, while the lane still exists.
- **`project.laneFiles`** lists files the main checkout holds and git ignores (shared test
  credentials, say) that the driver copies into a lane whenever it makes one, reuses one, or
  resets one for a retry. A lane is a fresh worktree and sees no untracked file otherwise, and
  `installCommand` is only text in the prompts, which not every seat runs. A missing source, or a
  path git does not ignore in the lane, is logged and skipped; the lane is still made.
- **`project.followBase`** fast-forwards the main checkout to the remote base after every confirmed
  merge, so a dev server running there shows each fix as it lands. Only a fast-forward, and only
  when that checkout has the base branch checked out with a clean tracked tree (untracked files
  do not count); another branch, local edits, or a diverged history is logged and left alone. When
  a landed path matches `alwaysInvalidates`, the log says the checkout needs its install or codegen
  rerun. Off by default.

Every park carries its reason to the issue as a comment and to the pull request as `loop/parked`,
whichever gate produced it.

### The stop record

Every stop the loop makes is recorded on the issue in one format (`lib/stop-record.ts`): a
`<!-- loop-stop kind=<kind> ... -->` marker line, then the words a person and the next seat read.
The kinds are `park`, `boundary` (the merge boundary's park, which `--land` may waive),
`dead-letter` (with its `phase`), `proof-held` (with the run, branch, and pull request), `held` (a
seat's `needs-human` or `needs-decision`, with its `verdict`), and `approved`. One reader,
`readStop`, answers what stopped the work last: the newest record the loop's login wrote, since the
open pull request was opened. A park or a dead letter is the objection a redrive hands the coder;
a held proof is proved again; a boundary park or an approval is neither. Threads written before the
record are read by their older markers (`loop-proof-held`, `loop-held`) and by a loop note's words:
a dead-letter queue, a park, and the boundary's `autoMerge is ... and the change touches` reason.
`--land` classifies the comment that was in force when the park label went on the same way.

## Known gaps

Extracting the pull master into its own process, with enough durable state on the pull request to
land without the lane's memory, is the standing design gap.

The import-closure walk follows outgoing imports from the diff's files only: it does not see
reverse consumers of a changed module, dynamic imports, CSS or asset dependencies, or coupling
through the database. The `alwaysInvalidates` list is the blunt instrument covering what the walk
cannot see; a repository with heavy non-import coupling should widen that list rather than trust
the closure. The closure is a much better approximation than filename equality, and it is not a
substitute for CI on the merged result.

Issue bodies and comments are an untrusted instruction channel read by agents whose approval gates
are bypassed; the worktree and read-only contracts are prompts, not sandboxes. The mitigation
today is scope (small sized issues, code-only merges, a second-engine gate) and trust in the
tracker's authors, not enforcement.

Of the five dead-letter queues only the review queue has been exercised end to end, by a redrive
that continued a parked pull request to a merge; the others are written, not proven.

## What a killed agent leaves behind

The driver kills an agent in three cases, and what it does with the answer files differs on purpose.
An agent killed at its cap (`agentTimeoutMinutes`, 45 by default) is never trusted: an engine can exit
0 on its way down, so the run is given exit 124, no seat reads what it left, its answer files are
deleted, and the failure says it timed out and at how many minutes. An agent that ends under an
operator's stop is `stopped`: nothing is settled from it, but its files and its lane are kept, because
the next run start may resume a `fixed` verdict whose pull request is open at the same head. An agent
killed because the run lost its lease is settled as `lease-lost`, and nothing is written. The
asymmetry between the first two is deliberate: a stop interrupts a worker that may have finished,
while a cap kills one that, by definition, had not. A seat that ends on an environment fault, a
person's signal among them, was not judged, and settles as `unjudged`; see below.

### Outside stops

An outside stop is a stop the change did not cause, settled in one place, `settleOutsideStop`
(`lib/environment-fault.ts`), by its cause:

| Cause | Where it comes from | What follows |
|---|---|---|
| `host` | a run ended on `ENOSPC` or `ENOMEM` | the line pauses; the work reruns (a repeat is charged; see below) |
| `signal` | a stop signal the driver did not send | the work reruns on a later run |
| `base` | a coder's `needs-human` with `"outside": "base"` on a pull request | the work waits on a person with its pull request held open in draft |
| `needs-person` | a prover's `needs-human`, or a coder's on a pull request | the work waits on a person with its pull request held open |

Whatever the cause, nothing is counted, no pull request is closed, and the stop is recorded on the
issue as a `loop-stop kind=outside` record naming the cause and the seat (a held proof keeps its own
`proof-held` record). A hold that waits on a person labels the issue and the pull request
`needs-human`; a redrive, or the next run once a person lifts the label, takes it off both and
continues the work. Through an outside stop the pickup reads the stop behind it, so a rerun answers
the same objection it was answering.

### Environment faults

An environment fault is a run that ended for a reason outside the work: the host ran out of disk or
memory, or a person stopped the agent. Such a run says nothing about the work's concept, code, or
proof, so the work was not judged; that is a different fact from judged and failed, and the pipeline
never settles it as a failure. `runAgentOnce` marks a run's `fault` when it exits non-zero with
`ENOSPC` or `ENOMEM` (or their text, `No space left on device`, `Cannot allocate memory`) in the tail
of its log, or when it ends by SIGTERM, SIGINT, SIGHUP, or SIGQUIT, or the exit code an engine that
traps one reports (128 plus the signal's number; `claude -p` exits 143 on SIGTERM), that the driver
never sent: `killAgent` records every process the driver signals. A run with a fault is not retried
and its answer files are deleted like a killed run's.

Every seat that runs an agent refuses such a run with `refuseEnvironmentFault`, which throws an
`EnvironmentFault`: the coder, the prover, the reviewer, the answer's confirmer, the appraiser and
its close confirmer, the carver and its confirmer, and the decision panel's seats. A thrown error
with either errno code, from the driver's own writes or a command it ran, is the same fault. Each
driver settles it through `settleOutsideStop`, the one place the rule lives:

- Nothing is counted, dead-lettered, or held, and the stop is recorded on the issue. The fix pipeline settles the lane as `unjudged`,
  releases the claim, and clears the lane so the rerun starts clean (commits no remote has are kept
  under `refs/loop/rescued/`); kept dirty, a later run would have sent it to the work dead letter.
  The appraisal returns `unjudged` with `retry`, the knife counts no carve, and the panel gives its
  round back and writes no hold.
- A host fault calls the driver's `onHostFault` hook, which the burndown answers by pausing the line
  and, once it is resumed, taking the issue up again in the same run. A person's stop does not
  pause the line, and the burndown leaves the rerun to the next run, so the work they stopped does
  not start again at once. To keep it from running again, add a hold label.
- The exception: a host fault the work itself causes. The first host fault on an issue is free and
  leaves the marker label `loop/environment-fault: <code>@<seat>` (the seat that hit it; the
  driver's own fault names none), so a restart does not forget it. The
  same code again with the marker on the issue is charged as the ordinary failure it then is (an
  attempt, a review dead letter, a counted appraisal or carve), with a reason that says the work
  reproduced the fault on its rerun, and the marker comes off. The marker also comes off when the
  seat that hit it next finishes without a fault (`runAgentOnce` clears it): that seat's work got
  past the faulted point, so a much later fault of the same code is a new occasion and free again.
  Another seat's clean run leaves it: a clean coder run says nothing about the prover's disk. A
  marker that names no seat is cleared by any seat's clean run. A
  different code is free again too. A person's stop is never charged and leaves no marker, only its record.

Two endings cannot be told apart from a person's and are left as failures: SIGKILL, which the
kernel's out-of-memory killer also sends, and an engine that exits 0 when interrupted (`claude -p`
does on SIGINT). The floor's walker and diagnosis turns, and a size or carve callback, count nothing
when they fail, so they are not refused: a failed walk is walked again, and a callback's failure is
logged with no verdict.


# The fix pipeline

What happens between "this issue is real" and "this pull request merged", and why each step is
where it is. The driver that selects issues is somebody else's concern; this file is the machinery
one issue passes through.

## Shape

```
worker ──▶ draft PR ──▶ review ──────────────────▶ pull master ──▶ merge
                        (concurrent, no writes)    (one at a time)  ├▶ stale  ──▶ catch up, review again
                                                                    ├▶ revise ──▶ worker revises
                                                                    └▶ park   ──▶ leave for a human
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
| `failed` | the worker process failed, so its answer is not trusted and nothing durable was written |

## The verdict-file contract

Agents answer on disk, not in prose. Each role writes one JSON file into its lane, and the driver
reads that file; the agent's last message is a fallback channel, parsed for the first JSON object
it contains, because an agent that answered in chat has still done the thinking.

The worker writes a verdict naming its issue, one of `already-fixed`, `obsolete`, `needs-decision`,
`needs-human`, `out-of-band`, `fixed`, or `failed`, a reason, and for a fix the pull request number,
the branch, and what the change touches. A verdict outside that set reads as no verdict at all.

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
outlived the budget, and invisible to selection. Removing the label, or `fix.ts --redrive`, is the
redrive, and each redrive is counted on the issue as `loop/redrives: N`. This is what stops an
issue nobody can get right from cycling between worker and reviewer forever, one restart at a
time.

A round is spent whenever a rejection sends the work back or parks it, and recorded before the
revision starts, so a run killed mid-revision refunds nothing. Four things deliberately cost no
round: a reviewer that crashes or exits nonzero without a trusted verdict, which is not evidence
the issue is unworkable; a `stale` outcome, which is upstream churn rather than a defect in the
change; an approval the pull master declines to land (the merge boundary, a red check, a failed
smoke, a conflict, a refused line), which is not an objection a revision could answer; and a
merge, which ends the accounting because the issue is closing.

Parked and dead-lettered are different states. Parked means a person owns the next call, and
only two things park: the merge boundary refusing an approved change, and the issue changing under
the review (a hold, a pause, a claim). A dead letter means a machine gave up, and which queue says
which machine: `loop/dlq: work` for a worker that failed past its attempts, failed on a revision,
named no pull request, or left a draft or a dirty tree; `loop/dlq: review` for a spent budget or
a reviewer with no trusted verdict; `loop/dlq: landing` for a conflict, red or unfinished checks,
a failed smoke, the refresh cap, a refused line, or an unreported merge. The burndown's appraisal
and carve queues are its own. Each queue is meant to be triaged differently
(`burn-down-github-issues/references/state-machine.md`, "Dead letters"); today every one waits
for a person, and the pull request carries the same label so the branch says what the issue says.

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

Two boundaries are not knobs, deliberately. The worker never edits production data, and it never
makes a product decision: an issue whose body asks a person to decide, settle, or rule on something
comes back as `needs-decision` with the question stated, however small the diff would have been.
That category is common in most trackers and it is the one place a plausible-looking diff can do
real harm.

A failing or unfinished build never merges. The pull master waits on the pull request's checks at
the last moment before merging and parks instead when they fail or never finish; a green local gate
is not a substitute. The merge pins the head it read and confirms afterwards that the pull request
actually reports a merge, cancelling anything a merge queue scheduled instead.

The merge pins the head that lands, not the base it lands on. One driver's queue is single file,
and it looks upstream after every gate, but a person or another operator's loop can still merge in
the seconds between the last look and the merge. A repository closes that window by requiring
branches to be up to date before merging; without that rule the pipeline cannot prevent it, so it
detects it: after the merge it compares the base commit the merge landed on with the one the lane
last saw, and when they differ it says so on the pull request and tells the driver
(`unseenBase` on the merge event), so the walker checks that base first.

An observation of the checks is never proof of the whole list: they register one at a time after
a push, so neither an empty list, nor a short green one, nor one that has stopped changing says
that nothing else is coming. What complete looks like is therefore named: by `requiredChecks` in
the config, or else by the checks the reviewed head carried, which had the length of a review to
register. A landing waits until every expected check is present and green on the landing head,
every other check shown is green, and no check suite GitHub has opened on the head is incomplete;
suite data that cannot be read is waited on, never assumed. With nothing to name the expected
checks the landing is a dead letter that says so. Only `checks: 'none'` says the repository runs no
checks on a pull request, and every wait ends at `checksTimeoutMinutes`.

## Staying current, and when proof goes stale

**Upstream is more correct until the work is merged.** Every merge moves the base under everything
still in flight, and the base is the truth while a branch is a proposal against it. So no seat
begins on a stale lane, and nothing lands that lacks the current base. There are five moments, and
each one fetches, and merges the base forward (never a rebase) when the lane is behind at all:

| Moment | Who | What a base that moved costs |
|---|---|---|
| before the first line of a fix | the lane is cut from the fetched base; the worker fetches again | nothing; there is no work yet |
| before proving, and before marking ready | the worker, in its own turn | a rerun of the checks, and any receipt captured before the merge |
| before a revision or a redrive | the driver | nothing beyond the merge; the author revises against current code |
| before a review | the driver | see the table below: the proof stands, or goes back to be reacquired |
| before the merge, at the front of the queue | the pull master | see the table below: the approval stands, or the head is reviewed again |

A branch is never updated **while** a review is running against it, because that moves the head out
from under the verdict. The catch-up happens before the reviewer starts and again when the pull
master takes the branch, and the head that lands is the caught-up one: the merge pins it, and the
checks that gate it are the checks of that head.

A worker that meets a conflict while merging forward resolves it toward upstream and re-applies
its change on top, with one exception: where the conflicting upstream lines are the very defect
the issue exists to fix, the fix stands and the pull request says which upstream commit it
overrode. The driver itself never resolves a conflict; one it meets is a landing dead letter.

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
which is recognized as release noise without an entry.

Freshness gates an **approval**, not a rejection. A rejection names a gap in the work, and the base
moving does not fill it, so a rejected change catches up and goes straight to its revision rather
than being re-reviewed first. Re-reviewing one only re-derives it, at the cost of a full review
reaching the same verdict twice.

| Incoming change | Before a review | Before the merge |
|---|---|---|
| none | the review starts | the merge proceeds |
| nothing the closure reaches, and the branch's own change is byte-identical across the merge (compared by patch id) | the base is merged in; the proof stands; the review starts on the caught-up head | the base is merged in; the approval stands; the pull master waits on the caught-up head's checks and lands that head |
| inside the closure, or a global invalidator, or the merge altered the branch's own change | the base is merged in; the proof is stale; the card goes back to Proving, not to a revision: the author reruns the checks and reacquires what the movement reached on the same pull request, spending no review round | the base is merged in; the approval no longer describes what would land; the head is **re-reviewed**, spending no round |
| any, on a **rejection** | | the base is merged in and the author revises; the verdict still stands |
| a closure too large to compute | treated as inside the closure; the conservative answer is the cheap one | the same |
| conflicts | a landing dead letter; the driver does not resolve conflicts | the same |

Reproofs and re-reviews caused by the base are bounded together by the refresh cap; past it the
landing is a dead letter, because a base that keeps landing into these files needs a quiet moment
or a person.

Only the merge is serialized. A catch-up and its re-review run outside the lock, because holding it
across a review would stall every other lane behind one stale branch; the lock is then re-entered
with a fresh staleness check, since the base can move again while queued.

## Draft until complete, to protect the CI budget

Every push to an open pull request spends a CI run, and a driver working several issues at once
multiplies that. So the worker finishes and pushes everything before opening anything, opens the
pull request as a draft, attaches its proof, and marks it ready only as a statement that the work is
feature complete. A revision round puts it back to draft first, so the pushes in between are free.

The pipeline refuses to review a draft: a draft is the worker's own statement that the work is
unfinished, and approving one can bless a branch it still intends to push to.

The adopting repository's workflow has to cooperate: gate the job on the pull request not being a
draft and carry the ready-for-review event in the trigger types, so a draft queues nothing and the
checks run once, at the moment the branch is declared finished.

## Resuming what a crash left

The pull master runs inside the driver's process rather than as its own, so merging happens only
while a run is alive. A run that dies after opening pull requests does not strand them outright: the
next start resumes each stranded pull request from the worker verdict file its lane still holds,
before selecting anything new. Result-file clearing is role-specific precisely so that starting a
reviewer does not destroy the verdict this resume depends on.

The verdict is trusted only as far as it can be corroborated: it must name the issue whose lane it
sits in, the pull request must still be open, and the lane must sit at that pull request's remote
head, or the resume would review a tree that is not what would merge. The safety labels that gate
selection gate resumption too.

Two windows remain unrecoverable, because no trusted verdict exists on disk during them: after the
pull request opens and before the verdict file is written, and during a revision between clearing
the old verdict and landing the new one. Both are reported rather than resumed.

## Embedding the pipeline

A driver hands the pipeline a context and gets one outcome per issue back. Three optional points
let a driver shape the merge without the pipeline learning why:

- **`project.smokeCommand`** runs in the lane after the pull request's checks are green and before
  the merge, against the exact head that would land. A non-zero exit or a ten-minute timeout parks
  the pull request with the command's last lines as the reason. A build is not a boot: a change can
  compile, type-check, and pass every test and still fail the moment the result starts, and this
  is the only gate that starts it.
- **`ctx.mayMerge`** is asked once, just before every merge. A driver holding its line waits before
  answering; one that gives up answers with a reason, and the pull request parks without spending
  a review round. Absent means always allowed.
- **`ctx.afterMerge`** is told once after every confirmed merge, with the issue, the pull request,
  the merged SHA, the time, and the paths that landed, while the lane still exists.
- **`project.followBase`** fast-forwards the main checkout to the remote base after every confirmed
  merge, so a dev server running there shows each fix as it lands. Only a fast-forward, and only
  when that checkout has the base branch checked out with a clean tracked tree (untracked files
  do not count); another branch, local edits, or a diverged history is logged and left alone. When
  a landed path matches `alwaysInvalidates`, the log says the checkout needs its install or codegen
  rerun. Off by default.

Every park carries its reason to the issue as a comment and to the pull request as `loop/parked`,
whichever gate produced it.

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

Dead-letter-queue ejection has not been exercised end to end. It is written; it is not proven.

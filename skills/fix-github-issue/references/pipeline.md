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
| `handed-off` | a person is needed: a product decision, access an agent lacks, or work outside the size band |
| `parked` | a pull request exists and a human owns the next call; the issue carries the reason |
| `dlq` | the per-issue review budget is spent; the issue is retained with the objection that outlived it |
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
ejected to the **dead-letter queue**: labelled, retained with the reason that put it there, and
invisible to selection. Removing the label is the redrive. This is what stops an issue nobody can
get right from cycling between worker and reviewer forever, one restart at a time.

A round is spent whenever a verdict sends the work back or parks it, and recorded before the
revision starts, so a run killed mid-revision refunds nothing. Three things deliberately cost no
round: a reviewer that crashes or exits nonzero without a trusted verdict, which is not evidence
the issue is unworkable; a `stale` outcome, which is upstream churn rather than a defect in the
change; and a merge, which ends the accounting because the issue is closing.

Parked and DLQed are different states. Parked means a human should look at it, and it is where a
reviewer that crashed, a conflict, or an `autoMerge` refusal ends up. The DLQ means the pipeline
tried, spent the budget, and the objection outlived it.

A reviewer rejection, whether `gather-more` or `block`, sends the work back for a revision rather
than parking it. Both name something a worker can act on, so giving up on the first one throws away
budget the issue never used.

## The merge boundary

`autoMerge` says what may land without a person: `always`, `code-only`, or `never`.

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

## Staying current, and when proof goes stale

Every merge moves the base under everything still in flight. A branch is brought up to date **only
at the front of the queue**, never while a review is running against it, because updating a branch
that has already been reviewed moves the head out from under the approval and the merge then refuses
its own reviewed commit. Freshness is judged against the commit the reviewer read, not against the
current head.

Falling behind is not the same as having stale proof. Following the freshness rule in
[`prove-work-on-github`](../../prove-work-on-github/references/freshness-and-reproof.md), decay is a
function of distance from the base **and** of how much of the incoming change intersects the paths
the proof covers.

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

| Incoming change | What happens |
|---|---|
| nothing the closure reaches | merge proceeds, however far behind the branch was |
| inside the closure, or a global invalidator, on an **approval** | the branch is updated and **re-reviewed**, because the approval was pinned to a head that no longer exists |
| inside the closure, on a **rejection** | the branch is updated and revised; the verdict still stands |
| a closure too large to compute | treated as stale; the conservative answer is the cheap one |
| conflicts | parked for a human; the pipeline does not resolve conflicts |

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

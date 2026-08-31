# Architecture

How and why burn-down-github-issues works: it triages recent issues, fixes the small ones, proves
the work on a pull request, and lets a second agent decide whether it can merge.

```bash
bun run <skill-dir>/loop.ts --dry-run          # select and print; no agent, no mutation
bun run <skill-dir>/loop.ts --limit 3          # work three issues
bun run <skill-dir>/loop.ts --issue 3327       # one issue, ignoring the age and size filters
```

## Shape

Three isolated agent roles, and several issues in flight at once.

```
appraise ──▶ already-fixed / obsolete ──▶ comment with receipt, close
   │      ├▶ needs-decision / needs-human ──▶ label, skip
   │      └▶ valid ──▶ size: N label
   ▼
select (sized, within the ceiling)
   │
   ▼
worker ──▶ PR ──▶ review ──────────────────▶ pull master ──▶ merge
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
from under a finished approval and forced every second lane to park.

**Codex implements, Opus judges.** The worker runs on `codex exec` (`gpt-5.6-sol`); the reviewer runs on
`claude -p` (Opus 5). Splitting the engines is not a preference: a reviewer built from the same
model as the author shares its blind spots by construction, and the merge gate exists precisely to
have blind spots the author does not.

The reviewer runs as its own process with no shared context. That isolation is the whole point: it
is the only thing that catches a worker that convinced itself. It reads the pull request and its
receipts, re-runs the configured check and install commands rather than trusting a claim of green, and returns a
verdict.

Each role is a seat filled by an `engine:model` spec, resolved against an engine registry in
`loop.ts`. The configured defaults are overridable at invocation (`--appraiser`, `--worker`,
`--reviewer`), so trying a new model is a flag rather than an edit, and supporting a new CLI is one
registry entry rather than a refactor. The driver warns when worker and reviewer resolve to the
same engine, because that configuration gives the merge gate the author's blind spots back.

## The skill this depends on

The loop has one hard dependency: its sibling
[`prove-work-on-github`](../../prove-work-on-github/SKILL.md). Both prompts load it by name: the
worker follows its lifecycle to size, acquire, store, and render proof, and the reviewer judges
with the vision and reasoning modes its `references/judgement.md` defines. The pull master's
staleness rule implements that skill's `references/freshness-and-reproof.md` directly; decay is a
function of distance from the base and of how much of the incoming change intersects the proof's
covered paths, and this loop's import-closure walk is a working answer to the covered-paths
intersection that reference still marks as a TODO, so it is a candidate contribution to it.

Install it where each engine can read it. For Claude, the simiancraft-skills plugin carries both
skills. For an engine with no skill loader, the prompt's "load the skill" instruction has to
resolve to files on disk, so keep a checkout of the repo readable from the worktrees.

Provenance: this loop was written for Ultrathin first, adopted by `lifeguides-application` second,
and abstracted here once the shape held in both. The two histories are why the reasoning below
cites concrete issue numbers; they are Ultrathin's.

## Boundaries

The loop-level knobs live in `DEFAULTS` at the top of `loop.ts`; every one of them, and everything
repository-shaped, can be set in the repository's `burn-down-github-issues.config.ts`.

| Knob | Default | Meaning |
|---|---|---|
| `seats.appraiser` | `codex:gpt-5.6-sol` | Who sizes; override with `--appraiser engine[:model]` |
| `seats.worker` | `codex:gpt-5.6-sol` | Who implements; override with `--worker engine[:model]` |
| `seats.reviewer` | `claude:claude-opus-5` | Who judges; override with `--reviewer engine[:model]` |
| `ageDays` | 30 | Only issues opened this recently |
| `maxPoints` | 2 | Fibonacci points the loop will attempt |
| `autoMerge` | `code-only` | Merge code; park anything touching data, a migration, a stored string, or CI |
| `maxReviewRounds` | 3 | Review rounds an issue gets, ever, before the DLQ |
| `limit` | 5 | Issues per run |
| `concurrency` | 2 | Issues worked at once, one worktree each |
| `appraiserConcurrency` | 3 | Appraisers at once; no worktree, so they are cheap |
| `appraiseLimit` | 12 | Issues appraised per run |

`maxReviewRounds` is a **per-issue high-water mark, not a per-run allowance**. The count lives on the
issue as `loop/reviews: N`, so rounds spent in an earlier run are already spent. At the cap the issue
is ejected to the **dead-letter queue**: labelled `loop/dlq`, retained with the reason that put it
there, and invisible to selection. Removing the label is the redrive. This is what stops an issue
nobody can get right from cycling between worker and reviewer forever, one restart at a time.

A round is spent whenever a verdict sends the work back or parks it, and recorded before the
revision starts, so a run killed mid-revision refunds nothing. Three things deliberately cost no
round: a reviewer that crashes or exits nonzero without a trusted verdict, which is not evidence
the issue is unworkable; a `stale` outcome, which is upstream churn rather than a defect in the
change; and a merge, which ends the accounting because the issue is closing.

`loop/parked` and `loop/dlq` are different states. Parked means a human should look at it, and it is
where a reviewer that crashed, a conflict, or an `autoMerge` refusal ends up. The DLQ means the loop
tried, spent the budget, and the objection outlived it.

A reviewer rejection, whether `gather-more` or `block`, sends the work back for a revision rather
than parking it. Both name something a worker can act on, so giving up on the first one throws away
budget the issue never used.

The `autoMerge` boundary does not rest on the worker's self-report alone. The classification the
merge decision uses is a union of three accounts: what the worker declared, what the reviewer
independently declared, and what a scan of the diff's paths against `touchPaths` mechanically
shows, so an omission on any side can never widen what the loop may merge. The residue is honest:
`data` and `stored-string` name runtime effects a path cannot reveal, so for those two the union
of two self-reports is the best available account, and it is why `code-only` parks them outright
rather than trusting a classifier. A missing classification from either agent fails closed: for
the two runtime-effect categories the reviewer's report is the only independent check on the
worker's, and a merge without it would rest on one self-report.

Two boundaries are not knobs, deliberately. The worker never edits production data, and it never
makes a product decision: an issue whose body asks a person to decide, settle, or rule on something
comes back as `needs-decision` with the question stated, however small the diff would have been.
That category is common in this tracker and it is the one place a plausible-looking diff can do
real harm.

## Why worktrees

Every issue gets its own worktree, and that is what lets the loop move on. Work on separate issues
cannot overlap, so a nine-minute fix does not block the queue behind it; `concurrency` lanes run at
once and each pulls the next issue as its own finishes. Branches in a single checkout would
serialize the whole thing and let one agent's `git switch` disturb another's tree.

Two things do not follow the work into isolation, and both are handled:

- **The base branch.** Two pull requests landing on `development` at the same moment is real
  contention, so the merge step queues and happens one at a time.
- **The main checkout.** It is never an agent's working directory; the driver throws rather than
  hand it over, because it holds your branch and your uncommitted work.

## Staying current, and when proof goes stale

Every merge moves the base under everything still in flight. A branch is brought up to date **only
at the front of the queue**, never while a review is running against it, because updating a branch
that has already been reviewed moves the head out from under the approval and the merge then refuses
its own reviewed commit. Freshness is judged against the commit the reviewer read, not against the
current head.

Falling behind is not the same as having stale proof. Following the freshness rule in
`prove-work-on-github`, decay is a function of distance from the base **and** of how much of the
incoming change intersects the paths the proof covers.

**Covered paths are the import closure, not the edited files.** That distinction is the whole
mechanism. A `bun check` receipt or a rendered frame depends on every module beneath the component,
so a base change to a shared chassis file invalidates the proof while touching nothing the diff
touched. Comparing filenames alone calls that fresh and merges it. At merge time the loop therefore
walks the branch's imports transitively and intersects the incoming change against that graph.
Measured on `domain/vendors/list.tsx`: 70 modules, including `data-table/helpers.tsx`, which a
filename comparison misses entirely.

Some paths are outside any import graph and invalidate everything in flight: the lockfile,
`package.json`, `schema.prisma` and its migrations, generated output, build configs, `shared/`, and
the workflows. Those short-circuit to stale.

Freshness gates an **approval**, not a rejection. A rejection names a gap in the work, and the base
moving does not fill it, so a rejected change catches up and goes straight to its revision rather
than being re-reviewed first. Re-reviewing one only re-derives it, which cost #3313 ten minutes of a
reviewer reaching the same verdict twice.

| Incoming change | What happens |
|---|---|
| nothing the closure reaches | merge proceeds, however far behind the branch was |
| inside the closure, or a global invalidator, on an **approval** | the branch is updated and **re-reviewed**, because the approval was pinned to a head that no longer exists |
| inside the closure, on a **rejection** | the branch is updated and revised; the verdict still stands |
| a closure too large to compute | treated as stale; the conservative answer is the cheap one |
| conflicts | parked for a human; the loop does not resolve conflicts |

The closure is a static import walk, so it is an approximation. It does not see dynamic imports
resolved at runtime, string-built paths, or coupling through the database and generated artifacts.
It is a much better approximation than filename equality, and it is not a substitute for CI on the
merged result.

Staleness is measured from the commit the reviewer actually judged, not from whatever the branch
holds by the time it reaches the front of the merge queue.

Only the merge is serialized. A catch-up and its re-review run outside the lock, because holding it
across a six-minute review would stall every other lane behind one stale branch; the lock is then
re-entered with a fresh staleness check, since the base can move again while queued.

## Draft until complete, to protect the CI budget

Every push to an open pull request spends a CI run, and a loop working several issues at once
multiplies that. So the worker finishes and pushes everything before opening anything, opens the
pull request as a draft, attaches its proof, and marks it ready only as a statement that the work is
feature complete. A revision round puts it back to draft first, so the pushes in between are free.

The driver refuses to review a draft: a draft is the worker's own statement that the work is
unfinished, and approving one can bless a branch it still intends to push to.

The workflow cooperates: `pull-request.yml` gates its job on
`github.event.pull_request.draft == false` and carries `ready_for_review` in its trigger types, so
a draft queues nothing and the checks run once, at the moment the branch is declared finished
(#3354). Before that guard landed, `pull_request` fired on drafts too and the discipline above
bought ordering but not budget.

## Everything else concurrent lanes contend on

The worktree isolates the working tree. It does not isolate the machine, and each of these is
handled somewhere specific rather than hoped about.

| Contended | Where it is handled |
|---|---|
| Two loop processes claiming the same issues | pid lock in `runs/loop.lock`; a stale lock is reclaimed |
| Shared `.git` index and refs under parallel git | `sh()` retries contention failures with backoff |
| GitHub secondary rate limits | same retry list; this repo hit one during a burst of label edits |
| A fresh worktree having no `node_modules` | each installs its own; sharing the main checkout's would let the install command write into it |
| The local database, Elasticsearch, and Redis | both prompts forbid seeding, resetting, or migrating them |
| Dev-server and Storybook ports | prompts require a port derived from the issue number |
| The shared evidence branch | prompts forbid force-push and require re-parenting on rejection |

The rule the prompts state plainly: your worktree is yours, and almost nothing else is. An agent
that cannot prove something without mutating shared state is told to return `needs-human` rather
than break another agent's run to get its receipt.

Worktrees are created under the configured `worktreeRoot`, a sibling outside the repository root, so no tool that
walks the working tree has to be told to ignore them (see #3305). Agent logs land in
`<worktreeRoot>/runs/`, and cleanup collects scratch worktrees an agent leaves behind.

Because lanes interleave, every per-issue line on the console is prefixed with its issue number.

A step that throws (a failed fetch, a rejected push, a merge the retries could not save) fails only
its own lane: the pool logs the error and moves on, and because every durable fact lives on the
issue, the next run picks that issue back up from its labels. A crash costs a lane its progress,
never the run its state.

## Sizing

The scale is the [KANBAN-ESTIMATION-SCALE](https://github.com/simiancraft/Ultrathin/wiki/KANBAN-ESTIMATION-SCALE)
wiki page, carried on issues by the `size: N` labels. An issue already sized above the band is left
alone; an unsized issue is sized by the appraiser, which runs as its own cheap population ahead of
the workers.

Where the issue prescribes a remedy that contradicts a written convention (`AGENTS.md`,
`CLAUDE.md`, or what the surrounding code plainly does), the convention wins and the work continues:
the appraiser sizes the remedy the convention implies, and the worker records the divergence in the
pull request. Neither stops for it. A documented convention is a decision already made, so deferring
to it is following that decision rather than making one, and the point ceiling does the stopping
when the convention-respecting fix turns out to be larger.

That rule exists because of #3327, which asked for a Python syntax gate in a repository whose
scripts are TypeScript. Every stage executed it faithfully, because every stage judges the diff
against the issue and nothing was judging the issue against the conventions.

## Known gaps

[`references/judgement.md`](../../prove-work-on-github/references/judgement.md) in the sibling
`prove-work-on-github` skill marks its adequacy-versus-confidence scorecard as not yet written. The bar the reviewer applies is
therefore stated inline in `prompts/review.md` rather than inherited from the skill, and says so.
When that section lands upstream, the reviewer prompt should defer to it instead. Two things worth
carrying up: the sharpest rejection this loop has produced turned on whether the proof exercised
the command CI actually runs, which the skill does not currently ask for; and the import-closure
walk answers the covered-paths TODO in `references/freshness-and-reproof.md`.

The pull master runs inside the loop process rather than as its own, so merging happens only while
a run is alive. A run that dies after opening pull requests no longer strands them outright: the
next start resumes each stranded pull request from the worker verdict file its worktree still
holds, before selecting anything new. What remains unrecoverable is the narrow crash window after
the pull request opens and before the verdict file is written, which is reported rather than
resumed. Extracting the pull master into its own process, with enough durable state on the PR to
land without the lane's memory, is still the standing design gap.

The import-closure walk follows outgoing imports from the diff's files only: it does not see
reverse consumers of a changed module, dynamic imports, CSS or asset dependencies, or coupling
through the database. The `alwaysInvalidates` list is the blunt instrument covering what the walk
cannot see; a repository with heavy non-import coupling should widen that list rather than trust
the closure.

Issue bodies and comments are an untrusted instruction channel read by agents whose approval gates
are bypassed; the worktree and read-only contracts are prompts, not sandboxes. The mitigation
today is scope (small sized issues, code-only merges, a second-engine gate) and trust in the
tracker's authors, not enforcement.

Two paths have never executed in a production run: the transitive import-closure walk (only the
blunt global invalidators have fired so far) and DLQ ejection. Both are written; neither is proven.

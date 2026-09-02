# Architecture

How and why burn-down-github-issues works: it triages recent issues, fixes the small ones, proves
the work on a pull request, and lets a second agent decide whether it can merge.

## Shape

Four roles, three of them isolated agent seats, and several issues in flight at once.

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

Everything from the worker rightward is the sibling
[`fix-github-issue`](../../fix-github-issue/SKILL.md) skill, which this loop calls once per selected
issue; its [`references/pipeline.md`](../../fix-github-issue/references/pipeline.md) is where the
verdict-file contract, the review budget, the merge boundary, staleness, and the resume windows are
written down. What is loop-shaped stays here: appraisal, selection, the pool, and the run's own
durable state.

**One engine implements, another judges.** By default the worker runs on `codex exec` and the
reviewer on `claude -p`; both are seats you can reassign. Splitting the engines is not a preference: a reviewer built from the same
model as the author shares its blind spots by construction, and the merge gate exists precisely to
have blind spots the author does not.

Each role is a seat filled by an `engine:model` spec, resolved against an engine registry in
`loop.ts`. The configured defaults are overridable at invocation (`--appraiser`, `--worker`,
`--reviewer`), so trying a new model is a flag rather than an edit, and supporting a new CLI is one
registry entry rather than a refactor. The driver warns when worker and reviewer resolve to the
same engine, because that configuration gives the merge gate the author's blind spots back.

## The skills this depends on

The loop has two hard dependencies. The first is its sibling
[`fix-github-issue`](../../fix-github-issue/SKILL.md), which owns the worker, the reviewer, and the
pull master, and which the loop imports by relative path; the worker and review prompts live there
too. Skills install one directory at a time, so shared code has to live inside a skill directory
rather than at the collection's root.

The second is [`prove-work-on-github`](../../prove-work-on-github/SKILL.md). Both prompts load it by name: the
worker follows its lifecycle to size, acquire, store, and render proof, and the reviewer judges
with the vision and reasoning modes its `references/judgement.md` defines. The pull master's
staleness rule implements that skill's `references/freshness-and-reproof.md` directly; decay is a
function of distance from the base and of how much of the incoming change intersects the proof's
covered paths, and that reference's covered-paths method is this loop's import-closure walk,
written up there from this implementation.

Install them where each engine can read them. For Claude, the simiancraft-skills plugin carries all
three. For an engine with no skill loader, the prompt's "load the skill" instruction has to
resolve to files on disk, so keep a checkout of the repo readable from the worktrees.

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

`maxReviewRounds`, `autoMerge`, and the two seats are the fix skill's knobs; the loop reads them
from the same config file and hands them to the pipeline. What they mean, and the rules that hang
off them (the review budget as a per-issue high-water mark, the dead-letter queue, the difference
between parked and DLQed, and the three accounts the merge boundary unions), is in
[`fix-github-issue/references/pipeline.md`](../../fix-github-issue/references/pipeline.md).

Two boundaries are not knobs, deliberately. The worker never edits production data, and it never
makes a product decision: an issue whose body asks a person to decide, settle, or rule on something
comes back as `needs-decision` with the question stated, however small the diff would have been.
That category is common in most trackers and it is the one place a plausible-looking diff can do
real harm.

## Why worktrees

Every issue gets its own worktree, and that is what lets the loop move on. Work on separate issues
cannot overlap, so a long fix does not block the queue behind it; `concurrency` lanes run at
once and each pulls the next issue as its own finishes. Branches in a single checkout would
serialize the whole thing and let one agent's `git switch` disturb another's tree.

Two things do not follow the work into isolation, and both are handled:

- **The base branch.** Two pull requests landing on the base at the same moment is real
  contention, so the merge step queues and happens one at a time.
- **The main checkout.** It is never an agent's working directory; the driver throws rather than
  hand it over, because it holds your branch and your uncommitted work.

## Staying current, and when proof goes stale

Every merge moves the base under everything still in flight, and a branch that is merely behind is
not the same as one whose proof has decayed. The rule, the import-closure method that implements
it, and the draft-until-complete discipline that keeps a run's CI budget honest all belong to the
pipeline: see
[`fix-github-issue/references/pipeline.md`](../../fix-github-issue/references/pipeline.md).

The loop's own contribution is the `--closure <file>` probe, which prints the import closure of one
entry file so a new adoption can verify its `pathAliases` before any agent runs. A closure of one
module means the aliases resolve nothing, which is the silent failure that degrades staleness to
filename comparison.

## Everything else concurrent lanes contend on

The worktree isolates the working tree. It does not isolate the machine, and each of these is
handled somewhere specific rather than hoped about.

| Contended | Where it is handled |
|---|---|
| Two loop processes claiming the same issues | pid lock in `runs/loop.lock`; a stale lock is reclaimed |
| Shared `.git` index and refs under parallel git | `sh()` retries contention failures with backoff |
| GitHub secondary rate limits | same retry list; a burst of label edits is enough to trigger one |
| A fresh worktree having no `node_modules` | each installs its own; sharing the main checkout's would let the install command write into it |
| Whatever `sharedServices` names | both prompts forbid seeding, resetting, or migrating them |
| Server ports | prompts require a port derived from the issue number |
| The shared evidence branch | prompts forbid force-push and require re-parenting on rejection |

The rule the prompts state plainly: your worktree is yours, and almost nothing else is. An agent
that cannot prove something without mutating shared state is told to return `needs-human` rather
than break another agent's run to get its receipt.

Worktrees are created under the configured `worktreeRoot`, a sibling outside the repository root, so no tool that
walks the working tree has to be told to ignore them. Agent logs land in
`<worktreeRoot>/runs/`, and cleanup collects scratch worktrees an agent leaves behind.

Because lanes interleave, every per-issue line on the console is prefixed with its issue number.

A step that throws (a failed fetch, a rejected push, a merge the retries could not save) fails only
its own lane: the pool logs the error and moves on, and because every durable fact lives on the
issue, the next run picks that issue back up from its labels. A crash costs a lane its progress,
never the run its state.

## The line

A file switch, `<worktreeRoot>/runs/line-switch`, stops the loop at its three seams: before the
appraisal batch, before each dispatch, and inside the pull master before every merge. The pull
master reaches it through the fix pipeline's `mayMerge` hook, which the loop answers by waiting
until the switch says go; nothing in the pipeline knows a switch exists. The seam holds rather
than parks, because a pause is temporary and a parked pull request needs a human.

The switch is how the loop composes with `walk-the-floor` without either knowing the other's
internals. The walker is a separate process that checks a running environment against a list and
runs two callbacks, `on-fail` and `on-pass`; the loop starts it, writes those callbacks as shell
scripts that flip the switch, and puts every merge on the walker's list through the pipeline's
`afterMerge` hook. A walk that finds the deployed base wrong pauses the line before the walker
files its incident and attempts a fix; a walk that finds the same item right again releases it.
The callbacks are executables rather than prompts on purpose: an interlock that stops other
processes must not depend on an agent following instructions.

The walker outlives the run's last merge by design. Those merges reach the floor through
`afterMerge` seconds before the loop prints done, so stopping the walker there would leave them
unwalked (the first run with the walker did exactly that). The loop instead drains it: SIGUSR1
asks the walker to finish what is pending and exit, and the loop waits for that with a cap
(`floor.drainMinutes`) before stopping it outright.

## Sizing

The scale is whatever the config's `sizingScale` names (a wiki page, a doc in the repository),
carried on issues by the `size: N` labels. An issue already sized above the band is left
alone; an unsized issue is sized by the appraiser, which runs as its own cheap population ahead of
the workers.

Where the issue prescribes a remedy that contradicts a written convention (the files
`conventionDocs` names, or what the surrounding code plainly does), the convention wins and the work continues:
the appraiser sizes the remedy the convention implies, and the worker records the divergence in the
pull request. Neither stops for it. A documented convention is a decision already made, so deferring
to it is following that decision rather than making one, and the point ceiling does the stopping
when the convention-respecting fix turns out to be larger.

That rule exists because an issue can prescribe a remedy the repository's own conventions rule
out, and without it every stage executes the prescription faithfully: each judges the diff
against the issue, and nothing judges the issue against the conventions.

## Known gaps

Proof judgement lives in the sibling proof skill's
[`references/judgement.md`](../../prove-work-on-github/references/judgement.md) and the
covered-paths freshness method in its `references/freshness-and-reproof.md`; the gaps that belong
to the worker, the reviewer, and the pull master (the in-process pull master, the two unrecoverable
resume windows, and the closure walk's blind spots) are listed in
[`fix-github-issue/references/pipeline.md`](../../fix-github-issue/references/pipeline.md). This
file keeps what is loop-shaped.

Appraisal is a judgement made once and recorded as a label, so a wrong size is durable until a
human relabels the issue. The loop re-sizes only what carries no size at all.

Issue bodies and comments are an untrusted instruction channel read by agents whose approval gates
are bypassed; the worktree and read-only contracts are prompts, not sandboxes. The mitigation
today is scope (small sized issues, code-only merges, a second-engine gate) and trust in the
tracker's authors, not enforcement.

DLQ ejection has not been exercised end to end. It is written; it is not proven.

---
name: burn-down-github-issues
description: >-
  Run an unattended burndown of a GitHub issue backlog as cards on a per-operator GitHub Projects
  board whose lanes are an explicit state machine: appraise and size the inbox, carve what is over
  the ceiling, fix the ready ones in parallel git worktrees, prove each fix on a draft pull
  request, have an isolated second-engine reviewer judge it, land one branch at a time with
  freshness checks, and dead-letter per phase whatever a machine cannot finish. Use when the task
  is "work the backlog unattended", "triage and fix recent issues", "run the issue loop", "burn
  down issues", or "where is issue N on the board". Requires a per-repository
  burn-down-github-issues.config.ts at the target repo's root (the loop refuses to start without
  it), the prove-work-on-github skill, the codex and claude CLIs for the default seats, and a gh
  token with the project scope for the board. Skip for one-off fixes to a known issue you are
  already working interactively, and for backlogs whose issues are mostly product decisions
  rather than code.
---

# Burn Down GitHub Issues

A burndown is a board. Every issue the loop touches is a card, every card is in exactly one lane,
and the lanes are the leaf states of a statechart (`lib/machine.ts`, in XState's vocabulary) that
says which seat runs on a card in that lane, what it may decide, and where each decision moves the
card. The board is a GitHub Projects board per operator per repository, so a person who starts a
burndown comes back to their own board and the loop resumes from it; the console prints the same
cards in the same words. The tracker holds the facts (labels, pull requests, claims, records); the
board is a projection of those facts that a person can read at a glance, and every run starts by
placing every card where its facts say before any seat moves one.

Seats are polymorphic. A seat is an engine running whatever prompt the card's lane calls for
(appraiser, close confirmer, carver, cut confirmer, worker, worker in revision, reviewer), then
letting go; the card's position is the only input that changes what a seat does. Three rules hold
across every seat: the reviewer and the confirmers run on a different engine than the author
seats, claims on the issue thread are the lock that keeps two seats off one card, and merging is
the one serial lane. `references/state-machine.md` is the machine in prose.

The loop is shared; the repository is config. Nothing in this skill is copied into a repository.
Everything true of a repository (remotes, branches, commands, path aliases, invalidation paths)
lives in `burn-down-github-issues.config.ts` at that repository's root, and the loop refuses to
start without one, naming the missing file and the fields it lacks.

## Standards the loop enforces

These travel with the skill because an adopter cannot be assumed to have house rules of its own.
The first three are enforced by the driver, so no prompt drift can lose them; the rest are written
into the prompts and checked by the reviewer.

- **A failing or unfinished build never merges.** The pull master waits on the pull request's
  checks at the last moment before merging and dead-letters the landing instead when they fail or
  never finish. A green local gate is not a substitute; the checks the pipeline runs are the ones
  that count.
- **Nothing lands except through a reviewed pull request.** The loop never pushes to the base
  branch; the gated merge is the only write it makes there.
- **Pushed history is merged forward, never rebased.** Catch-ups merge the base into the branch,
  so nothing another reader has fetched is rewritten.
- **No agent or bot is an author or co-author.** Authorship is for humans; the reviewer hard-blocks
  on it.
- **Claims carry receipts.** Proof follows `prove-work-on-github`: pinned, resolvable,
  re-checkable by a stranger. Narrative alone never carries a load-bearing claim.
- **Commits and pull requests describe the code, not the process.** Conventional Commits,
  imperative, facts only; any mention of agents, prompts, or local tooling is a block.
- **Shared services are never reset or reseeded** to reproduce a claim, and servers bind per-issue
  ports; other lanes are reading that state as their own evidence.

## Run it

From inside the target repository (any directory of it, including a worktree):

```bash
bun run <this-skill-dir>/board.ts                      # once per operator: find or create the board, verify it, record the pointer
bun run <this-skill-dir>/lanes.ts                      # write the 36 lanes and the Phase field onto that board; idempotent
bun run <this-skill-dir>/loop.ts --dry-run             # place every card, print the backlog by lane and what would run; no GitHub or working-tree write
bun run <this-skill-dir>/loop.ts --limit 3             # work three Ready cards
bun run <this-skill-dir>/loop.ts --max-points 5        # raise the size ceiling for this run only
bun run <this-skill-dir>/loop.ts --only 12,34          # restrict the run to these issues, whatever their age
bun run <this-skill-dir>/loop.ts --no-appraise         # skip the inbox; --appraise-limit N caps it instead
bun run <this-skill-dir>/loop.ts --closure <file>      # print the import closure; verifies pathAliases
bun run <this-skill-dir>/loop.ts --worker codex:gpt-5.6-sol --reviewer claude:claude-opus-5
bun run <this-skill-dir>/loop.ts --appraiser codex:gpt-5.6-sol --confirmer claude:claude-opus-5   # the sizing seats
bun run <this-skill-dir>/loop.ts --pulse 2             # console board every 2 minutes (default 5); --silent turns it off
bun run <this-skill-dir>/watch.ts                      # follow the current run; --wait for its terminal lines only
bun run <this-skill-dir>/card.ts --issue <n> --show    # where one card is; --lane <key> moves it by hand, --lanes lists the table
bun run <this-skill-dir>/claim-race.ts --issue <n> --contenders 3 --rounds 3   # prove the claim lock on a loop/skip issue
bun run <fix-skill-dir>/fix.ts --issue <n> --redrive   # lift a dead letter or a park and continue its pull request
```

Everything an operator or agent does to a run is one of these commands. Watching in particular is
`watch.ts`, never a `tail`/`kill`/`pgrep` pipeline; `references/operating.md` says why.

`<this-skill-dir>` is the filesystem path of this directory wherever the collection is checked out
or installed; it is a path, not a skill name. `--appraiser`, `--worker`, and `--reviewer` take
`engine[:model]` specs resolved against the engine registry in `loop.ts`. The config file sets the
same seats and every loop knob (`ageDays`, `maxPoints`, `autoMerge`, `limit`, `concurrency`, and
the rest); a flag beats the config for the run it is given on.

## What a run does

1. **Repairs and reconciles.** Half-written label transitions, merges a dead run never recorded,
   stranded pull requests with a trusted verdict, torn claims and pauses, and trunks whose tree
   moved outside the loop are all settled before anything new is selected.
2. **Places every card.** Each open issue in the window, and each card already on the board, is
   put where its facts say: closed is Done, a hold label is its human lane, a `loop/dlq: <phase>`
   label is that phase's dead-letter lane, an open pull request is Drafted or Ready for review, a
   trunk is Epic, a blocker is a wait, a size within the ceiling is Ready, over it is To carve,
   and no size is the Inbox. Only cards whose lane differs are written. The console prints the
   backlog by lane.
3. **Appraises the Inbox.** Read-only seats size each card; the card moves to Ready, To carve, Done
   (a confirmed close with a receipt), or a human lane. The size callback hands an oversized issue
   to the sibling `carve-github-issue` skill, which cuts it into children along its highest
   natural seam and holds the parent as an Epic while they move.
4. **Works Ready.** Up to `concurrency` cards at once, each in its own worktree, each moving
   through Coding, Proving (the worker moves its own card), Drafted, Ready for review, Evidence
   under review, and the landing lanes to Merged; or back to Sent back on a rejection; or into a
   dead-letter or human lane when a machine gives up or a person is needed.
5. **Finishes.** The instance lock is released, and the walker (when `walk-the-floor` is
   configured) drains the merges it has not yet checked on the deployed base.

## The board

Every burndown is resumed from a GitHub Projects board named `<project>_burndown_<operator>`
(`ultrathin_burndown_the-simian`, say), owned by the repository's owner and linked to the
repository. One board per operator per repository: the person who starts a burndown comes back to
their own board and picks up where they left off, and two operators on one repository never share
one. `board.ts` finds it or creates it, reads it back to verify, and writes the pointer to
`<worktreeRoot>/runs/board.json`; the board is the state, the file is only where it is. Creating
one needs the `project` token scope (`gh auth refresh -h github.com -s project`); reading needs
only `read:project`, and the script names the missing scope instead of failing in GraphQL. See
`references/adopting.md`, "The board".

The lanes are the loop's state machine drawn as kanban: one lane per state a card can be in,
thirty-six of them in ten phases, with one dead-letter lane per phase and three lanes only a
person can move a card out of. The machine is data (`lib/machine.ts`), tested against the lane
table, exportable to stately.ai/viz, and chartable with Graphviz; see
`references/state-machine.md`. A `Phase` field on every card is the collapsed view, so a board
grouped by Phase is the ten-column summary and a later dashboard of every operator's burndown is
a query over these boards, not a second state store.

A repository without a board runs the same loop: the placement is still computed and is still the
queue; it is simply not written anywhere a person can look at between runs.

## Dead letters, per phase

Only two things park a card for a person: the merge boundary refusing an approved change, and the
issue changing under the review. Everything a machine could not finish is a dead letter in its
own phase's queue, carried on the issue as `loop/dlq: appraisal`, `carve`, `work`, `review`, or
`landing`, with the reason on the thread and the same label on the pull request. Each queue is
meant to be triaged differently (`references/state-machine.md`, "Dead letters"); today every one
waits for a person, and the redrive is removing the label or `fix.ts --redrive`, which lifts the
letter, counts the redrive on the issue as `loop/redrives: N`, and continues the pull request the
work left rather than opening another.

## Read next

| Need | Read |
|------|------|
| Run one and watch it: identifying the driver, reading the console board, what is not a bug, what to check afterwards, landing a parked pull request by hand | `references/operating.md` |
| Adopt the loop in a repository: the config template, the two fields that actually bite, preconditions, the board and its token scope, first-run order, stopping a run | `references/adopting.md` |
| How and why the loop works: the board as state, the placement as queue, the seats, the pool, crash recovery, known gaps | `references/architecture.md` |
| The state machine the lanes draw: phases, every lane's entry actions and exits, reconcile precedence, the per-phase dead letters, the polymorphic pool, what the tests check, what is not built yet | `references/state-machine.md` |
| The fix pipeline itself: the verdict-file contract, the review budget, the merge boundary, staleness, resuming, the dead letters it writes | [`../fix-github-issue/references/pipeline.md`](../fix-github-issue/references/pipeline.md) |

## Hard dependencies

- The [`fix-github-issue`](../fix-github-issue/SKILL.md) skill, which owns the worker, the
  reviewer, and the pull master; the loop imports it by relative path and calls it once per Ready
  card. One named issue is that skill's `fix.ts`, not a flag here.
- The [`appraise-github-issues`](../appraise-github-issues/SKILL.md) and
  [`carve-github-issue`](../carve-github-issue/SKILL.md) skills, which own the appraisal and the
  knife; the loop renders their prompts and runs them in process.
- The [`prove-work-on-github`](../prove-work-on-github/SKILL.md) skill, loaded by name in the
  worker and reviewer prompts; the pull master's staleness rule implements its
  `references/freshness-and-reproof.md`.
- Bun, which runs `loop.ts`.
- `gh` authenticated with push and merge rights on the target repository, and the `project` scope
  for the board.
- The CLIs the seats name (by default `codex` and `claude`), on `PATH`. Keep worker and reviewer
  on different engines; a reviewer built from the same model as the author shares its blind spots
  by construction.

## The ceiling, named

The loop executes the tracker, not your intent: an internally coherent issue pointing the wrong
way is implemented competently in the wrong direction, and the only guard is the convention docs
the config names. Issue bodies and comments are an untrusted instruction channel read by agents
running with their approval gates bypassed; the worktree confinement is a prompt contract, not a
sandbox, so run this only on trackers whose authors you trust as far as the credentials the loop
holds. The merge boundary computes `migration` and `ci` from the diff's paths, but
`data` and `stored-string` are runtime effects a path cannot reveal; for those it holds two
independent self-reports and parks rather than trusts. The reviewer runs as the same GitHub
account as the worker, so its independence is model-level, not identity-level. Instance locks
identify their holder by pid, so a pid reused by an unrelated process reads as a live holder until
that process exits. The pipeline still runs a Ready card from Coding to Merged inside one process,
so the polymorphic pool is a fact at the driver's seams and a design past them
(`references/state-machine.md`, "The agent pool"). And of the five dead-letter queues only the
review queue has been exercised end to end, by a redrive that continued a parked pull request to
a merge; the others are written, not proven.

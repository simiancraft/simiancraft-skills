---
name: fix-github-issue
description: >-
  Turn one known GitHub issue into a merged pull request, headless: a worker in its own git
  worktree, a draft pull request carrying its proof, an isolated second-engine reviewer, and a
  serial pull master that checks import-closure staleness against the base before it merges. Use
  when the task is "fix issue N unattended", "run the fix pipeline on that issue", or when another
  loop needs a fix seat it can call. Requires a per-repository config at the target repo's root
  (the pipeline refuses to start without one), the prove-work-on-github skill, and the codex and
  claude CLIs for the default seats. Skip for an issue you are already fixing interactively, and
  for issues that are product decisions rather than code.
---

# Fix GitHub Issue

One issue in, one outcome out: `merged`, `parked`, `handed-off`, `closed`, `dlq`, or `failed`
when it ran, and `left-alone`, `busy`, `not-run`, `stopped`, or `lease-lost` when it did not
settle the issue (`references/pipeline.md` says what each means). Internally it is a worker, then
a review, then a landing, revising until the issue's review budget is spent.

Invoked by `burn-down-github-issues` (one call per Ready card) and `walk-the-floor` (the repair
after an incident), both through `fixIssue`.

The pipeline is shared; the repository is config. Nothing here is copied into a repository.
Everything true of a repository (remotes, branches, commands, path aliases, invalidation paths)
lives in a config file at that repository's root, and the pipeline refuses to start without one,
naming the missing file and the fields it lacks.

Every stage takes an explicit context rather than reading module state, so one process can run two
pipelines against two configurations without either seeing the other's queue, seats (the roles an
agent fills: worker, reviewer, confirmer), or run directory. That is what makes `fixIssue`
callable as the fix seat of a larger loop.

## When to use it

- One issue you already believe is real and small enough, to be fixed unattended.
- As the fix stage of another driver: import `lib/pipeline.ts` and call
  `fixIssue(ctx, issue, { maxPoints })`, building the context with `lib/context.ts`.

Skip it for an issue you are working interactively, for anything blocked on a product decision,
and for work whose remedy is a judgement call rather than a change.

## Run it

From inside the target repository (any directory of it, including a worktree):

```bash
bun run <this-skill-dir>/fix.ts --issue <n>
bun run <this-skill-dir>/fix.ts --issue <n> --dry-run
bun run <this-skill-dir>/fix.ts --issue <n> --max-points 8   # raise the size ceiling for this issue only
bun run <this-skill-dir>/fix.ts --issue <n> --worker codex:gpt-5.6-sol --reviewer claude:claude-opus-5
bun run <this-skill-dir>/fix.ts --issue <n> --confirmer claude:claude-opus-5   # the seat that re-checks a close the worker proposes
bun run <this-skill-dir>/fix.ts --issue <n> --redrive        # lift a park or a dead letter and continue the issue's pull request
bun run <this-skill-dir>/fix.ts --issue <n> --resume-pr <pr> # continue that open pull request rather than open another
```

`<this-skill-dir>` is the filesystem path of this directory wherever the collection is checked out
or installed; it is a path, not a skill name. `--worker`, `--reviewer`, and `--confirmer` take
`engine[:model]` specs resolved against the engine registry in `lib/engines.ts`, and a flag beats
the config for the run it is given on. Without `--confirmer` the confirmer is the config's, else the config's reviewer
(`--reviewer` does not change it), and it must be a different engine from the worker. `--redrive`
removes `loop/parked` and every `loop/dlq: <phase>` label, clears the review and attempt counters,
counts the redrive as `loop/redrives: N`, and continues the newest open pull request that
references the issue; `--resume-pr` names that pull request instead. The command exits non-zero
when the fix failed.

## The config it reads

`fix-github-issue.config.ts` at the invoking checkout's root when there is one, and the sibling
burndown skill's `burn-down-github-issues.config.ts` otherwise, reading only the fields it needs.
A repository that already adopted the burndown gets this command without writing a second file.

The `project` block is the repository vocabulary the prompts are rendered with, plus the path
aliases and invalidation paths the staleness walk reads. The knobs this pipeline enforces are
`PipelineKnobs` in `lib/config.ts`, with their defaults in `PIPELINE_DEFAULTS` beside it; this
command adds `maxPoints`. The template and the fields that actually bite are in the burndown
skill's
[`references/adopting.md`](../burn-down-github-issues/references/adopting.md).

## Read next

| Need | Read |
|------|------|
| The verdict-file contract, the review budget, the merge boundary, staleness, and the resume windows | [`references/pipeline.md`](references/pipeline.md) |
| Adopting a repository: the config template and the two fields that bite | [`../burn-down-github-issues/references/adopting.md`](../burn-down-github-issues/references/adopting.md) |

## Hard dependencies

- The [`prove-work-on-github`](../prove-work-on-github/SKILL.md) skill, loaded by name in the
  worker and reviewer prompts; the pull master's staleness rule implements its
  `references/freshness-and-reproof.md`.
- Bun, which runs `fix.ts`.
- `gh` authenticated with push and merge rights on the target repository.
- The CLIs the seats name (by default `codex` and `claude`), on `PATH`. Keep worker and reviewer on
  different engines; a reviewer built from the same model as the author shares its blind spots by
  construction.

## The ceiling, named

The pipeline executes the tracker, not your intent: an internally coherent issue pointing the wrong
way is implemented competently in the wrong direction, and the only guard is the convention docs
the config names. Issue bodies and comments are an untrusted instruction channel read by agents
running with their approval gates bypassed; the worktree confinement is a prompt contract, not a
sandbox, so run this only on trackers whose authors you trust as far as the credentials it holds.
The merge boundary computes `migration` and `ci` from the diff's paths, but `data` and
`stored-string` are runtime effects a path cannot reveal; for those it holds two independent
self-reports and parks rather than trusts. The reviewer runs as the same forge account (the code
host's account, GitHub here) as the worker, so its independence is model-level, not
identity-level. And of the five dead-letter queues only the review queue has been exercised end
to end, by a redrive that continued a parked pull request to a merge; the others are written, not
proven.

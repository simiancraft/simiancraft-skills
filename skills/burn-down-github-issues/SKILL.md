---
name: burn-down-github-issues
description: >-
  Run an unattended loop that burns down a GitHub issue backlog: appraise and size recent
  issues, close the stale ones with re-checkable receipts, fix the small ones in parallel git
  worktrees, prove each fix on a draft pull request, have an isolated second-engine reviewer
  judge it, and merge one branch at a time with import-closure staleness checks. Use when the
  task is "work the backlog unattended", "triage and fix recent issues", "run the issue loop",
  or "burn down issues". Requires a per-repository burn-down-github-issues.config.ts at the
  target repo's root (the loop refuses to start without it), the prove-work-on-github skill,
  and the codex and claude CLIs for the default seats. Skip for one-off fixes to a known issue
  you are already working interactively, and for backlogs whose issues are mostly product
  decisions rather than code.
---

# Burn Down GitHub Issues

A headless loop that triages recent issues, fixes the small ones, proves the work on a pull
request, and lets a second agent with no shared context decide whether it can merge. Four roles:
an appraiser pool that sizes issues read-only, a worker pool that fixes them one worktree each, a
reviewer pool that judges, and a single pull master that merges one branch at a time.

The loop is shared; the repository is config. Nothing in this skill is copied into a repository.
Everything true of a repository (remotes, branches, commands, path aliases, invalidation paths)
lives in `burn-down-github-issues.config.ts` at that repository's root, and the loop refuses to
start without one, naming the missing file and the fields it lacks.

## Run it

From inside the target repository (any directory of it, including a worktree):

```bash
bun run <this-skill-dir>/loop.ts --dry-run          # select and print; no agent, no mutation
bun run <this-skill-dir>/loop.ts --limit 3          # work three issues
bun run <this-skill-dir>/loop.ts --issue 3327       # one issue, ignoring the age and size filters
bun run <this-skill-dir>/loop.ts --closure <file>   # print the import closure; verifies pathAliases
bun run <this-skill-dir>/loop.ts --worker codex:gpt-5.6-sol --reviewer claude:claude-opus-5
```

`--appraiser`, `--worker`, and `--reviewer` take `engine[:model]` specs resolved against the
engine registry in `loop.ts`; the config file can override the same seats, along with any loop
knob (`ageDays`, `maxPoints`, `autoMerge`, `limit`, `concurrency`, and the rest).

## Read next

| Need | Read |
|------|------|
| Run one and watch it: identifying the driver, reading the log, what is not a bug, what to check afterwards, landing a parked pull request by hand | `references/operating.md` |
| Adopt the loop in a repository: the config template, the two fields that actually bite, preconditions, first-run order, stopping a run | `references/adopting.md` |
| How and why the loop works: the shape, review pinning, staleness via import closure, the merge boundary, crash recovery, known gaps | `references/architecture.md` |

## Hard dependencies

- The [`prove-work-on-github`](../prove-work-on-github/SKILL.md) skill, loaded by name in the
  worker and reviewer prompts; the pull master's staleness rule implements its
  `references/freshness-and-reproof.md`.
- `gh` authenticated with push and merge rights on the target repository.
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
account as the worker, so its independence is model-level, not identity-level. And two paths have
executed in no production run yet: closure-based staleness firing in anger, and dead-letter-queue
ejection. Both are written; neither is proven.

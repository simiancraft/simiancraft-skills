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

## Standards the loop enforces

These travel with the skill because an adopter cannot be assumed to have house rules of its own.
The first three are enforced by the driver, so no prompt drift can lose them; the rest are written
into the prompts and checked by the reviewer.

- **A failing or unfinished build never merges.** The pull master waits on the pull request's
  checks at the last moment before merging and parks instead when they fail or never finish. A
  green local gate is not a substitute; the checks the pipeline runs are the ones that count.
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
bun run <this-skill-dir>/loop.ts --dry-run             # select and print; no agent, no mutation
bun run <this-skill-dir>/loop.ts --limit 3             # work three issues
bun run <this-skill-dir>/loop.ts --max-points 5        # raise the size ceiling for this run only
bun run <this-skill-dir>/loop.ts --issue <n>           # one issue; skips the age and size window, never the safety filters
bun run <this-skill-dir>/loop.ts --no-appraise         # skip the sizing pass; --appraise-limit N caps it instead
bun run <this-skill-dir>/loop.ts --closure <file>      # print the import closure; verifies pathAliases
bun run <this-skill-dir>/loop.ts --worker codex:gpt-5.6-sol --reviewer claude:claude-opus-5
```

`<this-skill-dir>` is the filesystem path of this directory wherever the collection is checked out
or installed; it is a path, not a skill name. `--appraiser`, `--worker`, and `--reviewer` take
`engine[:model]` specs resolved against the engine registry in `loop.ts`. The config file sets the
same seats and every loop knob (`ageDays`, `maxPoints`, `autoMerge`, `limit`, `concurrency`, and
the rest); a flag beats the config for the run it is given on.

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
- Bun, which runs `loop.ts`.
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
account as the worker, so its independence is model-level, not identity-level. And dead-letter-queue
ejection has not been exercised end to end; it is written, not proven.

# Adopting burn-down-github-issues

Instructions for bringing this loop to another repository. Written for an agent doing the
adoption, with `lifeguides-application` as the worked example.

## What you are adopting

A headless loop that appraises recent issues, fixes the small ones, proves the work on a pull
request, and lets a second agent with no shared context decide whether it can merge. Four roles:
an appraiser pool that sizes issues read-only, a worker pool that fixes them one worktree each, a
reviewer pool that judges, and a single pull master that merges one branch at a time.

Read `architecture.md` first. It describes the shape and the reasoning; this file is only the
adoption.

## What you write: one config file, nothing copied

The loop ships with this skill and stays here. The repository carries exactly one thing:
`burn-down-github-issues.config.ts` at its root, exporting `{ project, ...knobOverrides }` as
default. The loop refuses to start without it, and refuses again when a required `project` field
is missing, naming what it lacks. A template, filled in with the lifeguides values:

```ts
export default {
  project: {
    name: 'Lifeguides',
    repo: 'simiancraft/lifeguides-application',
    remote: 'origin',
    baseBranch: 'preview',
    evidenceBranch: '__evidence_locker__',
    checkCommand: 'bun check',
    installCommand: 'bun install --frozen-lockfile',
    conventionDocs: ['AGENTS.md', 'CLAUDE.md'],
    sizingScale: 'the KANBAN-ESTIMATION-SCALE wiki page',
    sharedServices: ['the local database', 'the shop-preview AWS stage'],
    portBase: 9100,
    portSpan: 800,
    pathAliases: [{ prefix: '~/', dir: '.' }],
    sourceExtensions: ['.ts', '.tsx', '.js', '.jsx'],
    alwaysInvalidates: ['package.json', 'bun.lock', '.github/workflows/' /* and more; see below */],
    touchPaths: {
      migration: ['db/migrations/'],
      ci: ['.github/workflows/'],
    },
    worktreeRoot: '../.lifeguides-loop',
  },
  // Optionally override any loop knob here: ageDays, maxPoints, autoMerge, maxReviewRounds,
  // limit, concurrency, appraiserConcurrency, appraiseLimit, skipLabels, seats.
};
```

**If adopting makes you edit a function in `loop.ts`, that value belongs in the config contract
and the change belongs in this skill.** Say so rather than working around it.

The prompts never name a repository. They are rendered with the `project` vocabulary at each
invocation, so `{{REPO}}`, `{{CHECK_COMMAND}}`, `{{EVIDENCE_BRANCH}}` and the rest resolve from
config. Do not hand-edit prose in `prompts/` to say your project's name.

## Fill this in

| Field | What it is | Ultrathin | lifeguides-application |
|---|---|---|---|
| `name` | banner only | `Ultrathin` | `Lifeguides` |
| `repo` | `owner/repo`, builds evidence links | `simiancraft/Ultrathin` | `simiancraft/lifeguides-application` |
| `remote` | **check this**, not every checkout says `origin` | `origin` | `origin` (see below) |
| `baseBranch` | cut from and merged into | `development` | `preview` |
| `evidenceBranch` | long-lived, append only | `__evidence_locker__` | create one |
| `checkCommand` | the local gate | `bun check` | `bun check` (runs `scripts/check-parallel.ts`) |
| `installCommand` | frozen-lockfile install | `bun ci` | `bun install --frozen-lockfile`; there is no `ci` script |
| `conventionDocs` | what a prescribed remedy is read against | `AGENTS.md`, `CLAUDE.md` | both present |
| `sizingScale` | where the point scale is written | the wiki page | same wiki page |
| `pathAliases` | **check this**, alias to directory | `~/` to `app` | `~/` to `.` |
| `sourceExtensions` | closure walk candidates | ts, tsx, js, jsx | same |
| `alwaysInvalidates` | see below | Prisma and Vite shaped | Expo and Drizzle shaped |
| `touchPaths` | mechanical merge-boundary classification | Prisma schema + workflows | Drizzle schema and migrations + workflows |
| `sharedServices` | what an agent must not reset | database, Elasticsearch, Redis | whatever is real there |
| `portBase` / `portSpan` | `portBase + (issue % portSpan)` | 3000 / 900 | avoid Metro's 8081 |

Also set `worktreeRoot`, which is a sibling directory outside the repository root so no tool that
walks the working tree has to be told to ignore it.

### The two that actually bite

**`remote`, and it is worse than a rename.** `lifeguides-application` has **two** remotes pointing
at **two different repositories**:

```
lifeguides   https://github.com/lifeguides/lifeguides-application.git
origin       git@github.com:simiancraft/lifeguides-application.git
```

That is a dual-repository delivery pattern (`docs/repository-structure.mdx` in that repo): all
development happens in the shop repository, and the client repository receives delivery PRs only.
So the loop works `origin` / `simiancraft/lifeguides-application` with base `preview`; pointing it
at the `lifeguides` remote would put agent PRs and issue comments on a client-visible surface,
which is the wrong answer however plausible the remote name makes it look. The general rule:
`remote` and `repo` must name the same repository, because `repo` builds the evidence links and
`gh` resolves pull requests against a repository of its own choosing; a mismatch means the loop
pushes branches to one repository and opens pull requests against another, and the failure is
confusing rather than loud. And the loop must work the repository where development actually
happens, which in a delivery pattern is not always the remote whose name matches the product.

Before the first run, confirm `gh repo set-default` matches `repo`. Every fetch, push, and
`git diff base...HEAD` goes through `remote`. Run `git remote -v` and read it; do not assume
`origin`, and do not assume the obvious-looking remote is the workspace.

**`pathAliases`.** Ultrathin maps `~/*` to `./app/*`; lifeguides maps `~/*` to `./*`. Get this
wrong and the import-closure walk silently resolves nothing, which does not error. It degrades to
filename comparison, so proofs stop being invalidated when they should be and a stale approval can
merge. Read `tsconfig.json` `compilerOptions.paths` and transcribe it.

### `alwaysInvalidates` deserves thought, not copying

These are paths whose change invalidates any proof in flight, whatever the pull request touched,
because import scanning cannot reach them. Ask: what does everything depend on that nothing
imports by a module path? Lockfile, package manifest, type and lint config, build config,
generated output, schema and migrations, CI workflows.

Ultrathin's list names `server/prisma/` and `vite.config`. Neither exists in lifeguides, which
instead has `db/__generated__/`, its Drizzle schema, `app.config.ts`, `metro.config.js`, and
`tailwind.config`. Copying the Ultrathin list verbatim gives you a list that matches nothing.

The same reasoning applies to `touchPaths`, which mechanically classifies a diff as `migration` or
`ci` for the merge boundary: point it at your schema, migration, and workflow directories. The
worker and reviewer also self-report those categories, but the path scan is what makes the
boundary independent of anyone's say-so.

## Preconditions

- `gh` authenticated with push and merge rights on the repository.
- The agent CLIs you intend to seat, on `PATH`. Each role is an `engine:model` spec: defaults live
  in `CONFIG.seats`, and any run can override them with `--appraiser`, `--worker`, and `--reviewer`
  (for example `--worker codex:gpt-5.6-sol --reviewer claude:claude-opus-5`). The known engines are
  the `ENGINES` registry in `loop.ts`; a CLI the loop does not yet know is one registry entry (how
  to run one prompt to completion, non-interactively, with its approval gate bypassed), not a
  refactor. **Keep the worker and reviewer on different engines**; a reviewer built from the same
  model as the author shares its blind spots by construction, and that isolation is the only thing
  catching a worker that convinced itself. The driver warns, but does not refuse, when they match.
- The sibling `prove-work-on-github` skill available to both worker and reviewer. This is a hard
  dependency: both prompts load it by name, and the merge gate's freshness rule implements its
  `references/freshness-and-reproof.md`. It ships in the same collection as this loop, so
  installing the simiancraft-skills plugin (`/plugin marketplace add simiancraft/simiancraft-skills`,
  then `/plugin install simiancraft-skills@simiancraft-skills`) brings both; for an engine with no
  skill loader, keep a checkout of the repo readable from the worktrees so "load the skill"
  resolves to files on disk.
- A CI workflow that **skips drafts**. The loop opens pull requests as drafts and marks them ready
  once, to protect the CI budget. Without the draft guard every intermediate push spends a run.
  Ultrathin's guard is `types: [..., ready_for_review]` plus
  `if: github.event.pull_request.draft == false`. Verify it before a batch run: open one draft pull
  request by hand and confirm nothing queues.
- An issue tracker where issues carry `size: N` labels, or an appraiser run to create them.

## Order of work

1. Write `burn-down-github-issues.config.ts` from the template above. Copy nothing else.
2. From the repository root: `bun run <skill-dir>/loop.ts --dry-run --limit 2`. This mutates
   nothing and starts no agent. It prints what it would select and writes each rendered prompt to
   a log.
3. **Read one rendered prompt.** `grep -oE "\{\{[A-Z_]+\}\}"` against it must return nothing; an
   unresolved placeholder means a field you did not set. Confirm the prose names your repository,
   your commands, and your branches.
4. Verify the closure walk resolves:
   `bun run <skill-dir>/loop.ts --closure <file-with-an-aliased-import>` prints every module
   the walk reaches and exits without touching anything. A result of one module (only the entry
   itself) means the aliases resolve nothing, which is the silent failure described above.
5. One real issue, alone: `--issue <n> --appraise-limit 0`. Watch it end to end.
6. Then a small batch. `--limit 3` before `--limit 5`.

## Boundaries to set deliberately

`autoMerge` defaults to `code-only`: merge code, park anything touching production data, a
migration, or a stored string. `maxPoints: 2` keeps the loop to work small enough that a bad merge
is cheap. `ageDays: 30` keeps it to issues whose context is still true. Widen after a run has gone
well, not before.

`maxReviewRounds` is a **per-issue high-water mark**, not a per-run allowance; the count lives on
the issue as `loop/reviews: N`. At the cap the issue goes to the dead-letter queue with the reason
that put it there, and removing `loop/dlq` is the redrive.

## What will surprise you

- **The appraisers are the highest-yield role.** Across the first three Ultrathin runs, nine issues
  were closed as already-fixed or obsolete with re-checkable receipts, without a worker running.
  Expect a stale backlog to shrink before anything is coded.
- **The loop executes the tracker, not your intent.** An issue that is internally coherent and
  points the wrong way will be implemented competently in the wrong direction; every stage judges
  the diff against the issue. The guard is `conventionDocs`, which is why those files must actually
  state your conventions.
- **Reviews take eight to twelve minutes**, mostly waiting on CI inside the reviewer's single turn.
  That is expected, not a hang.

## Stopping a run

Ctrl+C, or SIGTERM to the pid in `runs/loop.lock`, stops the loop politely: agents are killed with
their process groups and the lock is released. Everything durable is already on GitHub, so after a
stop, check three places: open drafts (work finished but never marked ready), issues labelled
`loop/parked`, and `runs/*.log` for the lanes that were in flight. Worktrees left behind are
reclaimed by `reconcile` on the next start; nothing needs hand-cleanup, and `--dry-run` is always
safe to run while deciding what to do next.

## When the adoption needs a skill change

Two things are deliberately not config:

- The verdict schema in each prompt (`loop-verdict.json`, `loop-appraisal.json`,
  `loop-review.json`) assumes GitHub issues and pull requests via `gh`. Another forge means a real
  port of the skill, not a config change.
- The Conventional Commits and no-em-dash house rules are written into the prompts as prose. They
  are house style rather than project config; if your house differs, that is a conversation with
  this skill, not a local edit to shared prompts.

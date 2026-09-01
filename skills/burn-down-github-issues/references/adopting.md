# Adopting burn-down-github-issues

Instructions for bringing this loop to another repository, written for an agent doing the
adoption. Examples below contrast the loop's first two field adopters, anonymized to their
shapes: a web monorepo (Vite + Prisma) and a mobile app (Expo + Drizzle). The contrast is the
point; almost every field that bit an adopter bit them differently.

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
is missing, naming what it lacks. A template with placeholder values:

```ts
export default {
  project: {
    name: 'YourApp',
    repo: 'your-org/your-app',
    remote: 'origin',
    baseBranch: 'main',
    evidenceBranch: '__evidence_locker__',
    checkCommand: 'bun check',
    installCommand: 'bun install --frozen-lockfile',
    conventionDocs: ['AGENTS.md', 'CLAUDE.md'],
    sizingScale: 'where your point scale is documented',
    sharedServices: ['the local database', 'the shared staging stage'],
    portBase: 9100,
    portSpan: 800,
    pathAliases: [{ prefix: '~/', dir: '.' }],
    sourceExtensions: ['.ts', '.tsx', '.js', '.jsx'],
    alwaysInvalidates: ['package.json', 'bun.lock', '.github/workflows/' /* and more; see below */],
    releaseArtifacts: [/* optional; see below */],
    touchPaths: {
      migration: ['db/migrations/'],
      ci: ['.github/workflows/'],
    },
    worktreeRoot: '../.your-app-loop',
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

| Field | What it is | Web monorepo | Mobile app |
|---|---|---|---|
| `name` | banner only | its product name | its product name |
| `repo` | `owner/repo`, builds evidence links | the org's working repo | the org's working repo (see below) |
| `remote` | **check this**, not every checkout says `origin` | `origin` | `origin`, but it carried a second remote (see below) |
| `baseBranch` | cut from and merged into | `development` | `preview` |
| `evidenceBranch` | long-lived, append only | `__evidence_locker__` | create one |
| `checkCommand` | the local gate | `bun check` | `bun check` (a script fanning out to 14 checks) |
| `installCommand` | frozen-lockfile install | `bun ci` | `bun install --frozen-lockfile`; there was no `ci` script |
| `conventionDocs` | what a prescribed remedy is read against | `AGENTS.md`, `CLAUDE.md` | both present |
| `sizingScale` | where the point scale is written | a wiki page | the same wiki convention |
| `pathAliases` | **check this**, alias to directory | `~/` to `app` | `~/` to `.` |
| `sourceExtensions` | closure walk candidates | ts, tsx, js, jsx | same |
| `alwaysInvalidates` | see below | Prisma and Vite shaped | Expo and Drizzle shaped |
| `touchPaths` | mechanical merge-boundary classification | Prisma schema + workflows | Drizzle schema and migrations + workflows |
| `sharedServices` | what an agent must not reset | database, Elasticsearch, Redis | database, a shared staging stage, test identities |
| `portBase` / `portSpan` | `portBase + (issue % portSpan)` | 3000 / 900 | chosen to avoid the dev server's 8081 |

Also set `worktreeRoot`, which is a sibling directory outside the repository root so no tool that
walks the working tree has to be told to ignore it.

### The two that actually bite

**`remote`, and it is worse than a rename.** One adopter's checkout carried **two** remotes
pointing at **two different repositories**:

```
client   https://github.com/client-org/the-app.git
origin   git@github.com:your-org/the-app.git
```

That is a dual-repository delivery pattern: all development happens in the working repository,
and the client-facing repository receives delivery pull requests only. So the loop works
`origin` with the working repository's base branch; pointing it at the client remote would put
agent PRs and issue comments on a client-visible surface, which is the wrong answer however
plausible the remote's name makes it look. The general rule: `remote` and `repo` must name the
same repository, because `repo` builds the evidence links and `gh` resolves pull requests against
a repository of its own choosing; a mismatch means the loop pushes branches to one repository and
opens pull requests against another, and the failure is confusing rather than loud. And the loop
must work the repository where development actually happens, which in a delivery pattern is not
always the remote whose name matches the product.

Before the first run, confirm `gh repo set-default` matches `repo`. Every fetch, push, and
`git diff base...HEAD` goes through `remote`. Run `git remote -v` and read it; do not assume
`origin`, and do not assume the obvious-looking remote is the workspace.

**`pathAliases`.** One adopter maps `~/*` to `./app/*`; the other maps `~/*` to `./*`. Get this
wrong and the import-closure walk silently resolves nothing, which does not error. It degrades to
filename comparison, so proofs stop being invalidated when they should be and a stale approval can
merge. Read `tsconfig.json` `compilerOptions.paths` and transcribe it.

### `alwaysInvalidates` deserves thought, not copying

These are paths whose change invalidates any proof in flight, whatever the pull request touched,
because import scanning cannot reach them. Ask: what does everything depend on that nothing
imports by a module path? Lockfile, package manifest, type and lint config, build config,
generated output, schema and migrations, CI workflows.

The web monorepo's list names `server/prisma/` and `vite.config`. Neither exists in the mobile
app, which instead has its generated GraphQL output, its Drizzle schema, `app.config.ts`,
`metro.config.js`, and `tailwind.config`. Copying either list verbatim into a third repository
gives you a list that matches nothing.

The same reasoning applies to `touchPaths`, which mechanically classifies a diff as `migration` or
`ci` for the merge boundary: point it at your schema, migration, and workflow directories. The
worker and reviewer also self-report those categories, but the path scan is what makes the
boundary independent of anyone's say-so.

### `releaseArtifacts`: carve the machine's own noise out of staleness

If every merge to your base branch triggers release automation that commits files back (a deploy
constants file, a generated changelog), each landing rewrites paths that `alwaysInvalidates`
matches, which discards the approval of every pull request still queued and re-reviews the same
code for noise the machine itself produced. List those machine-rewritten files here and their base
movement stops invalidating approvals entirely, so only list a file whose every landing-time
change is machine-produced; a file humans also edit does not belong here. `package.json` needs no
entry: a base change that only bumps its `"version"` field is recognized as release noise
automatically, while a dependency change still invalidates. One adopter's release bot committed a
deploy-constants file and a version bump on every landing, and a two-merge queue paid three full
re-reviews before this key existed.

## Preconditions

- `gh` authenticated with push and merge rights on the repository.
- The agent CLIs you intend to seat, on `PATH`. Each role is an `engine:model` spec: defaults live
  in `CONFIG.seats`, and any run can override them with `--appraiser`, `--worker`, and `--reviewer`.
  The known engines are the `ENGINES` registry in `loop.ts`; a CLI the loop does not yet know is
  one registry entry (how to run one prompt to completion, non-interactively, with its approval
  gate bypassed), not a refactor. **Keep the worker and reviewer on different engines**; a reviewer
  built from the same model as the author shares its blind spots by construction, and that
  isolation is the only thing catching a worker that convinced itself. The driver warns, but does
  not refuse, when they match.
- The sibling `prove-work-on-github` skill available to both worker and reviewer. This is a hard
  dependency: both prompts load it by name, and the merge gate's freshness rule implements its
  `references/freshness-and-reproof.md`. It ships in the same collection as this loop, so
  installing the simiancraft-skills plugin (`/plugin marketplace add simiancraft/simiancraft-skills`,
  then `/plugin install simiancraft-skills@simiancraft-skills`) brings both; for an engine with no
  skill loader, keep a checkout of the repo readable from the worktrees so "load the skill"
  resolves to files on disk.
- A CI workflow that **skips drafts**. The loop opens pull requests as drafts and marks them ready
  once, to protect the CI budget. Without the draft guard every intermediate push spends a run. A
  typical guard is `types: [..., ready_for_review]` plus
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

- **The appraisers are the highest-yield role.** Across the first field runs, more issues were
  closed as already-fixed or obsolete with re-checkable receipts than were fixed by workers.
  Expect a stale backlog to shrink before anything is coded.
- **The loop executes the tracker, not your intent.** An issue that is internally coherent and
  points the wrong way will be implemented competently in the wrong direction; every stage judges
  the diff against the issue. The guard is `conventionDocs`, which is why those files must actually
  state your conventions.
- **Reviews take eight to twelve minutes**, mostly waiting on CI inside the reviewer's single turn.
  That is expected, not a hang.
- **A merge taxes the queue behind it.** If your pipeline writes follow-up commits to the base
  after every merge (a generated-constants write, a release version bump), each lands in
  `alwaysInvalidates` and each discards the approval of every pull request still queued, at the
  cost of a full re-review per discard. Safe, visible in the log, and worth knowing before you
  interpret it as a hang.

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

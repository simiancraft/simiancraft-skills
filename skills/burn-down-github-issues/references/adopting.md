# Adopting burn-down-github-issues

Instructions for bringing this loop to another repository, written for an agent doing the
adoption. Examples below contrast two invented repositories of different shapes, a web monorepo
and a mobile app, because almost every field that bites bites them differently. Neither column is
a real project; both are the kind of answer the field wants.

## What you are adopting

A headless loop that appraises recent issues, fixes the small ones, proves the work on a pull
request, and lets a second agent with no shared context decide whether it can merge. The roles and
the reasoning behind them are in `architecture.md`.

Read `architecture.md` first. It describes the shape and the reasoning; this file is only the
adoption.

## What you write: one config file, nothing copied

The loop ships with this skill and stays here. The repository carries exactly one thing:
`burn-down-github-issues.config.ts` at its root, exporting `{ project, ...knobOverrides }` as
default. The sibling fix skill reads the same file when the repository has no config of its own, so
adopting the loop also adopts its one-issue command.

The loop refuses to start without the file, and refuses again when a required `project` field is
missing, naming what it lacks. A template with placeholder values:

```ts
// Optional, and worth having: the type lives with the fix skill, so a config that drifts from the
// contract fails at type-check rather than at the first run. The path is wherever the collection
// is checked out.
import type { ProjectConfig } from '<skills-dir>/fix-github-issue/lib/config.ts';

export default {
  project: {
    name: 'YourApp',
    repo: 'your-org/your-app',
    remote: 'origin',
    baseBranch: 'main',
    evidenceBranch: '__evidence_locker__',
    checkCommand: 'bun run verify',
    installCommand: 'bun install --frozen-lockfile',
    conventionDocs: ['AGENTS.md', 'CLAUDE.md'],
    sizingScale: 'where your point scale is documented',
    sharedServices: ['the local database', 'the shared staging environment'],
    portBase: 41000, // any band your own dev servers do not use
    portSpan: 1000,
    pathAliases: [{ prefix: '~/', dir: '.' }],
    sourceExtensions: ['.ts', '.tsx', '.js', '.jsx'],
    alwaysInvalidates: ['package.json', 'bun.lock', '.github/workflows/' /* and more; see below */],
    releaseArtifacts: [] /* optional string[]; same pattern rules as alwaysInvalidates; see below */,
    touchPaths: {
      migration: ['db/migrations/'],
      ci: ['.github/workflows/'],
    },
    worktreeRoot: '../.your-app-loop',
  } satisfies ProjectConfig,
  // Optionally override any loop knob here: ageDays, maxPoints, autoMerge, maxReviewRounds,
  // checksTimeoutMinutes (how long the pull master waits on checks), checks ('required', the default,
  // or 'none' for a repository that runs no checks on a pull request; an empty list of checks is
  // never green otherwise),
  // smokeTimeoutMinutes,
  // reconciliationDays (how far back merged pull requests are checked against open issues on
  // start), limit, concurrency, appraiserConcurrency, appraiseLimit, skipLabels, and
  // callbacksDir (where the loop writes its size callbacks for the appraiser; see the appraise skill's
  // references/callbacks.md), and
  // seats: { appraiser: 'codex', confirmer: 'claude:claude-opus-5', callback: 'codex', worker: 'codex', reviewer: 'claude:claude-opus-5' },
  // The knife's seats, resolved after the merge: carver defaults to worker, carveConfirmer to confirmer then reviewer.
  // seats: { ..., carver: 'codex', carveConfirmer: 'claude:claude-opus-5' },
  // The knife's knobs; every one a positive integer. See carve-github-issue/references/adopting.md.
  // carve: { maxDepth: 3, maxChildren: 8, maxCarveRounds: 5, maxCarveAttempts: 3, maxGenerations: 5, maxRevisitsPerGeneration: 10 },
  // and confirmCloses (default true): a close proposed by the appraiser needs the confirmer's agreement.
  // A command-line flag beats the config for limit, maxPoints, appraiseLimit, and the seats.
  // floor: { cadenceMinutes: 10, drainMinutes: 60 } starts walk-the-floor beside the loop; see "The line" below.
};
```

**If adopting makes you edit a function in `loop.ts`, that value belongs in the config contract
and the change belongs in this skill.** Say so rather than working around it.

The prompts never name a repository. They are rendered with the `project` vocabulary at each
invocation, so `{{REPO}}`, `{{CHECK_COMMAND}}`, `{{EVIDENCE_BRANCH}}` and the rest resolve from
config. Do not hand-edit prose in `prompts/` to say your project's name.

## Fill this in

| Field | What it is | Web monorepo (invented) | Mobile app (invented) |
|---|---|---|---|
| `name` | banner only | the product name | the product name |
| `repo` | `owner/repo`, builds evidence links | the repository where development happens | the same, even when a second remote exists (see below) |
| `remote` | **check this**, not every checkout says `origin` | `origin` | `origin`, beside a second remote (see below) |
| `baseBranch` | cut from and merged into | `main` | `develop` |
| `evidenceBranch` | long-lived, append only | `__evidence_locker__` | create one |
| `checkCommand` | the local gate | `bun run lint && bun run test` | `bun run verify` (a script fanning out to many checks) |
| `installCommand` | frozen-lockfile install | `bun install --frozen-lockfile` | the same |
| `conventionDocs` | what a prescribed remedy is read against | `CONTRIBUTING.md` | `AGENTS.md` |
| `sizingScale` | where the point scale is written | a docs page | an issue template |
| `pathAliases` | **check this**, alias to directory | `@/` to `src` | `~/` to `.` |
| `sourceExtensions` | closure walk candidates | ts, tsx, js, jsx | same |
| `alwaysInvalidates` | see below | ORM schema and bundler config | app config and native build files |
| `touchPaths` | mechanical merge-boundary classification | schema directory + workflows | migrations directory + workflows |
| `sharedServices` | what an agent must not reset | database, message queue | database, a shared staging tenant |
| `portBase` / `portSpan` | `portBase + (issue % portSpan)` | 41000 / 1000 | chosen to avoid the dev server's own port |

Also set `worktreeRoot`, which is a sibling directory outside the repository root so no tool that
walks the working tree has to be told to ignore it.

### The two that actually bite

**`remote`, and it is worse than a rename.** A checkout can carry **two** remotes pointing at
**two different repositories**, a fork and its upstream, or a working repository and a mirror:

```
mirror   https://github.com/other-org/the-app.git
origin   git@github.com:your-org/the-app.git
```

The loop must work the repository where development actually happens, which is not always the
remote whose name looks most official. `remote` and `repo` must name the same repository, because
`repo` builds the evidence links and `gh` resolves pull requests against a repository of its own
choosing; a mismatch means the loop pushes branches to one repository and opens pull requests
against another, and the failure is confusing rather than loud.

Before the first run, confirm `gh repo set-default` matches `repo`. Every fetch, push, and
`git diff base...HEAD` goes through `remote`. Run `git remote -v` and read it; do not assume
`origin`, and do not assume the obvious-looking remote is the workspace.

**`pathAliases`.** One repository maps `@/*` to `./src/*`; another maps `~/*` to `./*`. Get this
wrong and the import-closure walk silently resolves nothing, which does not error. It degrades to
filename comparison, so proofs stop being invalidated when they should be and a stale approval can
merge. Read `tsconfig.json` `compilerOptions.paths` and transcribe it.

### `alwaysInvalidates` deserves thought, not copying

These are paths whose change invalidates any proof in flight, whatever the pull request touched,
because import scanning cannot reach them. Ask: what does everything depend on that nothing
imports by a module path? Lockfile, package manifest, type and lint config, build config,
generated output, schema and migrations, CI workflows.

A web monorepo's list might name its ORM schema directory and its bundler config. Neither exists
in a mobile app, whose list names its app config, its native build files, and its generated API
types instead. Copying either list verbatim into a third repository gives you a list that matches
nothing.

The same reasoning applies to `touchPaths`, which mechanically classifies a diff as `migration` or
`ci` for the merge boundary: point it at your schema, migration, and workflow directories. The
worker and reviewer also self-report those categories, but the path scan is what makes the
boundary independent of anyone's say-so.

### `releaseArtifacts`: carve the machine's own noise out of staleness

List every file your release automation rewrites on each merge to the base: a deploy-constants
file, a generated changelog. Movement in these stops invalidating approvals. Only list a file whose
every landing-time change is machine-produced; a file humans also edit does not belong here.
`package.json` needs no entry: a base change that only bumps its `"version"` field is recognized
as release noise automatically, while a dependency change still invalidates. Without this key,
each landing rewrites paths that `alwaysInvalidates` matches, so every queued pull request loses
its approval and is re-reviewed for noise the machine produced.

## The line: a switch, and a walker that flips it

The loop reads `<worktreeRoot>/runs/line-switch` at three seams: before the appraisal batch, before
each issue is dispatched, and inside the pull master before every merge. The file's first line is
`go` or `pause`; anything after it is the reason; an absent file means go, and an unknown word
means pause. A paused seam holds and polls every thirty seconds, logging once, until the file says
go. Anyone can flip it:

```bash
echo pause > <worktreeRoot>/runs/line-switch     # hold every seam
echo go > <worktreeRoot>/runs/line-switch        # release
```

With `floor: { cadenceMinutes: N }` in the config and a `walk-the-floor.config.ts` beside it, the
loop also starts the `walk-the-floor` skill as a child, on `<worktreeRoot>/floor/`, and writes two
executable callbacks there: `on-fail` pauses the line with a reason naming the failed item, and
`on-pass` releases a pause that the same item caused and no other, so a pause a person set by
hand stays until that person clears it. Every merge the loop makes is put on the floor as a list
item, and the walker checks it against the deployed base on its next wake. The walker's log is
`<worktreeRoot>/runs/floor.log`. The loop never reads the walker's ledger to decide anything; the
switch is the whole interface.

When the run is done the loop does not kill the walker; its last merges landed on the floor seconds
earlier and are still unwalked. It sends SIGUSR1, which tells the walker to finish every pending
item and exit, and waits up to `floor.drainMinutes` (default 60) for that. If items are still
pending at the cap (a deploy that never landed, an incident whose fix is still running) the loop
stops the walker, names the count, and prints the `walk.ts --once` command that finishes them.
Ctrl+C still stops the walker outright.

`project.smokeCommand` is the other half: it runs in the lane after the checks are green and
before the merge, so a change that builds but does not boot parks instead of landing. See the
`fix-github-issue` skill's `references/pipeline.md`.

`project.followBase: true` keeps the main checkout on the merged base: after each merge the loop
fast-forwards it, so the dev server you are watching there shows the fix without a pull. It only
ever fast-forwards a clean checkout that has the base branch out; anything else is left alone and
said so in the log.

## Preconditions

- `gh` authenticated with push and merge rights on the repository, and with the `project` scope
  (`gh auth refresh -h github.com -s project`), which `board.ts` needs to create the run board.
  `gh auth status` lists the scopes; `read:project` is not enough.
- The agent CLIs you intend to seat, on `PATH`. Each role is an `engine:model` spec: defaults live
  in `CONFIG.seats`, and any run can override them with `--appraiser`, `--worker`, and `--reviewer`.
  The known engines are the `ENGINES` registry in `loop.ts`; a CLI the loop does not yet know is
  one registry entry (how to run one prompt to completion, non-interactively, with its approval
  gate bypassed), not a refactor. **Keep the worker and reviewer on different engines** (why: `architecture.md`). The driver
  warns, but does not refuse, when they match.
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
- An issue tracker where issues carry `size: N` labels, or an appraiser run to create them. The
  driver creates every label it uses (`size: N`, `needs-decision`, `needs-human`, `loop/*`) on
  start and applies the appraiser's verdict itself; nothing needs pre-creating.

## Order of work

1. Write `burn-down-github-issues.config.ts` from the template above. Copy nothing else.
2. `bun run <skill-dir>/board.ts`. It finds or creates the operator's board, verifies it by a
   second read, and prints its number and URL; `--dry-run` only reports. See "The board" below.
3. From the repository root: `bun run <skill-dir>/loop.ts --dry-run --limit 2`. This mutates
   nothing and starts no agent. It prints what it would select and writes each rendered prompt to
   `<worktreeRoot>/runs/<issue>-<role>-<timestamp>.log`.
4. **Read one rendered prompt.** `grep -oE "\{\{[A-Z_]+\}\}"` against it must return nothing; an
   unresolved placeholder means a field you did not set. Confirm the prose names your repository,
   your commands, and your branches.
5. Verify the closure walk resolves:
   `bun run <skill-dir>/loop.ts --closure <file-with-an-aliased-import>` prints every module
   the walk reaches and exits without touching anything. A result of one module (only the entry
   itself) means the aliases resolve nothing, which is the silent failure described above.
6. One real issue, alone: `--issue <n>`; it implies `--no-appraise`. Watch it end to end.
7. Then a small batch. `--limit 3` before `--limit 5`.

## The board

The durable state of a burndown is a GitHub Projects (v2) board, one per operator per repository,
titled `<project>_burndown_<operator>`: the config's `project.name` lower-cased, then the GitHub
login `gh` is authenticated as (`--operator <login>` overrides it). It is owned by the owner in
`project.repo`, an organization or a user, and linked to the repository so it shows on the
repository's Projects tab. Scoping the board to the operator is deliberate: a person who stops a
burndown and returns days later resumes from their own board, and two operators working the same
repository do not share one.

`board.ts` is idempotent. An open board with the title is reused, never duplicated; a closed board
with the title is named in the output and left alone, since closing is how a board is retired. The
board it finds or creates is read back by a second call before it is trusted, and the result is
written to `<worktreeRoot>/runs/board.json` as `{ owner, number, id, title, url }`. That file is a
pointer, not the state: delete it and the next `board.ts` finds the board again by title.

```bash
bun run <skill-dir>/board.ts             # find or create, verify, write the pointer
bun run <skill-dir>/board.ts --dry-run   # find and report; creates nothing
```

### Getting the scope, and proving you have it

Creating a board, and adding or renaming its lanes, needs the `project` OAuth scope on the `gh`
token. The token `gh auth login` issues carries `read:project`, which lists boards but cannot
create or change one; `board.ts` checks the scope first and prints the refresh command rather than
failing inside GraphQL. The refresh is a device flow, and it went wrong twice on the first
adoption, so here is the procedure that worked and the checks that tell the difference.

1. Ask for the scope from the **same `gh` the loop will run under**:
   `gh auth refresh -h github.com -s project`. It prints a one-time code and waits; enter the code
   at https://github.com/login/device and continue to the success page. A machine with more than
   one `gh` (Windows and WSL, two distros, a second `GH_CONFIG_DIR`) has one token file per
   install, and a refresh completed in the wrong terminal succeeds against the wrong file. That
   is what happened twice: the browser said connected, and this install's token never changed.
2. The refresh needs an interactive terminal. Under a harness that runs shell commands without a
   TTY, start it detached with stdin from `/dev/null` and its output to a file, read the code from
   the file, and enter it by hand; the process polls GitHub until the code is used and then
   rewrites the token. `board.ts` cannot do this for you, since the browser step is a person's.
3. Prove the scope landed with two reads that must agree:
   `gh auth status` lists the stored token's scopes, and `gh api -i user` returns the live
   `X-Oauth-Scopes` header for the token actually sent. Both must name `project`. If `gh auth
   status` still shows `read:project` after a success page, the modification time of
   `~/.config/gh/hosts.yml` tells you whether anything wrote to this install at all.
4. Then `bun run <skill-dir>/board.ts`, and run it a second time: the second run must print
   `exists` and the same number, which is the idempotence check.
5. Then `bun run <skill-dir>/lanes.ts`, which writes the lane set onto Status and creates the
   Phase field, and reads both back; a second run prints `already in place` for each. The lanes
   and what they mean are `state-machine.md`.

Lanes are options on the board's `Status` single-select field, changed with the
`updateProjectV2Field` GraphQL mutation. That mutation replaces the whole option set and assigns
fresh option ids, even to options whose names did not change (observed on the first board: `Todo`
went from one id to another when a fourth lane was appended). So a script that manages lanes
always sends the complete set, matches by name, and never stores an option id anywhere that
outlives the call.

## Let an agent operate it without approval stalls

Every operation on a run is `bun run <skill-dir>/<script>.ts ...`: `loop.ts` to start, `watch.ts`
to follow, and the walker's `walk.ts`. That is deliberate, so a harness that gates shell commands
has one shape to allow. If the agent driving the loop runs under such a harness, allow that shape
up front in the adopting repository's settings rather than approving each invocation; in Claude
Code that is a `Bash(bun run *burn-down-github-issues/*.ts*)` entry (and the `walk-the-floor`
equivalent) in `.claude/settings.json`. An agent that reaches for `tail -F`, `kill`, `pgrep`, or
`nohup` around the loop is missing a script, and the fix is to add the script here, not to widen
the allowlist.

## Boundaries to set deliberately

`autoMerge` defaults to `code-only`: merge code, park anything touching production data, a
migration, or a stored string. `maxPoints: 2` keeps the loop to work small enough that a bad merge
is cheap. `ageDays: 30` keeps it to issues whose context is still true. Widen after a run has gone
well, not before.

`maxReviewRounds` is a **per-issue high-water mark**, not a per-run allowance; the count lives on
the issue as `loop/reviews: N`. At the cap the issue goes to the review dead-letter queue
(`loop/dlq: review`) with the reason that put it there; there is one queue per phase, and removing
the label or running `fix.ts --redrive` is the redrive, counted as `loop/redrives: N`.

## What will surprise you

- **The appraisers can be the highest-yield role.** A stale backlog can shrink before anything is
  coded, as issues close as already-fixed or obsolete with re-checkable receipts.
- **The loop executes the tracker, not your intent.** An issue that is internally coherent and
  points the wrong way will be implemented competently in the wrong direction; every stage judges
  the diff against the issue. The guard is `conventionDocs`, which is why those files must actually
  state your conventions.
- **Reviews take as long as CI does**, since the reviewer waits on the checks inside its single
  turn. That is expected, not a hang.
- **A merge taxes the queue behind it.** If your pipeline writes follow-up commits to the base
  after every merge (a generated-constants write, a release version bump), each lands in
  `alwaysInvalidates` and each discards the approval of every pull request still queued, at the
  cost of a full re-review per discard. Safe, visible in the log, and worth knowing before you
  interpret it as a hang.

## Stopping a run

Ctrl+C, or SIGTERM to the pid in `<worktreeRoot>/runs/loop.lock`, stops the loop politely: agents are killed with
their process groups and the lock is released. Everything durable is already on GitHub, so after a
stop, check three places: open drafts (work finished but never marked ready), issues labelled
`loop/parked`, and `<worktreeRoot>/runs/*.log` for the lanes that were in flight. Worktrees left behind are
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

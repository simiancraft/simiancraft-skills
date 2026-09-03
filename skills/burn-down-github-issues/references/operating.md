# Operating a run

Written for someone who arrives with no context: how to start a run, tell whether it is healthy,
read what it did, and finish what it could not. `adopting.md` covers configuring a repository the
first time; this file covers every run after that. One named issue is the sibling fix skill's
command rather than a flag on the loop; see its SKILL.md.

## Identify the driver by its lock, never by a pattern

The loop writes its own pid to `<worktreeRoot>/runs/loop.lock` and releases it on exit. That file
is the only trustworthy identity.

```bash
PID=$(cat <worktreeRoot>/runs/loop.lock)
ps -o command= -p "$PID"            # confirm it names loop.ts before you trust it
```

**Do not find the driver with `pgrep -f loop.ts`.** Two ways that goes wrong:

- Launching under `nohup` or a shell wrapper leaves a short-lived parent that matches the pattern
  and exits within a second. A watcher armed on it reports the run finished moments in, while the
  real run continues.
- A monitor whose own command line contains the pattern matches itself, so the process never looks
  absent and the watch never ends.

The same rule applies to counting agents: `ps | grep -c` counts the grep, and an engine may show
up as several processes (a node wrapper plus a native binary). Trust counters derived from the run
log, and verify process state with a direct check on a pid you already confirmed.

## Watch the run

The driver tees everything it prints to `<worktreeRoot>/runs/driver.log` (every run, appended,
each opened by a `run pid N started` header) and its walker child to `runs/floor.log`; each agent
additionally gets `runs/<issue>-<role>-<timestamp>.log`. Driver lines are timestamped `HH:MM:SS`;
everything else is agent output echoed through.

**Watch with the shipped watcher, not with shell.** From inside the repository:

```bash
bun run <this-skill-dir>/watch.ts           # events from the current run; exits when the driver exits
bun run <this-skill-dir>/watch.ts --all     # every line
bun run <this-skill-dir>/watch.ts --wait    # silent until the run ends, then its terminal lines
```

It finds the driver by the lock, follows the two logs in-process, and exits on its own, so it is
one command with nothing to approve. An agent must not compose the equivalent from `tail -F`,
`kill -0`, `pgrep`, `nohup`, or a subshell: each of those is a separate thing a harness has to
approve, the approval prompts stall the run they were meant to watch, and the hand-rolled version
gets line-buffering wrong often enough that silence and health look the same. If the watcher
cannot show you something you need, that is a change to `watch.ts`, not a reason to write a
pipeline.

Start the driver the same way: `bun run <this-skill-dir>/loop.ts ...` in a terminal of its own,
or as a harness background task with stdout sent to a file. It does not need `nohup`.

## The operator board

On by default. Besides the timestamped log, the driver prints one board line per issue the moment
its state changes, the whole board every five minutes (`--pulse <minutes>` changes the cadence),
and the elapsed pause on every poll of the switch while the line is paused. `--silent` turns all
three off and leaves the log alone.

```
🎫 #1234  ✅ merged (PR #1250 3f2a9c1d0e)  🟢 active  ⏱ 14:56 3/3/2026  fix(search): return a page
🎫 #1240  🅿️ parked (autoMerge: code-only, touches migration)  🟢 active  ⏱ 15:02 3/3/2026  feat(...)
⏸️ paused 4m 30s  holding the merge queue  ⏱ 20:07:12
💓 pulse  ⏸️ paused 5m 0s (floor: liveness is down)  ⏱ 15:07 3/3/2026  ✅ 1 merged  🅿️ 1 parked  🔨 2 working
```

Stages: 📏 appraising, 🏷️ sized, 🗂️ closed, 🙋 handed-off (needs-decision or needs-human), 🔨
working, ✅ merged, 🅿️ parked, ☠️ dlq, ❌ failed, 🌀 out-of-band. A merge line is printed by the
pull master at the moment of the merge, before the lane finishes, so it never waits for the pulse.

A pause is silent at one place by design: a lane already inside the check-wait for its pull request
consults the switch only once the checks are green, so a `pause` written during a long CI run shows
its first board line when that wait ends. The `🟢 active` or `⏸️ paused` segment on every other
board line reflects the switch as the driver last read it.

The counters worth watching, and what a stall in each means:

| Signal | Meaning |
|---|---|
| `running appraiser on #N` | sizing; read-only, minutes each, three at a time by default |
| `running worker on #N` | fixing and proving; tens of minutes is normal |
| `running reviewer on #N` | judging; as long as CI takes, waited on inside one turn |
| `review round N of M` | a rejection was recorded; the issue is being revised |
| `merge PR #N` | the pull master landed it |
| `park #N` | the loop stopped and handed the issue to a human |
| `label #N needs-decision` or `needs-human` | handed off before any pull request; the reason is a comment on the issue, and the label keeps it out of selection until removed |
| `to the DLQ` | the per-issue review budget is spent |

**Reviews stuck at zero while workers finish is the signature of a gate refusing everything.** A
dirty-worktree bug looks like this: every worker parks and no reviewer ever runs.

When watching for failure, match every terminal state rather than the happy path. Silence from a
filter that only greps for success is indistinguishable from a healthy run:

```
worker failed|reviewer wrote no verdict|exceeded [0-9]+ minutes|refusing to merge
|did not report a merge|conflicts with|uncommitted changes|Cannot find|SyntaxError
```

## When the line is paused

A paused seam logs one line, `line is paused (<reason>); holding <where> until <path> says go`,
and then nothing until it resumes. That silence is the point, not a hang. `cat` the switch file to
see the state and the reason. A reason beginning `floor:` was written by the walker's `on-fail`
callback and names the item that failed; the walker's ledger on `<worktreeRoot>/floor/` and its
log in `<worktreeRoot>/runs/floor.log` say what it found. A reason without that prefix was written
by a person, and only a person clears it: `echo go > <worktreeRoot>/runs/line-switch`.

## What is not a bug

- **`repair: #N is open but PR #M merged ... closing with a pointer` at startup.** An earlier run
  merged the pull request and died before recording the close. The repair closes the issue, puts
  the merge on the floor, and prevents the issue being fixed a second time.
- **A worker exits non-zero and the issue is left untouched.** The driver refuses to trust the
  answer of a process that failed. The issue keeps no label and gets no pull request, so a later
  run picks it up normally. This is the fail-closed path working.
- **An issue is parked.** Parking is a handoff, not an error. The work is on the pull request.
- **An appraiser closes an issue without a worker.** That is the highest-yield thing the loop does.
  The `closeComment` carries a re-checkable receipt; read it rather than reopening on instinct.
- **A worker returns `already-fixed` in minutes.** It opened the file and found the fix
  already there.
- **A sizing disagreement is recorded on the issue.** The appraiser sizes the work the written
  convention implies, not the remedy the issue proposed, and says so.

## Stopping

`kill $PID` on the pid from the lock, or Ctrl+C in the foreground. The driver traps the signal,
takes each agent down with its whole process group, and releases the lock. Everything durable is
already on GitHub.

A signal skips the per-issue cleanup deliberately, so a killed run leaves worktrees behind for
`reconcile` to judge on the next start; that is what lets a stranded pull request resume.

## After a run

Verify outward-facing facts against the forge, not the log. The log is trustworthy for counters and
untrustworthy for whether GitHub actually did the thing.

```bash
gh pr list --state merged --limit 10 --json number,title,mergedAt
gh issue list --label loop/parked --state open
gh issue list --label loop/dlq --state open
git worktree list | grep <worktreeRoot>          # expect none but checkouts you made yourself
```

Then decide about anything parked or DLQed. A DLQed issue keeps the reason that put it there;
removing `loop/dlq` is the redrive.

## Landing a parked pull request by hand

A parked pull request is finished work that the loop declined to land. Landing it is not
`gh pr merge`; the freshness rules that govern the pull master govern you too, and skipping them
is how a base branch gets broken.

Before doing any of it by hand, consider re-driving the issue: `bun run <fix-skill-dir>/fix.ts
--issue <n>` puts one named issue back through the worker, the reviewer, and the pull master, with
the same freshness and merge rules the loop applies. Do it by hand when the pipeline has already
spent the issue's review budget, or when the objection is one no revision will answer.

1. **Judge adequacy** against `prove-work-on-github`'s `references/judgement.md`: every
   load-bearing claim receipted, pinned, resolvable **on the remote**, fresh, re-checkable, clean,
   plus the deciding command CI runs actually covered.
2. **Check freshness** for each pull request:
   `git diff --name-only <capturedSha>...<remote>/<base>`. Use the SHA the proof names, not the
   current head; after a branch update the merge base is the base's own tip and the diff is
   vacuously empty. **An empty incoming set is only meaningful if you confirmed it is non-zero
   before filtering.**
3. **A global invalidator in that set means stale, full stop** unless the incoming change is
   byte-identical to what the branch already carries, in which case nothing is actually incoming.
4. **Otherwise intersect** the incoming set with the import closure of the changed files
   (`--closure <file>`), and reacquire any receipt whose covered paths were touched.
5. **Order the merges** so that a pull request touching a global invalidator (a lockfile, a
   manifest, build or lint config, generated output) goes **last**. Landing it first invalidates
   every sibling for nothing.
6. Merge with `--match-head-commit <sha>`, confirm `mergedAt` is non-null, then close the issue
   manually and clear `loop/parked`.

`mergeable` from GitHub is not freshness. A pull request can be MERGEABLE and CLEAN while its
green check describes a tree that no longer exists: a change to the test runner can land on the
base minutes after a worker finishes, and that branch's suite would fail to import the moment it is
caught up.

## Cleaning up

Per-issue cleanup runs in the fix pipeline's `finally`, so a lane that returns removes its worktree
and any `issue-N-<scratch>` sibling whatever the outcome. Two things it does not do:

- A killed run skips it entirely, by design. `reconcile` sorts it out next start, keeping any
  worktree whose issue has an open pull request, and keeping a dirty pull-request-less worktree for
  inspection.
- Local branches from lanes that never merged are left behind. They are cheap refs rather than
  checkouts, so they cost little, but they accumulate. Prune the ones whose upstream is gone:

```bash
git fetch --prune <remote>
git branch -vv | grep ': gone]' | awk '{print $1}' | xargs -r git branch -D
```

## House rules the loop enforces, and you must too

- **Never list an agent or a bot as an author or co-author.** The reviewer treats it as a hard
  block; so should you.
- No em dashes anywhere: commits, pull request prose, code comments. Semicolons instead.
- Conventional Commits, imperative, facts only, no section headers in a commit body.
- Pull request prose describes the code, never the process. No mention of loops, agents, prompts,
  or local tooling; a reader on the forge has no idea those exist.
- The loop closes issues itself with a pointer to the pull request; never a closing keyword, which
  would close on merge before the loop records the outcome.

## When a trunk reaches the revisit cap

A carved issue (a trunk, `loop/carved`) is revisited by the knife after every child close and
whenever its tree moves; each revisit is counted in its carving record. At
`carve.maxRevisitsPerGeneration` (default 10) in one epoch the trunk goes to a person with
`needs-human`, and removing the label starts a new epoch with the count at zero. How often a
healthy trunk is revisited is unmeasured: the record makes it measurable. If trunks reach the cap
routinely, raise it in the config, or rethink the trigger (a fingerprint change that is not a leaf
close is the usual cause: a person editing children's bodies one at a time, say).

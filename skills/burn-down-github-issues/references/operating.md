# Operating a run

Written for someone who arrives with no context: how to start a run, tell whether it is healthy,
read what it did, and finish what it could not. `adopting.md` covers configuring a repository the
first time; this file covers every run after that.

## Identify the driver by its lock, never by a pattern

The loop writes its own pid to `<worktreeRoot>/runs/loop.lock` and releases it on exit. That file
is the only trustworthy identity.

```bash
PID=$(cat <worktreeRoot>/runs/loop.lock)
tr '\0' ' ' < /proc/$PID/cmdline     # confirm it names loop.ts before you trust it
```

**Do not find the driver with `pgrep -f loop.ts`.** Two ways that goes wrong, both observed:

- Launching under `nohup` or a shell wrapper leaves a short-lived parent that matches the pattern
  and exits within a second. A watcher armed on it reports the run finished about thirty seconds
  in, while the real run continues for an hour.
- A monitor whose own command line contains the pattern matches itself, so the process never looks
  absent and the watch never ends.

The same rule applies to counting agents: `ps | grep -c` counts the grep, and an engine may show
up as several processes (a node wrapper plus a native binary). Trust counters derived from the run
log, and verify process state with a direct check on a pid you already confirmed.

## Watch the run

Everything the driver says goes to the file you redirected stdout to; each agent additionally gets
`<worktreeRoot>/runs/<issue>-<role>-<timestamp>.log`. Driver lines are timestamped `HH:MM:SS`;
everything else is agent output echoed through.

```bash
tr -d '\033' < run.log | sed 's/\[[01]m//g' | grep -E "^[0-9]{2}:[0-9]{2}:[0-9]{2}"
```

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

## What is not a bug

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
base minutes after a worker finishes, and that branch's suite fails to import the moment it is
caught up.

## Cleaning up

Per-issue cleanup runs in `handleIssue`'s `finally`, so a lane that returns removes its worktree
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

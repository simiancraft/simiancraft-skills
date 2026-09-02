# Operating the walker

For someone who arrives with a floor already configured: how a wake proceeds, how to read what it
left behind, and what to do when it pauses something.

## One wake, in order

1. **Lock.** `floor.lock` holds the walker's pid; a second walker on the same floor refuses to
   start. A lock whose pid is dead is reclaimed.
2. **Liveness.** The driver fetches the base URL and every health path itself. A non-2xx writes a
   `down` entry against the synthetic item `liveness`, runs `on-fail`, and goes straight to
   diagnosis; nothing else is walked on a wake that found the environment down.
3. **Produce.** With `--from-forge` (the default), every pull request merged into the base since
   the newest forge-sourced item becomes a list item.
4. **Classify.** Each pending item with a merge SHA is checked against the deployed revision.
   `not-yet-deployed` and `unverified` are written without an agent and walked again next wake.
5. **Walk.** One agent turn for every remaining item, in a read-only checkout at the deployed
   revision, with the standing walks whose paths match rendered in. The agent writes one verdict
   file; the driver validates every entry against the vocabulary, writes the ledger, and runs the
   callbacks per entry.
6. **Repair.** For each `absent` or `down`: diagnose, file (or find) the `floor/incident` issue,
   hand it to `fix-github-issue`, then re-probe or re-walk that one item and write the result.
7. **Release** the lock, or sleep until the next wake under `--every`.

`--once` runs one wake and exits non-zero if anything is `down` or `absent` at the end of it.
`--every N` loops on the cadence, holds the lock for the process lifetime, and re-notifies at most
once an hour while the environment stays down.

## Watching a walker

Every wake is teed to `<floor>/walk.log`. Follow a running walker with the burndown's watcher
rather than shell:

```bash
bun run <burn-down-github-issues-dir>/watch.ts --floor <floor>          # events; exits when the walker exits
bun run <burn-down-github-issues-dir>/watch.ts --floor <floor> --wait   # silent until it exits, then the terminal lines
```

It finds the walker by `<floor>/floor.lock` and reads the log in-process. An agent must not build
the equivalent from `tail -F`, `kill -0`, or a subshell; each is a separate approval for a harness
to stall on, and the shipped watcher exists so that watching is one command.

## Reading the ledger

```bash
tail -20 <floor>/ledger.jsonl | jq -r '[.checkedAt, .itemId, .rung, .verdict, .reason] | @tsv'
jq -r 'select(.verdict == "absent" or .verdict == "down")' <floor>/ledger.jsonl   # anything wrong
jq -r 'select(.itemId == "liveness") | .checkedAt + " " + .verdict' <floor>/ledger.jsonl   # uptime by wake
```

The last `intact` liveness entry and the first `down` one bracket an outage to one cadence. That
pair is the forensic frame every diagnosis starts from.

## What an incident looks like

One issue, labelled `floor/incident`, titled for the item that failed, with:

- the failing ledger entry and the last clean one;
- the pull requests merged between the two revisions, newest first, with the diagnosis naming a
  culprit and its confidence;
- a log excerpt; and
- a pinned link to the evidence file.

The issue is then worked by `fix-github-issue` exactly as any other issue: a worker in a worktree,
a reviewer on another engine, a gated merge. Its outcome is on the issue and the pull request. A
second `absent` or `down` for the same item while that issue is open does not file again.

One exception: a diagnosis whose remedy is `outside-repository` (a reindex, a configuration value,
a vendor outage) parks the issue for a person with the diagnosis attached and runs no worker; the
line stays paused until the item walks clean again or someone clears the switch.

## When it pauses something

The walker itself pauses nothing; it runs `on-fail`, and whatever started it decides. If the issue
burndown started it, `on-fail` writes `pause` and a `floor:` reason into the burndown's line switch,
and the burndown's own operating notes say how to read and clear that. `cat <floor>/on-fail` shows
exactly what will happen on a failure; if it is a script you did not expect, that is the thing to
read before anything else.

## What is not a bug

- **Every item on a fresh floor is `not-yet-deployed`.** The environment has not caught up to the
  merges yet. They walk on a later wake.
- **`not-checkable` with a reason naming an endpoint.** The walker refused to post somewhere the
  config did not bless. Either add the endpoint to `safeEndpoints` or accept the residue.
- **The same item walked twice.** A pending verdict is walked again by design.
- **A `present` item whose change you cannot see yourself.** Read `reason`; the walker may have
  reached it by `exercise` or `fallback`. The rung says which.

## Stopping

Ctrl+C, or SIGTERM to the pid in `<floor>/floor.lock`. The lock is released; an agent turn in
flight is killed with its process group and leaves no ledger entry; the next wake starts clean.

SIGUSR1 to the same pid drains instead: a forever walker finishes every pending item on the floor,
then exits 0 on its own. A sleeping walker wakes at once; a walking one finishes its wake first.
A producer that started the walker sends this when its own run is done, so the last items it put
on the floor still get walked. An item that stays pending (`not-yet-deployed` against a deploy
that never lands) keeps the walker draining at its cadence; the producer decides how long to wait.

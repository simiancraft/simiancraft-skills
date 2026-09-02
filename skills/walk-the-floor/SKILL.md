---
name: walk-the-floor
description: >-
  Check a running environment against a list of things that should now be true in it, to a sanity
  standard (would a user notice), on a cadence or once. Reads the list from a directory anyone can
  write to, walks each item with a browser or device driver, records a rung and a verdict in an
  append-only ledger, runs conventional on-pass and on-fail callbacks, and when something is down
  or absent files an incident issue and fixes it through fix-github-issue. Use when the task is
  "keep an eye on the deployed base branch", "smoke-check what just merged", "walk the site every
  ten minutes", or "tell me the moment the deployed environment goes down". Requires a per-repository
  walk-the-floor.config.ts, the fix-github-issue skill, and one environment driver skill
  (playwright-harness for web, expo-ios-simulator or android-emulator-harness for mobile). Skip
  for a rigorous integration suite, which this is not, and for environments with no reachable
  running instance.
---

# Walk the Floor

A list checker and fixer for a running environment. It wakes, reads a list of things that should
now be true, goes and looks at each one to the standard **would a user notice**, writes what it
found to a ledger, and when the environment is wrong it files an incident and hands the incident to
`fix-github-issue`. It knows nothing about who wrote the list or why.

Three things make it composable rather than a monitor:

- **The floor is a directory.** `list.jsonl` in, `ledger.jsonl` out, both append only. A person, a
  loop, another skill, or the walker's own forge producer can all put items on the floor; the
  contract is in `references/the-floor.md`.
- **Two callback slots.** `on-pass` and `on-fail`, each an executable the driver runs or a prompt the
  agent reads. Whoever starts the walker decides what a failure means to them; the walker does not.
  The issue burndown uses `on-fail` to stop its own merge queue.
- **The environment is config.** Kind, base URL, health paths, how to read the deployed revision,
  how to log in, which endpoints are safe to post to, and the standing sanity walks all live in
  `walk-the-floor.config.ts` at the repository root. The skill never contains a project.

## The standard

Sanity, not integration. Go to the thing and look. If the change is a label, read it; if it is
behind a surface, do the ordinary user action that runs through it and see that it works; if there
is no surface, hit the endpoint or read the database and say that is what you did. A site that
boots, renders, and returns nothing for every search has no data, and only searching tells you.
The walk proves a user would not hit a wall; it does not prove the change is correct.

## Run it

From inside the target repository:

```bash
bun run <this-skill-dir>/walk.ts --dir <floor> --liveness-only --once   # probe the base URL and stop
bun run <this-skill-dir>/walk.ts --dir <floor> --once                    # one full wake
bun run <this-skill-dir>/walk.ts --dir <floor> --every 10                # forever, every ten minutes
bun run <this-skill-dir>/walk.ts --dir <floor> --once --dry-run          # probe and classify; no agent, no ledger entry, no callback, nothing filed
bun run <this-skill-dir>/walk.ts --dir <floor> --once --walker claude:claude-opus-5
```

`<floor>` is any directory; the walker creates it. `--from-forge` is on by default and appends an
item for every pull request merged into the base since the walker last looked; `--no-forge` turns
it off for a hand-written list.

## Read next

| Need | Read |
|------|------|
| The directory contract: files, item and entry shapes, rungs, verdicts, callbacks, incidents | `references/the-floor.md` |
| Adopt it in a repository: the config template, environment kinds and their drivers, authoring standing walks, credentials, preconditions, first-run order | `references/adopting.md` |
| Run it: once versus forever, reading the ledger, what an incident looks like on the forge, stopping | `references/operating.md` |

## Hard dependencies

- The [`fix-github-issue`](../fix-github-issue/SKILL.md) skill, imported for the agent runner, the
  project config, and the fix pipeline an incident is handed to.
- One environment driver skill, loaded by name in the walk prompt according to the configured
  kind: [`playwright-harness`](../playwright-harness/SKILL.md) for `web`,
  [`expo-ios-simulator`](../expo-ios-simulator/SKILL.md) for `ios`,
  [`android-emulator-harness`](../android-emulator-harness/SKILL.md) for `android`.
- `gh` authenticated with issue-creation rights on the target repository, and the CLI the walker
  seat names on `PATH`.

## The ceiling, named

The walker's judgement about what "the change is there" means is agent judgement: sharp on visible
changes, blunt on behavioural ones, and honest only if it says `not-checkable` rather than `intact`
when it did not reach the thing. Its writes to the environment are additive, tagged, and reverted
by contract, not by sandbox; run it only against environments where a stray tagged record is
tolerable. It sees an environment through the drivers it is given, so a change with no driver-
reachable surface is exactly the residue that stays unverified. And a walk is a sample: something
broken between two wakes is caught on the next wake, not the moment it breaks.

---
name: appraise-github-issues
description: >-
  Appraise a GitHub issue backlog unattended: for each issue, decide whether it is still real and
  how big it is, then apply the answer to the tracker as a size label, a needs-decision or
  needs-human label with the question stated, or a close carrying a re-checkable receipt. A close
  is confirmed by a second engine before it is made. Runs once, on one issue, over the whole
  backlog, or as an hourly heartbeat, and is the sizing stage of burn-down-github-issues. Use when
  the task is "size the backlog", "appraise every issue in this repo", "close what is already
  done", "triage recent issues without fixing them", or "keep the backlog sized". Requires a
  per-repository config (its own, or the burndown's) and the codex and claude CLIs for the default
  seats. Skip for fixing anything; this skill never writes to the repository.
---

# Appraise GitHub Issues

One read-only agent turn per issue answers two questions and stops: is it still real, and how big
is it. The answer lands on the issue, and that is the whole contract. Nothing reads this process;
the burndown, a person, or another skill reads the tracker.

This feature is about an **issue**; its children are **appraisals**: one verdict about one issue,
judged against the fetched base ref at one moment.

| Verdict | What lands on the issue |
|---|---|
| `valid` | a `size: N` label on the configured scale; a comment when it disagrees with a size already there |
| `already-fixed`, `obsolete` | a close with a receipt a stranger can re-check, after a second engine agrees |
| `needs-decision` | the label, and the exact question a person must answer |
| `needs-human` | the label, and what access or authority an agent lacks |

## The second opinion on a close

A close is the one appraisal verdict that is a write with consequences: a wrongly kept issue costs
a re-read, a wrongly closed one disappears. So before an issue closes, a **confirmer** on another
engine, with none of the appraiser's context, re-checks the receipt against the base ref: the
commit is an ancestor and does what was asked, or the file as the base holds it no longer has the
premise. Agreement closes the issue with both receipts on the thread. Disagreement labels it
`needs-human` with both opinions, and a person breaks the tie. A confirmer that crashes or writes
nothing is not evidence either way; the close is not made and the issue stays unsized.

Sizing and hand-offs stay single-opinion. They are labels a person can change.

Keep the appraiser and the confirmer on different engines; the driver warns when they match.
`--no-confirm` (or `confirmCloses: false`) closes on the appraiser alone, for a tracker whose
authors you trust to that degree.

## Run it

From inside the target repository:

```bash
bun run <this-skill-dir>/appraise.ts --dry-run             # select and print; no lock, no agent, no GitHub write (only runs/appraise.log)
bun run <this-skill-dir>/appraise.ts --limit 12            # up to 12 unsized issues in the window
bun run <this-skill-dir>/appraise.ts --issue <n>           # one issue, whatever its age or size
bun run <this-skill-dir>/appraise.ts --all                 # the whole open backlog, not only the window
bun run <this-skill-dir>/appraise.ts --all --include-sized # re-judge everything, sized or not
bun run <this-skill-dir>/appraise.ts --every 60            # heartbeat: appraise whatever is new, hourly
bun run <this-skill-dir>/appraise.ts --appraiser codex:gpt-5.6-sol --confirmer claude:claude-opus-5
```

`<this-skill-dir>` is the filesystem path of this directory wherever the collection is checked out;
it is a path, not a skill name. The command reads `appraise-github-issues.config.ts` at the
repository root, or the burndown's `burn-down-github-issues.config.ts` when that is what the
repository has (`references/adopting.md`). Every run is teed to `<worktreeRoot>/runs/appraise.log`.

## Standards this skill enforces

- **Read-only.** The appraiser and the confirmer edit no file, create no branch, install nothing,
  and run no suite. Their working directory is an empty scratch directory, not a checkout.
- **The base ref is the evidence.** "Already in the base" is judged against the fetched base
  branch, never the main checkout's working state.
- **A decision beats a small diff.** An issue that turns on a product or domain ruling nobody has
  made is `needs-decision`, however small the change.
- **The written convention beats the issue's prescription.** When an issue prescribes a remedy the
  repository's convention docs rule out, the appraiser sizes the convention-respecting remedy and
  says so; it does not stop for a human.
- **Closes carry receipts, and receipts get re-checked.** Narrative alone never closes an issue.

## Hard dependencies

- The sibling `fix-github-issue` skill, imported for the agent runner, config loader, prompt
  renderer, and label helpers. It ships in the same collection.
- `gh` authenticated with issue-edit rights on the target repository.
- The CLIs the seats name (by default `codex` and `claude`) on `PATH`.

## The ceiling, named

The appraiser executes the tracker's claims against the code, not your intent: an issue that is
internally coherent and wrong is sized competently. Issue bodies and comments are an untrusted
instruction channel read by agents with their approval gates bypassed; the read-only contract is a
prompt, not a sandbox, so run this only on trackers whose authors you trust as far as the
credentials the agents hold. The confirmer's independence is model-level, not identity-level; it
runs as the same GitHub account. And a size is a judgement on the configured scale, not a
measurement; disagreements between runs are recorded on the issue, not resolved by it.

---
name: emoji-readout
description: >-
  Write a short status readout of long-running work as a handful of emoji-led bullets a person can
  scan in five seconds after walking away: the time and how long it has been, what moved, what is
  stuck, and, last, whether anything needs them (⛔) or not (🟢). Use when asked for "a status
  update", "an emoji summary", "a readout", "where are we", "updates every N minutes", or at the checkpoints of a
  burndown, a long build, a migration, or any unattended run someone checks in on. Ships a small
  renderer (`lib/readout.ts`) for drivers that print the same shape from code. Skip for a one-line
  answer, and for a final report whose reader needs prose and reasoning rather than a scan.
---

# Emoji Readout

Someone walked away and came back. In five seconds the readout tells them **whether they are
needed**, and if not, **what changed and whether it is still moving**. It is a scan, not a story:
high level, list-like, one line per thing, an emoji leading each line so the eye can sort it
before reading it.

```
16:56 CDT · 1h 12m in

- ✅ PR #101 merged; checks green (5 pass, 6 skip)
- 🔄 def5678 in tests, 12 of ~18 min
- 🧱 #214 stuck 25 min: the worker keeps failing the lint gate on the same file
- 🩺 all processes alive; dev server answers
- 📅 next readout ~17:11
- ⛔ Needs you: may I delete the superseded plan file? (work continues meanwhile)
```

## Always there

- **The time, and how long.** The clock time with its zone, read from the clock (`date`) every
  time, never estimated; then how long the work has been running (`1h 12m in`). When the gap since
  the last readout matters too, say it in its own words (`20m since last`), never as `in`.
- **What moved.** What changed state since the last readout (landed, started, finished, failed,
  closed), and anything still running normally, with its progress against what is normal for it
  (`12 of ~18 min`). If nothing moved, say so: `nothing moved since 16:40`. A quiet readout must
  never look like one nobody checked.
- **What is stuck.** Anything not moving that should be: stalled, retrying, failing the same way,
  waiting on something outside, with how long. A stuck thing repeats in every readout until it
  moves; it is the exception to reporting only changes.
- **Whether you are needed, last.** ⛔ means one thing only: the reader has to decide, permit, or
  do something. Each item is answerable in one reply (a yes or no, lettered options, or a short
  question), and it repeats until answered. When nothing needs them, the last line is
  `🟢 Nothing needs you.`, so the emoji alone says which, and silence is never ambiguous. Never
  use ⛔ for anything else, and never bury a question elsewhere.

## When it applies

- **Calls made without asking.** Every consequential choice the agent made on its own (a skipped
  test, a chosen default, a deleted branch), and whether it can still be undone. Never optional
  when there is one.
- **The next checkpoint.** For a run on a cadence or left unattended: when the next readout is due
  (`next ~17:11`), and separately, if known, an estimate of when the work finishes. A missed
  checkpoint is how a reader learns the run died.
- **Run state, when it is not simply running.** Paused, finished, or stopped early, and whether
  work continues while a ⛔ waits.
- **Progress toward done.** For work with a known size, the count and what it counts:
  `7 of 12 issues merged`, `3 of 5 verified on staging`.

## The agent's call

Everything else is judgement about what this reader needs from this work right now.

- **Report what matters; omit what is inconsequential.** A section with nothing worth saying is
  absent, not "none". A risk, a slow step, a surprise, a number that moved: include it if it would
  change what the reader thinks or does.
- **Pick emoji that read at a glance,** one per line or group. Some that tend to work: ✅ done,
  🔄 moving, 🧱 stuck, 🩺 health, ⚠️ worth watching, 🧪 tests, 🚀 deploys, 🧹 cleanup. Invent one
  when the work has its own category. Within one session keep an emoji's meaning stable, so two
  readouts compare.
- **Group only when it helps.** A few peers under one emoji line read faster than a paragraph;
  most readouts need no nesting at all.

## What keeps it trustworthy

- **Receipts, briefly.** A short SHA, a PR or issue number, a count, a check name, a log time.
  "Tests pass" is a claim; "412 of 412 at 16:51" is a receipt.
- **Re-observe; don't recite.** Build each readout from fresh checks, not memory of the last one.
  An older fact keeps its time ("green at 16:40").
- **Say what is inferred.** Observed facts plainly; anything inferred or guessed says so.
- **Short.** Around ten lines is plenty, fifteen a ceiling. No preamble, no closing offer of next
  steps. If nothing moved, nothing is stuck, and nothing needs the reader, the readout is the
  header, `nothing moved since HH:MM`, and `🟢 Nothing needs you.`

On a cadence ("every 15 minutes"), schedule it with the harness's recurring trigger, build each
one fresh, and say in the last one that it is the last.

## From code

A driver that prints readouts imports the renderer and supplies its own sections:

```ts
import { renderReadout } from '<this-skill-dir>/lib/readout.ts';

console.log(renderReadout({
  since: runStartedAt, // header shows "· 1h 12m in"
  title: 'floor walk',
  sections: [
    { emoji: '✅', lines: ['PR #812 present on the deployed site (look)'] },
    { emoji: '🩺', label: 'Health', lines: ['up: / 200 in 120ms; deployed a1b2c3d'] },
  ],
  needsYou: [],
}));
```

Sections print in the order given; blank lines are dropped, and so is a section left with none.
A section with one line prints on one line, labelled or not. Several lines nest under the label;
without a label, each prints as its own bullet behind the emoji. A section given ⛔ is moved into
`needsYou`, which always prints last, or as `🟢 Nothing needs you.` when empty.

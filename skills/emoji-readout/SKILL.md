---
name: emoji-readout
description: >-
  Write a short status readout of long-running work as emoji-headed bullets a person can scan in
  five seconds: what landed, what is in flight, whether everything is healthy, what to watch, and
  what is waiting on them. Use when asked for "a status update", "an emoji summary", "a readout",
  "where are we", "updates every N minutes", or at the end of each step of a burndown, a long
  build, a migration, or any unattended run someone checks in on. Ships a small renderer
  (`lib/readout.ts`) for drivers that print the same shape from code. Skip for a one-line answer,
  and for a final report whose reader needs prose and reasoning rather than a scan.
---

# Emoji Readout

A readout answers one question for someone glancing away from other work: **do I need to do
anything, and if not, is it going fine?** It is a scan, not a story. The emoji are the scan:
each one is a fixed meaning, always in the same order, so the eye finds ⛔ without reading the rest.

```
16:56 CDT

- ✅ Landed:
  - PR #101 head abc1234: all checks green, 5 pass and 6 skip.
- 🔄 In flight:
  - def5678 (the parser fix): lint 20 of 20; tests 12 minutes into a run that usually takes 18.
  - Queued behind it: 1111111 and 2222222.
- 🩺 Health: no stalls or deaths; the dev server (:3000) responds; branch current with its base.
- ⚠️ The staging database needs a reset before this branch deploys there again.
- ⛔ Waiting on you:
  - May I delete the superseded plan file?
  - When an imported row matches an existing one, should the importer (a) skip it, (b) merge it, or (c) stop and report?
```

## The sections

In this order, each at most once. Leave out a section with nothing in it, except ⛔.

| Emoji | Section | What goes in it |
|---|---|---|
| ✅ | Landed | Finished **and checked** since the last readout, each with its receipt: a commit, a PR, a check run, a test count. |
| 🔄 | In flight | Running now, with progress against what is normal for it ("12 of ~18 minutes"), then what is queued. |
| 🩺 | Health | Whether the machinery is alive: processes running or stalled, services answering, branch currency. One line when all is well. |
| ⚠️ | Heads up | Something the reader should know but need not act on yet: a risk, a slow thing, a later chore. |
| ⛔ | Waiting on you | Only decisions or permissions the reader alone can give. When nothing waits, say `⛔ Nothing waiting on you.` so silence is never ambiguous. |

A sixth emoji is fine when a run has a recurring category none of these fit (🧪 for a test
matrix, 🚀 for deploys); define it once and keep it stable across readouts.

## Rules that make it trustworthy

- **The time comes from the clock.** Run `date` (or read it from the code) for the header every
  time; never estimate it, and never reuse the last one.
- **Re-observe; don't recite.** Build each readout from checks (logs, `gh`, process lists), not
  from memory of the previous one. Evidence from earlier is fine with its time on it ("green at
  16:40"); an unrechecked fact with no time is a guess.
- **Facts carry receipts.** A short SHA, a PR or issue number, a check name, a count, a log time.
  "Tests pass" is a claim; "bun test 412 of 412 at 16:51" is a receipt.
- **Mark what you inferred.** Observed facts are stated plainly; anything inferred or guessed says
  so ("probably", "I think", "unverified").
- **⛔ items are answerable in one reply.** A yes or no, lettered options, or a short question
  with an obvious form of answer. Name the thing being decided, not the backstory. Never hide a
  question in another section, and never put something there the reader cannot act on.
- **Short.** One line per bullet, sub-bullets only for a list of peers. Around fifteen lines is a
  ceiling, not a target. No preamble, no closing offer of next steps.
- **Changes, not inventory.** After the first readout, repeat only what changed plus anything still
  waiting. If nothing changed, the whole readout is the time and one line saying so.

When asked for readouts every N minutes, schedule them with the harness's recurring trigger, build
each one by these rules, and say in the last one that it is the last.

## From code

A driver that prints the same shape imports the renderer:

```ts
import { renderReadout } from '<this-skill-dir>/lib/readout.ts';

console.log(renderReadout({
  sections: {
    landed: ['#1234 present on the deployed site (look)'],
    health: ['up: / 200 in 120ms; deployed a1b2c3d'],
    waiting: [],
  },
}));
```

It stamps the local clock time with its zone, orders the sections, nests a line given as
`{ text, children }`, and writes `⛔ Nothing waiting on you.` when `waiting` is empty or absent.
`labels` renames a section for one producer (a deploy checker might call ✅ "Verified").

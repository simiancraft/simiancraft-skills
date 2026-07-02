# Contributing to asset-optimization

This skill is built to grow. It ships incomplete by design: the set of asset kinds is stable, but the
cookbook of recipes, the tool manifest, and the measured size data all expand as we learn. When you
discover a recipe, a tool, or a whole category that is not here yet, encode it and open a PR. An agent
that is only *using* the skill (not editing it) can instead open an **issue**, with the user's
permission, to report an outdated command or a missing recipe or kind; that trigger lives in `SKILL.md`.

## Where new knowledge goes

| You discovered | Add it to |
|----------------|-----------|
| a useful command or recipe | the kind's `executors/<kind>/cookbook.md` |
| a new tool | `tools.md` (define it once, with its key facts) |
| a real before/after measurement | the kind's `executors/<kind>/expectations.md` |
| a footgun or caveat | the tool's key-facts row in `tools.md`, and the recipe's Caveat line |
| a whole new asset kind (rare) | a new `executors/<kind>/` folder with the four organs |

## Adding a kind or tool: thread every registry

A new kind or tool touches several hand-maintained registries, not just its own file.

**A new kind** (`executors/<kind>/` with the four organs) must also be wired into:
- the dispatch table in `SKILL.md`,
- the extension table (and, if deferring it, the "Not yet a kind" list) in `classify.md`,
- the index in `cookbook.md`,
- its surface mapping in the new `targets.md`.

**A new tool** (a row in `tools.md`) must also:
- carry a `Kinds` value that matches which executors actually use it, and
- appear in the Prerequisites of every `procedure.md` that uses it.

The four-organ shape is deliberately reserved even for thin kinds (vector, document, and model each run
one or two tools): the fixed slots give a contributor a known place to grow into, so the uniform
structure is a decision, not a default.

## Cookbook entries

Cookbook recipes follow the entry rubric defined once in [`cookbook.md`](cookbook.md): Task, For,
Command, Validate, Gains (marked measured or est, never fabricated), and Caveat, with an optional
See also. When you add a recipe, fill every required field; `cookbook.md` holds the format and a
worked example.

## Honesty (non-negotiable)

- A **Gains** number is measured or it is labeled `est`. Do not record an unmeasured number as fact;
  `expectations.md` holds only observed before/after bytes.
- If a command has not actually been run in this environment, it is unverified; say so rather than
  implying it was tested. The whole skill is `status: draft` until its recipes are run and measured.
- Keep the result only if it is smaller AND valid; a recipe that can grow a file or break a decode
  must say so in its Caveat.

## Voice

Terse and imperative. No marketing. Prose uses semicolons for independent clauses and the Oxford comma;
no em dashes.

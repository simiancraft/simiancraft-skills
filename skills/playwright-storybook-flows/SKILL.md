---
name: playwright-storybook-flows
description: >-
  Specialization of playwright-harness for AUTHORING and REPRODUCING user flows
  that live as Storybook docs pages. A flow is a narrated sequence of steps with
  observable gates, written into a conventional place in Storybook where a human
  reads it as a manual testing doc and an agent driving Playwright reads it as
  an executable rubric. Use when the task is "record a flow in Storybook",
  "author a user flow doc", "reproduce the flow in Docs/Testing/Flows", or
  "turn a manual test walkthrough into something an agent can re-drive". Read
  playwright-harness FIRST for script conventions and execution. Evidence lands
  on PRs via prove-work-on-github; captured images are shrunk with
  asset-optimization before they are committed or embedded.
---

# Storybook Flows: specialization of playwright-harness

**Read `playwright-harness` first.** The base owns prerequisites, the run pattern
(script in a per-task scratch dir with `playwright` resolvable), and the
drive/assert loop. This skill adds the Storybook-flow delta: what a flow document
is, where it lives in Storybook, how to author one while driving, and how a later
agent (or human) reproduces it from the page alone.

> **Status: scaffold.** Sections below are being authored and validated against a
> real Storybook before the patterns lock. Nothing in here is project-specific:
> the target Storybook is always parameterized (`STORYBOOK_URL`), and flow-doc
> locations are conventions, not paths into any one repo.

## What a flow is

A flow is a narrated sequence of steps that an agent driving Playwright can
reproduce later on its own, written down where humans also read it.

- **One artifact, two readers.** The same document is a manual testing
  walkthrough for a human and an executable rubric for an agent. If either
  reader needs a second document, the flow is miswritten.
- **Narration over code.** The flow describes intent and observable gates
  ("reset to a signed-out state, then confirm the landing screen renders"), not
  brittle selectors; the executing agent translates narration into
  playwright-harness driving at run time.

<!-- stub: the rubric shape (step = action + gate); tolerances; what makes a
     step reproducible vs. narrative-only. -->

## Where flows live in Storybook

<!-- stub: the conventional docs location (a Docs/Testing/Flows-style section);
     MDX docs pages auto-registered by glob; how the flow page is addressed
     (?path=/docs/...) and how the story iframe is addressed (iframe.html?id=)
     when the flow drives real stories. -->

## Authoring a flow (drive first, then write)

<!-- stub: the authoring loop: drive the sequence with playwright-harness,
     gate each step on something observed, then write the narration from the
     evidence; a step that was never driven does not get written down. -->

## Reproducing a flow

<!-- stub: the reading loop: an agent opens the flow page, translates each
     narrated step into driving, and gates on the same observables; divergence
     between the page and reality is a finding, not a silent patch. -->

## Evidence and dependencies (the seams)

This skill is published alongside the rest of simiancraft-skills because its
seams are contracts with sibling skills:

- **`playwright-harness`** (required): all execution; this skill never
  re-documents the run pattern.
- **`prove-work-on-github`**: when a flow run backs a claim on a PR or issue,
  its per-step evidence is rendered there under that skill's contract.
- **`asset-optimization`**: screenshots captured while flowing are shrunk
  before being committed or embedded anywhere durable.

<!-- stub: per-step artifact bundle (screenshot + page-error slice + step
     label); naming so a reader can replay the flow from the bundle alone. -->

## Scope

<!-- stub: CAN validate (story states, flow wiring, docs-page presence, console
     cleanliness); CANNOT validate (real device timing, native-only surfaces,
     anything the Storybook does not render). -->

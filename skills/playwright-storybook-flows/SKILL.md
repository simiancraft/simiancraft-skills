---
name: playwright-storybook-flows
description: >-
  Specialization of playwright-harness for AUTHORING and REPRODUCING flows. A
  flow is a sequence of steps a human or an agent can take inside an
  application to demonstrate a specific feature; it is written as a Storybook
  docs page in a conventional location, where a human reads it as a manual
  walkthrough (issue reproduction, QA) and an agent driving Playwright reads it
  as an executable rubric (integration testing). Use when the task is "record a
  flow", "author a flow doc", "write repro steps as a flow", "reproduce the
  flow in Storybook", or "turn a manual walkthrough into something an agent can
  re-drive". Read playwright-harness FIRST for all browser execution; this
  skill never re-documents Playwright.
---

# Storybook Flows: specialization of playwright-harness

**Read `playwright-harness` first.** This skill contains no Playwright
instruction and never will: all browser execution, screenshots, waits, and
assertions belong to `playwright-harness`. When a flow's evidence needs to land
on a PR, that is `prove-work-on-github`; when a captured image needs shrinking,
that is `asset-optimization`. This skill points to those seams and documents
exactly one thing: **how to record human/machine shared steps for running a
flow.**

> **Status: being authored.** Definitions below are locked; sections marked as
> stubs are still being dictated and validated. Nothing in here is
> project-specific: the target Storybook is always parameterized
> (`STORYBOOK_URL`), and flow locations are conventions, not paths into any one
> repo.

## What a flow is

A **flow** is a sequence of steps that a human or an agent can take inside an
application to demonstrate a specific feature.

The same document serves both readers. A human reads it as a walkthrough; an
agent reads it as an executable rubric and reproduces it later on its own. If
either reader would need a second document, the flow is miswritten.

Flows earn their keep in two situations:

- **Issue reproduction.** An issue arrives whose reproduction requires a series
  of steps; the flow illustrates and preserves those steps.
- **Integration testing.** A series of steps worth testing repeatedly is
  encapsulated as a flow, and an agent drives it.

## Self-containment (the transportability rule)

Flows do not reference other flows. Every flow is internally consistent,
internally self-contained, and therefore transportable.

During authorship it is fine for a flow to be *described* in terms of another
flow ("log in, then..."); the referenced steps are then **inlined** into the new
flow. If a detailed authentication flow exists and a new flow begins with "log
in", the authentication steps are copied into the new flow, not linked. Assume
the person or agent executing a flow has no knowledge of any other flow.

## The final state

Every flow ends in **success** or **failure**, and every flow must define its
final success state. Completing all steps in sequence, including the last one,
with no problems and no errors thrown, is success. Without a defined success
state neither an integration test nor a QA tester can know the flow completed;
with one, the flow is a pass/fail instrument.

## Steps

A flow consists of steps. A step is complete only when it has all of the
following properties:

1. **A number.** Steps are numbered and execute in sequence.
2. **A title.** Short and succinct: "Log in", "Click button".
3. **A description.** A short account of the action being taken.
4. **A visualization.** The most important property, described below.

## The visualization

A visualization is, ideally, an **inlined provision of the component that
matches what is taking place inside the flow on the actual page**: the real
component rendered in the flow document, not a description of it.

<!-- stub: why the inlined component is the ideal (being dictated); the
     fallback ladder when inlining is not possible (captured image via
     playwright-harness, shrunk via asset-optimization); how the visualization
     is addressed inside Storybook. -->

## Where flows live in Storybook

<!-- stub: the conventional docs location (a Docs/Testing/Flows-style section);
     MDX docs pages auto-registered by glob; how the flow page is addressed
     (?path=/docs/...) and how the story iframe is addressed (iframe.html?id=)
     when the flow drives real stories. -->

## Authoring a flow (drive first, then write)

<!-- stub: the authoring loop: drive the sequence per playwright-harness,
     gate each step on something observed, then write the steps from the
     evidence; a step that was never driven does not get written down. -->

## Reproducing a flow

<!-- stub: the reading loop: an agent opens the flow page, translates each
     step into playwright-harness driving, and gates on the same observables;
     divergence between the page and reality is a finding, not a silent patch. -->

## Scope

<!-- stub: CAN validate (flow completion, step gates, docs-page presence,
     console cleanliness); CANNOT validate (real device timing, native-only
     surfaces, anything the Storybook does not render). -->

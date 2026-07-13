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

> **Status: being authored.** Definitions, step properties, the visualization
> spec, and the storage convention are locked; the authoring and reproduction
> loops are still being dictated and validated. Nothing in here is
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

The single exception is a **precondition** (below): required starting state may
name another flow; steps never do.

## Preconditions (required starting state)

A flow may require a certain state to have already taken place before step 1,
in the manner of a Cucumber scenario outline: "if you are already logged in,
then perform the flow."

**In this context only, a flow may reference another flow** as the way to reach
the required state. The precondition names the state and the flow that
establishes it; it is not a step, and it is not inlined. Steps inside the flow
body still never reference other flows.

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

A visualization is, ideally, an **actual inline component**: the real component
rendered in the flow document, not a description of it. Flows are MDX files in
Storybook, so inlining the real thing is cheap; do it.

How a narrated step becomes a complete one. The narrator says "go click the
login button", and that is everything a step needs:

1. **Title:** "Click login".
2. **Description:** where the login button is located on the page.
3. **Visualization:** literally inline the component, based on the actual code
   cross-referenced with the component itself. Look the button up in Storybook,
   look at its source code, and put that button (and, where it helps, its
   surrounding context) inline as the visualization.

The visualization carries the **same accessibility tags an agent would see when
actually driving the page**. That is the point of it: a human sees a button
that looks exactly like the button on the page; an agent sees the accessibility
hint that locates it quickly. Flows are therefore highly accessible by default;
a visualization without the real accessibility surface is incomplete.

**Fallback.** When a component cannot be inlined, take a screenshot of the
region of the page the step describes and inject that screenshot into the MDX
file. Capture per `playwright-harness`; shrink per `asset-optimization` before
it is committed.

## Where flows live

Inside the project, prefer a `/docs` folder, unless the author has overridden
their default root-level Storybook documentation folder; in that case, use
theirs. Inside it:

- a `/flows` folder (author it if it does not exist);
- **every flow gets its own folder**, named after the user story it depicts;
- the flow's point of entry is its **`index.mdx`**;
- artifacts live beside `index.mdx` in the flow's folder: images, gifs, and
  special components (for example, a component depicting two components side
  by side that would not normally be side by side).

```
docs/
└── flows/
    └── <user-story-name>/
        ├── index.mdx          <- the flow; root point of entry
        └── <artifacts>        <- images, gifs, special components
```

In the Storybook sidebar, the flow's `Meta` registers under a root-level
`Flows` folder, then the name of the flow.

## Authoring a flow (the interactive loop)

Authoring is an interactive process: a human dictates, and every discrete
instruction becomes a step inside the flow.

1. The developer says "do this."
2. You do it (drive it per `playwright-harness`).
3. You write down what you did, as a step with all four properties (number,
   title, description, visualization).
4. Repeat until the developer tells you that reaching this point is success.

That declaration is the flow's **success criteria**; encode it as the flow's
final success state. A step that was never driven does not get written down,
and nothing gets written down that was not dictated.

**Flows are direct.** Branching conditions are not supported. If a dictated
sequence wants to branch, that is two flows.

## Reproducing a flow (run by name)

The second mode: someone tells the agent to test a feature by running a flow
on its own, and they **name the flow**. The agent:

1. finds the named flow in the flows folder (its own folder under `/flows`,
   entered at `index.mdx`);
2. executes the steps in order, translating each step's description and
   visualization (including its accessibility hints) into `playwright-harness`
   driving;
3. gates on the flow's final success state: all steps completed in sequence,
   including the last, with no problems and no errors thrown, is success;
   anything else is failure.

Divergence between the flow page and reality is a finding to report, not
something to silently patch around.

Both modes are required. An agent using this skill must be able to author
interactively and to reproduce by name.

## Scope

<!-- stub: CAN validate (flow completion, step gates, docs-page presence,
     console cleanliness); CANNOT validate (real device timing, native-only
     surfaces, anything the Storybook does not render). -->

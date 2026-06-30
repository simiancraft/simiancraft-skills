---
name: physical
description: >-
  The Physical aspect: the change's measurable shape (surface area, complexity,
  reversibility) that sizes how much proof is owed.
role: rubric-aspect
aspect: 1
---

# Physical

The first aspect. You do not size proof by taste; you derive it from the change's shape. Three
measures, mostly objective, set how much proof a change owes.

## Surface area (extent, blast radius)

How much ground the change covers: width (files and modules touched), depth (layers or stack
levels), and reach (how far it radiates through dependents, the afferent fan-in).

## Complexity (interwovenness)

How tangled the change is, distinct from how much it spans: internal complexity (cyclomatic,
Halstead, SLOC, nesting) and coupling (efferent dependencies, temporal and packaging coupling).

## Reversibility

What it costs to undo: rollback path, idempotency, and whether it destroys data or touches
persistent or external state.

## Sizing and tooling

Surface area and complexity are objective where the tooling exists (cyclomatic, Halstead, SLOC,
maintainability index, coupling); reversibility is judgment plus signals. Treat every metric as
graceful enrichment: use it when present, fall back to judgment when absent, and say which mode
produced each number.

> TODO: the per-measure scoring, the bar each sets for evidence, and worked examples.

## Consumes / produces

- Produces: the size of the change, which sets the bar Judgement (`judgement.md`) checks the
  evidence against.

---
name: correctness
description: >-
  The Correctness aspect: is the change sound. Alignment (serves the point),
  verifiability (mechanical correctness), durability (ages well), and security (no
  footguns), sorted by how objectively each can be measured.
role: rubric-aspect
aspect: 2
---

# Correctness

The second aspect. Is the change sound, in four sub-items arranged along a verifiability gradient:
push what you can to tools, and isolate the irreducible judgment to alignment. Scoped to the
change, not the repo.

## Alignment (judgment)

Does the change serve its point. Intent fit (serves the linked issues, how many it resolves,
matches business signals), decision fit (consistent with ADRs, architecture, and conventions, no
contradiction), and self-consistency (the code does what the PR says, the PR does what the issue
says). Needs an intent source, or it is a blind spot. Failure mode: the well-built wrong thing.

## Verifiability (tool-objective)

Mechanical correctness: coverage of the changed lines, test meaningfulness (mutation score, not
just percent), fuzz and property tests, and determinism.

## Durability (mixed)

Will it age well: architectural fit (SOLID, open/closed, matches existing patterns), complexity
and coupling delta, and churn-proneness. Metric deltas are objective; pattern fit is judgment.

## Security (tool-objective)

Any footguns: dependency CVEs, SAST findings, secret handling, authz and injection, and
attack-surface delta.

> TODO: the concrete measurement method and tool per sub-item, the
> graceful-degradation fallback when tooling is absent, and worked examples.

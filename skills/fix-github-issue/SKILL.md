---
name: fix-github-issue
description: >-
  Turn one known GitHub issue into a merged pull request, headless: a worker in its own git
  worktree, a draft pull request with proof, an isolated second-engine reviewer, and a serial
  pull master that checks staleness against the base before it merges. Use when the task is
  "fix issue N unattended", "run the fix pipeline on this issue", or when another loop needs a
  fix seat it can call. Requires a per-repository config at the target repo's root, the
  prove-work-on-github skill, and the codex and claude CLIs for the default seats.
---

# Fix GitHub Issue

One issue in, one terminal outcome out: `merged`, `parked`, `handed-off`, `closed`, `dlq`, or
`failed`. Internally it is a worker, then a review, then a landing, revising up to the review
budget. Every stage takes an explicit context rather than reading module state, so one process can
run two pipelines against two configurations without either seeing the other's.

The pipeline is shared; the repository is config. Nothing in this skill is copied into a
repository. Everything true of a repository (remotes, branches, commands, path aliases,
invalidation paths) lives in a config file at that repository's root, and the pipeline refuses to
start without one.

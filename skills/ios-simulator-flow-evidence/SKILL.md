---
name: ios-simulator-flow-evidence
description: >-
  Capture proof of a driven iOS-simulator flow: vision-verifiable screenshots,
  video (mp4), and a manifest tying steps to artifacts, plus an honest list of what
  a simulator cannot do (deliver a push, use a real camera, place a call, fully
  observe the network). Produces artifacts to a contract that a separate
  GitHub-presentation skill consumes; this skill owns extraction, not publishing.
  Sits beside ios-simulator; project-agnostic. Use for "capture evidence of an iOS
  flow" or "record the simulator".
status: scaffold
sources: []
---

# iOS Simulator Flow Evidence (extraction, not publishing)

Owns getting artifacts OUT of the simulator. A separate github-proof-presentation
skill (external) consumes them; the seam is references/artifact-contract.md.


## Scope
TODO

## Out of scope
Publishing/presenting artifacts -> external github-proof-presentation.

## Honest can't-do list (simulator limits)
TODO: no push delivery, no real camera, no phone calls, limited network observation.


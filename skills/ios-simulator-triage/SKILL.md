---
name: ios-simulator-triage
description: >-
  Diagnose and recover from failures when building, running, or driving an app on
  the iOS Simulator. A living catalog organized by layer: build failures
  (xcodebuild, CocoaPods, signing, codegen), runtime failures split into
  app-runtime vs Expo-runtime (the red screen of death), and automation failures
  that emit no error (element not found in the accessibility tree, stuck flow).
  Each layer names where its logs live. Used alongside ios-simulator and
  expo-ios-simulator when something breaks. Project-agnostic.
status: scaffold
sources: []
---

# iOS Simulator Triage (living failure catalog)

Classify first (which layer failed), then recover. Grows as we meet new failures;
each entry cites the primary source that explains the error and fix.


## Scope
TODO

## Out of scope
Happy-path driving -> ios-simulator / expo-ios-simulator.


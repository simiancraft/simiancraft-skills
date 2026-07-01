---
name: ios-simulator-triage
description: >-
  Diagnose and recover from failures when building, running, or driving an app on
  the iOS Simulator. A living catalog organized by layer: build failures
  (xcodebuild, CocoaPods, signing, codegen), runtime failures split into
  app-runtime vs Expo-runtime (the red error overlay), and automation failures
  that emit no error (element not found in the accessibility tree, stuck flow).
  Each layer names where its logs live. Used alongside ios-simulator and
  expo-ios-simulator when something breaks. Project-agnostic.
status: draft
sources:
  - "xcrun simctl help (launch --console/--stdout/--stderr, spawn, diagnose, get_app_container) and axe --help; each reference carries the per-command provenance"
  - https://developer.apple.com/documentation/os/logging
---

# iOS Simulator Triage (living failure catalog)

Classify first (which layer failed), then recover. Most fixes live in the sibling skills;
this skill routes you to them and supplies the logging tools that turn a symptom into a cause.

## Route by symptom

- **It never installs or launches** (xcodebuild, CocoaPods, or prebuild failed): a **build
  failure** -> `references/build-failures.md`.
- **It launches, then crashes or misbehaves**: a **runtime failure** ->
  `references/runtime-failures.md`, split into app-native and Expo / React-Native because
  the logs and the fixes differ.
- **It runs, but AXe cannot find or tap the element**: an **automation failure** ->
  `references/automation-failures.md`.

## Read the logs first

Every layer has a log that names the cause; guessing without it wastes a cycle.
`references/logging.md` is the cross-cutting tool, indexed by layer: the unified log
(`simctl spawn booted log stream`), the app's stdout and stderr (`simctl launch --console`),
crash reports, the diagnostic bundle (`simctl diagnose`), and the Metro terminal for the JS
layer.

## Rules

- Identify the layer before changing anything; a build fix will not cure a runtime crash.
- Pull the log before forming a hypothesis; the unified log or the crash report usually names
  the cause outright.
- Every factual claim here and in the references cites a primary source (the tools' own help,
  Apple); a prior-art skill is never a source.

## Out of scope

Happy-path driving -> **ios-simulator** and **expo-ios-simulator**. What makes an app
addressable -> **mobile-accessibility**.

## Where to go

- `references/build-failures.md`: code signing, CocoaPods, prebuild, and architecture.
- `references/runtime-failures.md`: native crashes and the Expo / RN failure modes.
- `references/automation-failures.md`: empty `describe-ui`, missed taps, and blocking overlays.
- `references/logging.md`: the unified log, console output, crash reports, and diagnose.

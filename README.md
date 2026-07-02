# simiancraft-skills

> Curated Claude Code skills and agents. Only what we run in production.

Opinionated Claude Code skills and agents from [simiancraft](https://github.com/simiancraft). Quality-bar-only.

## What you get

A planning methodology that produces something like this, cold-handoff-ready and disposable by design:

````markdown
# Split monolithic resource-actions hook into per-action files

**Status:** Draft
**Scope:** subsystem
**Date:** 2026-04-15
**Last reviewed:** 2026-04-15
**Context:** A single 870-line hook serves five mutations; one mutation's logic
has broken another's twice in the last quarter.

## Goal

Replace the monolith with a per-action structure where each mutation owns its
own home, composed by a thin dispatcher that preserves today's consumer-facing
shape. Done = no monolith remains; consumer call sites are byte-identical to
today; existing test bodies pass without modification.

## File structure: after

**Legend:** 🆕 new · ✏️ rewritten

```
features/resources/
├── ✏️ use-resource-actions.ts                  // dispatcher only, ~60 lines
└── 🆕 actions/
    ├── 🆕 create.ts        // extracted from use-resource-actions.ts
    ├── 🆕 rename.ts        // extracted from use-resource-actions.ts
    └── 🆕 ...
```

## Commits

### Commit 1: Scaffold actions/ folder
**Files created:** `features/resources/actions/{create,rename,...}.ts`
**Gate:** Project full validation passes.

### …

### Commit N+1: Delete this plan
- Delete `features/resources/split-resource-actions-hook.md`.
**Gate:** Project validation passes. Repo contains no references to the plan file.
````

The plan file gets deleted as the last commit of the work it described. Two-key handshake before deletion. 150-word Goal cap. Atomic commits with verification gates.

## Install

```sh
/plugin marketplace add simiancraft/simiancraft-skills
/plugin install simiancraft-skills@simiancraft-skills
```

Update later:

```sh
/plugin marketplace update simiancraft-skills
```

## What's in here

### Skills

- **[`how-to-plan`](skills/how-to-plan/SKILL.md)**: methodology for tactical, hand-off-ready planning docs. Goal-as-north-star, atomic commit steps with verification gates, before/after file trees with a 10-symbol legend, and the Inspector Gadget Rule.
- **[`zone-composer`](skills/zone-composer/SKILL.md)**: React composition pattern for domain features (screens, panels, tools, editors). A chassis owns data and state branching via flat early returns; presentational leaves take named zones instead of flag props; mutations live in `actions/`; layouts are polymorphic. Lean core plus six task references (key patterns, polymorphic layouts, FSM wizards, refactoring, GraphQL fragments, code style).
- **[`android-emulator-harness`](skills/android-emulator-harness/SKILL.md)**: bring up an Android app in a headless emulator on Linux/WSL and drive it for automated integration testing, the Android analog of Playwright for web. Boots an AVD under KVM, installs an APK, drives the UI with Maestro, and gates on logcat plus screenshots.
- **[`android-emulator-mask-testing`](skills/android-emulator-mask-testing/SKILL.md)**: specialization of the harness for camera and segmentation testing. Puts a real person in front of the emulator camera so MediaPipe / ML Kit selfie segmentation produces a mask, then verifies background-replacement, blur, and shader effects. Ships a pre-framed subject fixture.
- **[`ios-simulator`](skills/ios-simulator/SKILL.md)**: drive an iOS Simulator headlessly on macOS, the iOS analog of the emulator and Playwright harnesses. Discovers and boots a device, installs and launches an app, drives the UI by accessibility (AXe) rather than brittle coordinates, captures screenshots and video, and covers the simulator's own chrome, device state, and execution modes.
- **[`expo-ios-simulator`](skills/expo-ios-simulator/SKILL.md)**: run and drive an Expo / React Native app on the iOS Simulator; sits on top of `ios-simulator`. Picks an execution mode (Expo Go, dev client, Storybook-mobile, web-on-mobile), builds and installs a dev client, and clears the recurring Expo prompts that block automation: the push-token alert stack, the deep-link dialog, the dev menu, and the element-inspector trap.
- **[`ios-simulator-flow-evidence`](skills/ios-simulator-flow-evidence/SKILL.md)**: capture proof of a driven iOS-simulator flow: vision-verifiable screenshots, video, and a manifest tying steps to artifacts, plus an honest list of what a simulator cannot do. Owns extraction, not publishing.
- **[`ios-simulator-triage`](skills/ios-simulator-triage/SKILL.md)**: diagnose and recover from failures when building, running, or driving an app on the iOS Simulator. A living catalog organized by layer (build, app-runtime vs Expo-runtime, and automation failures that emit no error), where each layer names where its logs live.
- **[`mobile-accessibility`](skills/mobile-accessibility/SKILL.md)**: make a mobile app driveable and auditable through the accessibility tree, the shared dependency behind every tap-by-label interaction. One tree, two consumers: driving reads the stable handle (`testID`); auditing reads the user-facing semantics (label, role, state, focus order). Covers iOS-native and React Native / Expo.
- **[`expo-developer-tools`](skills/expo-developer-tools/SKILL.md)**: read and use the Expo / React Native in-app developer tools: the developer menu, React Native DevTools, and Rozenite plugins. The tools are identical on iOS and Android, so this is the shared home the platform skills point to; an interpretive reference for reading the tools, not a driver.
- **[`playwright-harness`](skills/playwright-harness/SKILL.md)**: the operational trunk for browser work, the web analog of the emulator harness. Writes a script, launches Chromium (real GPU under WSLg via ANGLE when WebGL matters), drives the page, and gates on screenshots plus collected page errors. Two references carry the depth: `interactions.md` (locators, actions, waits, assertions) and `flows.md` (login and session reuse, forms, responsive sweeps, link-checking, network stubbing). Specializations layer on top.
- **[`playwright-camera-mask-testing`](skills/playwright-camera-mask-testing/SKILL.md)**: specialization of the harness for camera and segmentation testing in the browser. Feeds a real person through getUserMedia so MediaPipe selfie segmentation produces a mask, then verifies background-replacement, blur, and shader effects by vision. Ships a webcam-shaped subject fixture and an empty-scene negative case.
- **[`playwright-gif-capture`](skills/playwright-gif-capture/SKILL.md)**: specialization of the harness for capturing an animated GIF of a page, canvas, or WebGL animation. Drives the clock deterministically, grabs frames, and encodes a looping GIF, with a reference on the color, frame-rate, and size tradeoffs so the output is not deep-fried, janky, or oversized.

### Agents

- **[`android-emulator-tester`](agents/android-emulator-tester.md)**: automated Android UI/integration testing specialist; drives a real app on a headless emulator and gates on what it observes. Owns the boot, install, drive, and assert loop, and is honest about what an emulator cannot validate (real FPS, true camera/mic fidelity, network quality).
- **[`android-kotlin-expert`](agents/android-kotlin-expert.md)**: Android native specialist for Kotlin, Java, Gradle, the Jetpack libraries, OpenGL ES and camera pipelines, and React Native / Expo Modules native bridging. Two modes: implement or review.
- **[`review-software-architect`](agents/review-software-architect.md)**: senior architect review lens for any codebase. Judges a project against its own organizing principle first and the canon (SOLID, DDD, layering, paradigm coherence, convention vs configuration) second, and grades on request with calibrated letter grades.

## Curation policy

Deliberately small, slow-growing. Every skill is one we use in production and are willing to put the simiancraft name on; nothing makes it in for completeness or volume. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contribution posture.

## License

MIT. See [`LICENSE`](LICENSE).

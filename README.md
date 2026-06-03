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

### Agents

- **[`android-emulator-tester`](agents/android-emulator-tester.md)**: automated Android UI/integration testing specialist; drives a real app on a headless emulator and gates on what it observes. Owns the boot, install, drive, and assert loop, and is honest about what an emulator cannot validate (real FPS, true camera/mic fidelity, network quality).
- **[`android-kotlin-expert`](agents/android-kotlin-expert.md)**: Android native specialist for Kotlin, Java, Gradle, the Jetpack libraries, OpenGL ES and camera pipelines, and React Native / Expo Modules native bridging. Two modes: implement or review.

## Curation policy

Deliberately small, slow-growing. Every skill is one we use in production and are willing to put the simiancraft name on; nothing makes it in for completeness or volume. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contribution posture.

## License

MIT. See [`LICENSE`](LICENSE).

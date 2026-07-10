# simiancraft-skills

> The full arc of a change, farm to table, with receipts.

Curated Claude Code skills and agents from [simiancraft](https://github.com/simiancraft). Together they carry a change through its whole life: plan it, structure it, run it and watch it behave, and prove it on the pull request. No stage advances on narrative. Every gate is something you observed: a screenshot that came back from the emulator, a logcat line, a byte count that got smaller, a plan file that deleted itself when the work shipped.

## Install

```sh
/plugin marketplace add simiancraft/simiancraft-skills
/plugin install simiancraft-skills@simiancraft-skills
```

Update later:

```sh
/plugin marketplace update simiancraft-skills
```

## The arc

Most skill collections are grab bags. This one has a spine. Each stage of a change has a home here, and each stage ends in an observable gate:

| Stage | Gate | Where it lives |
|-------|------|----------------|
| **Plan** | every commit step carries a verification gate; the plan self-destructs when shipped | [`how-to-plan`](skills/how-to-plan/SKILL.md) |
| **Structure** | domain nouns named before file structure; flag-prop relay refused | [`zone-composer`](skills/zone-composer/SKILL.md) |
| **Drive and observe** | screenshots, logcat, and page errors that came back for inspection | the web, Android, and iOS harness families |
| **Extract evidence** | artifacts conforming to a stable contract: stable names, known formats, a manifest | [`ios-simulator-flow-evidence`](skills/ios-simulator-flow-evidence/SKILL.md), [`playwright-gif-capture`](skills/playwright-gif-capture/SKILL.md) |
| **Shrink it** | kept only if smaller AND still valid; never regress | [`asset-optimization`](skills/asset-optimization/SKILL.md) |
| **Prove it** | a claim is narrative; a receipt is proof | `prove-work-on-github`, incoming in [#9](https://github.com/simiancraft/simiancraft-skills/pull/9) |

The seams are contracts, not vibes. The evidence skills emit artifacts to a documented contract that the proof skill consumes; the GIF capture skill ends at embedding in a PR; the proof skill defers artifact shrinking back to `asset-optimization`. Farm to table.

## What's in here

### Plan

- **[`how-to-plan`](skills/how-to-plan/SKILL.md)**: methodology for tactical, hand-off-ready planning docs. Goal-as-north-star with a 150-word cap, atomic commit steps with verification gates, before/after file trees, and the Inspector Gadget Rule: plans self-destruct when shipped, behind a two-key handshake.

### Structure

- **[`zone-composer`](skills/zone-composer/SKILL.md)**: React composition pattern for domain features (screens, panels, tools, editors, wizards). A chassis owns data and state branching via flat early returns; presentational leaves take named zones instead of flag props; mutations live in `actions/`; layouts are polymorphic. Lean core plus six task references.

### Drive and observe

Three harness trunks, one mental model: boot the runtime, drive the UI by stable handles rather than brittle coordinates, and gate on what comes back. Each trunk declares a specialization contract; a sibling skill reads the trunk first and adds only its delta.

**Web**

- **[`playwright-harness`](skills/playwright-harness/SKILL.md)**: the operational trunk for browser work. Writes a script, launches Chromium (real GPU under WSLg via ANGLE when WebGL matters), drives the page, and gates on screenshots plus collected page errors. Two references carry the depth: interactions (locators, actions, waits, assertions) and flows (login and session reuse, forms, responsive sweeps, link checking, network stubbing).
- **[`playwright-camera-mask-testing`](skills/playwright-camera-mask-testing/SKILL.md)**: puts a real person in front of getUserMedia so MediaPipe selfie segmentation produces an actual mask, then verifies background replacement, blur, and shader effects by vision. Ships a webcam-shaped subject fixture and an empty-scene negative case.
- **[`playwright-gif-capture`](skills/playwright-gif-capture/SKILL.md)**: drives a page, canvas, or WebGL animation deterministically, grabs frames, and encodes a looping GIF, with a reference on the color, frame-rate, and size dials so the output is not deep-fried, janky, or oversized.

**Android**

- **[`android-emulator-harness`](skills/android-emulator-harness/SKILL.md)**: the Android analog of Playwright for web. Boots an AVD headless under KVM on Linux/WSL, installs an APK, drives the UI with Maestro, and gates on logcat plus screenshots that come back for inspection.
- **[`android-emulator-mask-testing`](skills/android-emulator-mask-testing/SKILL.md)**: gets a real person in front of the emulator camera so MediaPipe / ML Kit selfie segmentation produces an actual mask, then verifies background replacement, blur, and shader effects. Ships a pre-framed subject fixture.

**iOS**

- **[`ios-simulator`](skills/ios-simulator/SKILL.md)**: the iOS analog of the other two trunks. Discovers and boots a device, installs and launches an app, drives the UI by accessibility (AXe), captures screenshots and video, and covers the simulator's own chrome, device state, and execution modes.
- **[`expo-ios-simulator`](skills/expo-ios-simulator/SKILL.md)**: runs an Expo / React Native app on the simulator; sits on top of `ios-simulator`. Picks an execution mode (Expo Go, dev client, Storybook-mobile, web-on-mobile), builds and installs a dev client, and clears the recurring Expo prompts that block automation.
- **[`ios-simulator-triage`](skills/ios-simulator-triage/SKILL.md)**: a living failure catalog organized by layer: build failures, app-runtime vs Expo-runtime failures, and automation failures that emit no error. Each layer names where its logs live.
- **[`ios-simulator-flow-evidence`](skills/ios-simulator-flow-evidence/SKILL.md)**: captures proof of a driven flow: vision-verifiable screenshots, video, and a manifest tying steps to artifacts, plus an honest list of what a simulator cannot do. Owns extraction, not publishing.

**Shared trunks**

- **[`mobile-accessibility`](skills/mobile-accessibility/SKILL.md)**: makes a mobile app driveable and auditable through the accessibility tree, the shared dependency behind every tap-by-label interaction. One tree, two consumers: driving reads the stable handle, auditing reads the user-facing semantics.
- **[`expo-developer-tools`](skills/expo-developer-tools/SKILL.md)**: reading the Expo / React Native in-app developer tools: the developer menu, React Native DevTools, and Rozenite plugins. The shared home both platform families point to; an interpretive reference, not a driver.

### Shrink

- **[`asset-optimization`](skills/asset-optimization/SKILL.md)**: shrinks a media asset to the smallest bytes that still serve its purpose, keyed on asset kind (raster, vector, animation, video, audio, model, document, font) and on where it will be presented. Measures before and after, validates the output, and keeps the result only if it is smaller AND still valid; redirects to a better format when the source is wrong for the job.

### Agents

- **[`android-emulator-tester`](agents/android-emulator-tester.md)**: automated Android UI/integration testing specialist; drives a real app on a headless emulator and gates on what it observes. Owns the boot, install, drive, and assert loop.
- **[`android-kotlin-expert`](agents/android-kotlin-expert.md)**: Android native specialist for Kotlin, Java, Gradle, the Jetpack libraries, OpenGL ES and camera pipelines, and React Native / Expo Modules native bridging. Two modes: implement or review.
- **[`review-software-architect`](agents/review-software-architect.md)**: senior architect review lens for any codebase. Judges a project against its own organizing principle first and the canon (SOLID, DDD, layering, paradigm coherence) second, and grades on request with calibrated letter grades.

## Every skill names its ceiling

An emulator cannot validate real FPS or true camera fidelity, and the Android harness says so. A simulator cannot deliver a push or place a call, and the evidence skill lists that plainly. The proof skill states outright that proof is asymptotic and a total account of it would be a lie. Skills that overclaim get you confidently wrong answers; these are written to keep the model calibrated instead. Commands carry provenance to upstream docs, and each harness names the exact stack it was validated on.

## Curation policy

Deliberately small, slow-growing. Every skill is one we run in production and are willing to put the simiancraft name on; nothing makes it in for completeness or volume. Gotchas in these files cost real debugging time; that is the bar for writing one down. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contribution posture.

## License

MIT. See [`LICENSE`](LICENSE).

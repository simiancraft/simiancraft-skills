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
status: complete
sources:
  - "axe --help (screenshot, record-video) and xcrun simctl io help (screenshot, recordVideo); each reference file carries the per-command provenance"
  - https://developer.apple.com/documentation/xcode/capturing-screenshots-and-videos-from-simulator
---

# iOS Simulator Flow Evidence (extraction, not publishing)

Owns getting artifacts OUT of the simulator. A separate **github-proof-presentation**
skill (external) consumes them; the seam is `references/artifact-contract.md`. This skill
produces the bundle; it does not publish it.

## The three artifact kinds

A driven flow (see **ios-simulator** `references/driving.md`) leaves three kinds of proof:

1. **A sequence of screenshots** (`references/screenshots.md`): one PNG per meaningful step,
   each vision-verified to show the state it claims. The default, most reviewable evidence.
2. **A video** (`references/video.md`): the whole flow as one MP4 or MOV. An animated GIF is
   **not** a native output; it is a post-process that needs a separate tool (see that file).
3. **A manifest** (`references/flow-manifest.md`): a machine-readable index tying each step to
   its artifact and the state it proves, so a reviewer (or the presentation skill) can read
   the bundle without re-running the flow.

All capture comes from the **device framebuffer**, so the Simulator window's size and position
never matter (see **ios-simulator** `references/capture.md`); never resize or full-screen it.

## The contract

Everything this skill emits conforms to `references/artifact-contract.md`: stable names,
known formats (PNG, MP4 or MOV), and the manifest shape. The external presentation skill
relies on that contract; do not break it without updating the presentation side.

## Honest can't-do list (simulator limits)

Evidence from a simulator proves **UI, navigation, wiring, and state**, not device fidelity.
A simulator cannot:

- **vend a native APNs device token** (`getDevicePushTokenAsync`), so real remote-push
  registration is a device pass; a simulator can still display a payload via `xcrun simctl push`
  and receive a remote push on Xcode 14+ (see **expo-ios-simulator**
  `references/known-prompts.md` for the push-token alert this raises);
- **produce real camera or microphone frames** (no physical sensors);
- **place a phone call or send a carrier SMS**;
- **fully reproduce on-device network conditions** (no cellular radio; bandwidth and
  latency are the host's, not a real handset's).

If a flow's proof depends on any of these, list it under the manifest's `deviceOnly`
(see `references/flow-manifest.md`); it is a **device pass**, not something the simulator
evidence covers.

## Where to go

- `references/screenshots.md`: the per-step PNG sequence and vision-verification.
- `references/video.md`: recording MP4 / MOV, and the GIF post-process and its dependency.
- `references/artifact-contract.md`: the bundle shape the external skill consumes.
- `references/flow-manifest.md`: the step-to-artifact manifest.

## Out of scope

Publishing or presenting artifacts -> external **github-proof-presentation**. Driving the
flow itself -> **ios-simulator** and **expo-ios-simulator**.

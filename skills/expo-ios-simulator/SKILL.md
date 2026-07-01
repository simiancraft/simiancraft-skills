---
name: expo-ios-simulator
description: >-
  Run and drive an Expo / React Native app on the iOS Simulator. Pick an execution
  mode (Expo Go, dev client, Storybook-mobile, web-on-mobile), build and install a
  dev client, and clear the recurring Expo/RN prompts that block automation: the
  push-token alert that stacks until the overlay darkens the screen, the
  "Open in app?" deep-link dialog, the dev menu, and the element-inspector trap.
  Sits ON TOP of ios-simulator; failures route to ios-simulator-triage.
  Project-agnostic; discovers bundle id and scheme from the app config. Use for
  "run my Expo app on the simulator", "load a dev client", or "drive Storybook on iOS".
status: complete
sources:
  - https://docs.expo.dev/develop/development-builds/introduction/ (Expo Go vs development builds; the fixed native set)
  - "the reference files below carry the per-command provenance (Expo docs, Apple, AXe --help)"
---

# Expo on the iOS Simulator (layer on top of ios-simulator)

Everything here is Expo / React-Native **runtime** behavior, not the simulator itself
(that is **ios-simulator**, which boots devices, captures screenshots, and grants
permissions). This skill gets an Expo app *running* on a booted simulator and clears the
Expo-specific overlays that stall automation. For "make the app driveable" see
**mobile-accessibility**.

## Before anything

A booted simulator and AXe installed; that is **ios-simulator** `prerequisites.md`. This
skill discovers everything app-specific (bundle id, scheme) from the app config; it never
hardcodes a project's nouns.

## The loop

1. **Pick an execution mode** (`references/execution-modes.md`): Expo Go, a development
   build (dev client), Storybook-mobile, or web-on-mobile. The choice is forced by whether
   the app has custom native code.
2. **Get the app on the device.** Pure-JS app: Expo Go installs and launches it for you
   (`references/expo-go.md`). Anything with native modules or a config plugin: build and
   install a dev client (`references/development-builds.md`), then serve Metro and connect
   by deep link.
3. **Clear the recurring prompts** (`references/known-prompts.md`): the "Open in app?"
   deep-link dialog, the push-token alert that re-fires and stacks on each reload, and the
   dev menu; avoid the element-inspector trap. Clear each by accessibility, never coordinates.
4. **Drive it.** The driving primitive is **ios-simulator** `references/driving.md`
   (`axe tap --id` / `--label`); what makes the app addressable is **mobile-accessibility**.

## Rules

- Discover bundle id and scheme from the app config; never hardcode them.
- **Never drive a bundling app.** Two readiness gates sit between "launched" and "driveable":
  Metro serving (`curl /status`) and the first bundle finishing (the tree grows labels); both
  recipes are in `references/development-builds.md`. Taps dispatched before them report
  success and do nothing.
- Clear every Expo dialog and overlay by accessibility (`axe tap --label`), not coordinates.
- Every factual claim here and in the references cites a primary source (Expo, Apple, AXe's
  own help); a prior-art skill is never a source.

## Out of scope

- The simulator itself, its chrome, capture, and permissions: **ios-simulator**.
- What makes an app addressable (accessibility props): **mobile-accessibility**.
- The dev menu's items and React Native DevTools (shared with Android): **expo-developer-tools**.
- Build, runtime, and automation failures: **ios-simulator-triage**.

## References

- `references/execution-modes.md`: the four ways to run an Expo app and when to use each.
- `references/expo-go.md`: the Expo Go path and its fixed-native-set limit.
- `references/development-builds.md`: building and connecting a dev client.
- `references/known-prompts.md`: the recurring dialogs, the dev menu, and the inspector trap.


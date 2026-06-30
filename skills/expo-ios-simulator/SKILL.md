---
name: expo-ios-simulator
description: >-
  Run and drive an Expo / React Native app on the iOS Simulator. Pick an execution
  mode (Expo Go, dev client, Storybook-mobile, web-on-mobile), build and install a
  dev client, and clear the recurring Expo/RN prompts that block automation: the
  push-token alert that stacks until the overlay blacks the screen, the
  "Open in app?" deep-link dialog, the dev menu, and the element-inspector trap.
  Sits ON TOP of ios-simulator; failures route to ios-simulator-triage.
  Project-agnostic; discovers bundle id and scheme from the app config. Use for
  "run my Expo app on the simulator", "load a dev client", or "drive Storybook on iOS".
status: scaffold
sources: []
---

# Expo on the iOS Simulator (layer on top of ios-simulator)

Everything here is Expo/React-Native runtime behavior, not the simulator itself
(that is ios-simulator). For "make the app driveable" see mobile-accessibility.


## Scope
TODO

## Out of scope
The simulator itself -> ios-simulator. A11y -> mobile-accessibility.
Build/runtime failures -> ios-simulator-triage.


---
name: expo-developer-tools
description: >-
  Read and use the Expo / React Native in-app developer tools: the developer menu
  (reload, go home, performance monitor, element inspector, Open DevTools, and fast
  refresh) and React Native DevTools (Console, Sources, Network, Memory, Performance,
  Components, and Profiler), plus Rozenite plugins. The tools are identical on iOS and
  Android; only the gesture that opens the menu differs, so this skill is the shared
  home referenced by both the iOS-simulator and Android-emulator skills. This is the
  reference for reading these tools (what each shows and how to interpret it), not a driver.
  Use for "open the Expo dev menu", "read the performance monitor", "use the element
  inspector", or "inspect a component / a slow re-render with React Native DevTools".
status: draft
sources:
  - https://docs.expo.dev/debugging/tools/ (the developer menu and the tools it opens)
  - https://reactnative.dev/docs/react-native-devtools (the React Native DevTools panels)
  - https://www.rozenite.dev/ (Rozenite, the React Native DevTools plugin framework)
---

# Expo Developer Tools (shared iOS + Android)

The in-app developer tooling of an Expo / React Native app: the **developer menu** and the
**React Native DevTools** it opens. This surface is a React Native feature, so it is the **same
on iOS and Android**; the only platform-divergent part is the gesture that opens the menu. That
is why this is a shared skill: **ios-simulator** / **expo-ios-simulator** and
**android-emulator-harness** each say how to open the menu on their platform, then point here for
what the items and panels mean.

This skill is the **interpretive field guide**: what each tool shows and how an agent reads it. It
is not a driver; driving the app lives in the platform simulator/emulator skills.

## Layout (in the order you meet the tools)

1. `references/opening.md`: the open-gesture matrix (the one platform-divergent thing).
2. `references/dev-menu.md`: the developer-menu items, top to bottom as the app presents them.
3. `references/react-native-devtools.md`: the panels behind "Open DevTools".
4. `references/rozenite.md`: Rozenite plugins, the escape hatch when a built-in panel is not enough.
5. `references/techniques.md`: cross-tool techniques (named after the technique), at the bottom.

## Out of scope

Driving the app (tapping, typing, screenshots) -> the platform skills. Web debugging (Chrome
DevTools, Playwright) -> the web skills; the web diverges from this mobile menu entirely.

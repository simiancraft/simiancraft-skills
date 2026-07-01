---
title: Cross-tool techniques
summary: techniques that span more than one dev-menu item or DevTools panel, each named after the technique, starting with diagnosing a slow re-render
status: draft
sources:
  - https://reactnative.dev/docs/react-native-devtools (the Components highlight-updates toggle and the Profiler)
  - https://docs.expo.dev/debugging/tools/ (the performance monitor's two-thread FPS)
---

# Cross-tool techniques

Reference for **expo-developer-tools**. The single tools live in `dev-menu.md` and
`react-native-devtools.md`; these are the moves that combine them, named after what they diagnose.

## Diagnose a slow re-render

A screen that stutters on interaction is usually a re-render problem, and no single panel proves it.
Combine three:

1. **Confirm it is JS-side.** Toggle the **performance monitor** (`dev-menu.md`) and watch the
   **JS-thread FPS** while you reproduce the interaction. A low JS-thread FPS (UI-thread fine) points
   the finger at JavaScript, not native rendering.
2. **See what re-renders.** In React Native DevTools, open **Components**, then View Settings (`⚙︎`)
   and enable **Highlight updates when components render** (`react-native-devtools.md`). The subtree
   that flashes on each interaction is the one re-rendering too often.
3. **Price it.** Record in the **Profiler** and read the flame graph: which component's render is
   expensive, and how many commits fire. A component that should have been memoized (no `Memo` badge
   where you expected one) is the usual culprit.

The fix is confirmed when the highlighted subtree stops flashing and the JS-thread FPS holds.

## See also

- `dev-menu.md`: the performance monitor and its two-thread FPS.
- `react-native-devtools.md`: the Components highlight-updates toggle and the Profiler.

---
title: Known prompts and overlays
summary: the recurring Expo/RN dialogs and overlays that block automation, and how to clear each by accessibility (axe tap --label), including the stacking push-token alert and the element-inspector trap
status: draft
sources:
  - "axe describe-ui output of the Expo dev menu (labels for this writing; re-run describe-ui to confirm, they drift across Expo/RN versions)"
  - "Simulator Device menu > Shake and its Cmd+Ctrl+Z accelerator, a Simulator-level command (see ios-simulator references/simulator-ui.md)"
  - "Observed, reproducible: the push alert re-fires and stacks on each reload; the element-inspector overlay intercepts taps until toggled off"
  - https://docs.expo.dev/debugging/tools/ (the Expo dev menu and its tools)
---

# Known prompts and overlays

Reference for **expo-ios-simulator**. Launching and reloading an Expo app raises native
dialogs and overlays that stall automation. Clear each by **accessibility**, not
coordinates: `axe describe-ui` to read the label, then `axe tap --label "<label>" --udid <udid>`
(every AXe command needs `--udid`; see **ios-simulator** `references/driving.md`). The
`cliclick` coordinate path is a last resort only.

## The launch sequence

1. **"Open in '<App>'?"** system dialog, from the dev-client deep link (see
   `development-builds.md`). Dismiss: `axe tap --label "Open" --udid <udid>`.
2. **"Must use physical device for Push Notifications"** alert, the push-token alert; it
   fires because the app requests a native APNs device token (`getDevicePushTokenAsync`),
   which a simulator cannot vend. A simulator on Xcode 14+ can still receive a remote push and
   an Expo push token, and `xcrun simctl push` can deliver a payload; the missing piece is the
   native device token. Dismiss it with
   `axe tap --label "OK" --udid <udid>`. It re-fires on every reload, so the alerts stack;
   after a reload, dismiss them in a loop until none remain, otherwise the stacked overlays
   darken and block the screen.

## The dev menu

Open it with the Simulator's Device > Shake accelerator **Cmd+Ctrl+Z** (a Simulator-level
command, see **ios-simulator** `references/simulator-ui.md`; it works even when app-level
keys do not reach the app). `axe describe-ui` then shows its
labels: `Reload`, `Go home`, `Toggle performance monitor`, `Toggle element inspector`,
`Open JS debugger`, and `Close`, plus `Connected to: http://localhost:8081`. Drive any of
them by label, for example `axe tap --label "Reload" --udid <udid>`; close it with
`axe tap --label "Close" --udid <udid>`. This file is only the iOS way to open and drive the
menu; for what each item does (the performance monitor's two-thread FPS, the element inspector's
modes, Open DevTools), see **expo-developer-tools** `references/dev-menu.md`, the shared home for
the menu and React Native DevTools.

## The element-inspector trap

If `Toggle element inspector` gets toggled on (easy to do by accident), the app shows a
dark "inspect" overlay and taps stop reaching the app. Recover by re-opening the dev menu
(Cmd+Ctrl+Z, or click Device > Shake via AppleScript if the keystroke does not land, see
**ios-simulator** `references/simulator-ui.md`) and tapping it off with
`axe tap --label "Toggle element inspector" --udid <udid>`.

## See also

- **ios-simulator** `references/driving.md`: `axe describe-ui` and `axe tap --label`.
- **expo-developer-tools** `references/dev-menu.md`: what each dev-menu item does (shared iOS/Android).
- `development-builds.md`: the deep link that raises the "Open in" dialog.
- **ios-simulator** `references/simulator-ui.md`: the Simulator menus behind the shake shortcut.

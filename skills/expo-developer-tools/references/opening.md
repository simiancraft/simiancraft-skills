---
title: Opening the developer menu
summary: the open-gesture matrix across iOS and Android, device and simulator/emulator, plus the terminal shortcut; the one platform-divergent part of the dev tools
status: draft
sources:
  - https://docs.expo.dev/debugging/tools/ (how to open the developer menu per platform)
---

# Opening the developer menu

Reference for **expo-developer-tools**. The developer menu is the same everywhere; the **gesture
that opens it** is the one thing that differs by platform. Everything past this file (the menu
items, React Native DevTools) is shared, so this is the only place a platform matters.

## The open-gesture matrix

| Where | How to open the menu |
|---|---|
| Expo CLI terminal | press `m` in the terminal running the dev server |
| iOS simulator | `Ctrl + Cmd + Z`, or `Cmd + D` |
| iOS device | shake the device, or touch three fingers to the screen |
| Android emulator (or device over USB) | `Cmd + M` / `Ctrl + M`, or `adb shell input keyevent 82` |
| Android device (no USB) | shake the device vertically |

**React Native DevTools** opens from the menu's **Open DevTools** item (see `dev-menu.md`).

## Sending the gesture headlessly

An automation driver does not use a keyboard shortcut; it sends the gesture through the
platform's own tooling, then reads the menu here:

- **iOS simulator**: the Simulator's Device > Shake (its `Cmd+Ctrl+Z` accelerator, or an AppleScript
  menu click). See **ios-simulator** `references/simulator-ui.md` and **expo-ios-simulator**
  `references/known-prompts.md`.
- **Android emulator**: `adb shell input keyevent 82`. See **android-emulator-harness**.

## See also

- `dev-menu.md`: what the menu opens to, once you are in it.
- **expo-ios-simulator** and **android-emulator-harness**: sending the open-gesture per platform.

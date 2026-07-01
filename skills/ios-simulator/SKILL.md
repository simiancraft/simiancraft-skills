---
name: ios-simulator
description: >-
  Drive an iOS Simulator headlessly on macOS: discover and boot a device, install
  and launch an app, drive its UI by accessibility (AXe) rather than brittle
  coordinates, capture screenshots, and navigate the simulator's own chrome,
  menus, and execution modes. The iOS analog of android-emulator-harness and
  playwright-harness. Project-agnostic core; Expo/React-Native specifics live in
  expo-ios-simulator, and "make the app driveable" lives in mobile-accessibility.
  Use for any task that is "boot/run an iOS simulator", "drive an iOS screen",
  "screenshot the simulator", or "automate an iOS flow".
status: complete
sources:
  - "xcrun simctl help and AXe (axe --help); each reference file below carries the per-command provenance"
  - https://developer.apple.com/documentation/xcode/running-your-app-in-the-simulator-or-on-a-device
---

# iOS Simulator (core, project-agnostic)

The kernel for driving an iOS Simulator on macOS. Layers sit ON TOP of this:
**expo-ios-simulator** (the Expo/React-Native runtime), **mobile-accessibility** (the
tree you drive against), **ios-simulator-triage** (when it breaks), and
**ios-simulator-flow-evidence** (capturing proof). Everything here goes through
`xcrun simctl` and AXe; the Simulator app window is touched only for what the CLI cannot do.

## Before anything

Run the checks and install the driver: `prerequisites.md`. In short, macOS with Xcode
(so `xcrun simctl`), a booted simulator, and **AXe** (`brew install cameroncooke/axe/axe`).

## The loop

1. **Boot, install, launch** an app on a device (`references/lifecycle.md`): find the
   booted UDID, `simctl install`, `simctl launch`.
2. **Drive by accessibility, not coordinates** (`references/driving.md`): `axe tap --id`
   or `--label`, `axe type`, `axe swipe` or `gesture`. See **mobile-accessibility** for
   what makes an app addressable.
3. **Capture** (`references/capture.md`): `simctl io ... screenshot`; the screenshot is
   the device framebuffer, so window size and position never matter. Verify it with vision.
4. **Set device state and permissions** (`references/permissions.md`,
   `references/device-state.md`): `simctl privacy` to skip dialogs; appearance, status bar,
   location, media, clipboard, and push to put the device in a known state.
5. **The app's own chrome** (`references/simulator-ui.md`): menu-only features, the
   window geometry, and opening a URL on the device.

## Rules

- Prefer `simctl` and AXe (accessibility) over the window and coordinates. Read the
  Simulator's state; never resize or full-screen it.
- Every factual claim here and in the references cites a primary source (the tool's own
  help, Apple, AXe); a prior-art skill is never a source.

## Where to go next

- Running an Expo or React Native app, the dev menu, the recurring launch prompts:
  **expo-ios-simulator**.
- A build, runtime, or automation failure: **ios-simulator-triage**.
- Screenshots and video as proof artifacts: **ios-simulator-flow-evidence**.

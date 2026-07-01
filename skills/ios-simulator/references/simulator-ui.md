---
title: Simulator UI lexicon
summary: the Simulator app window versus the simulated device, reading the window geometry, the menu lexicon and how to trigger items, and opening a web URL on the device
status: draft
sources:
  - "Simulator menu bar, read live via AppleScript / System Events (re-run to list the items for your Xcode)"
  - "xcrun simctl help openurl (opening a URL on the device)"
  - https://developer.apple.com/documentation/xcode/running-your-app-in-the-simulator-or-on-a-device
---

# Simulator UI lexicon

Reference for **ios-simulator**. The Simulator is a macOS app hosting a simulated
device. Most automation goes through `simctl` and AXe and never touches this window;
this file covers what only the app exposes: menu-only features, the window geometry the
screen-coordinate fallback in `driving.md` needs, and opening a URL on the device.

## Window versus device

The window is macOS chrome around the device screen. A screenshot captures the device
**framebuffer** (window-independent; see `capture.md`), so window size, position, and
full-screen state never change device coordinates. You do not need to resize or
full-screen the window to drive or capture; read state, do not change it.

## Read the window geometry

The screen-coordinate fallback in `driving.md` maps a device fraction onto the window,
which needs the window's live bounds:

```bash
osascript -e 'tell application "System Events" to tell process "Simulator" to get {position, size} of window 1'
```

Re-read before each click; the window can move or resize between calls.

## The menu lexicon

The top-level menus are `Apple`, `Simulator`, `File`, `Edit`, `Device`, `I/O`,
`Features`, `Debug`, `Window`, and `Help`. The menus and their items drift between Xcode
versions, and an item can move between menus, so treat the lists below as accurate for
this writing and print the live items for any menu (swap `Device` for the menu name):

```bash
osascript -e 'tell application "System Events" to tell process "Simulator" to get name of menu items of menu "Device" of menu bar 1'
```

The automation-relevant items (on the Xcode read for this doc):

- **Device**: Erase All Content and Settings, Rotate Left, Rotate Right, Home, Lock,
  Siri, Shake, App Switcher, and Trigger Screenshot.
- **I/O**: Keyboard (including the Connect Hardware Keyboard toggle), Audio Input,
  Audio Output, and External Displays.
- **Features**: Face ID, Authorize Apple Pay, Toggle Appearance (light/dark), Toggle
  In-call Status Bar, and the text-size and contrast toggles.
- **File**: Save Screen and Record Screen (recording is evidence; see
  **ios-simulator-flow-evidence**).
- **Edit**: the device pasteboard (Automatically Sync Pasteboard, Get Pasteboard, and
  Send Pasteboard).

## Triggering a menu item

Prefer `simctl` or AXe when an equivalent exists: Trigger Screenshot is
`simctl io ... screenshot` (`capture.md`), Home and Lock are `axe button`
(`driving.md`), and Erase All Content and Settings is `simctl erase` (`lifecycle.md`).
Toggle Appearance and the contrast and text-size toggles are **scriptable** through
`simctl ui`, and the status bar's contents (time, battery, carrier) are overridable via
`simctl status_bar` (`device-state.md`); prefer those over the menu. For the genuinely
menu-only features (the in-call status-bar banner, Face ID, Connect Hardware Keyboard, Shake),
click the item through AppleScript:

```bash
osascript -e 'tell application "System Events" to tell process "Simulator" to click menu item "Shake" of menu "Device" of menu bar 1'
```

Shake opens the React Native and Expo developer menu; see **expo-ios-simulator**.

## Open a web URL on the device (web on mobile)

`simctl openurl` opens a URL on the device: an `https` URL launches mobile Safari, and
a custom-scheme URL follows a deep link.

```bash
xcrun simctl openurl booted https://example.com   # open a site in mobile Safari
xcrun simctl openurl booted <scheme>://<path>      # follow a deep link
```

Use the Safari path to view a web build on the device or confirm a universal link; the
scheme path is how you reach a dev client or a deep route.

## See also

- `capture.md`: the device framebuffer (why window state does not matter).
- `driving.md`: the screen-coordinate fallback that consumes the window geometry.
- `lifecycle.md`: the `simctl` equivalents of the menu actions.
- `device-state.md`: the scriptable appearance, status-bar, and contrast overrides.
- **ios-simulator-flow-evidence**: screen recording (the File menu's Record Screen).

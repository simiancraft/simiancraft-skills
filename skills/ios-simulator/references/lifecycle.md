---
title: Simulator lifecycle
summary: boot/shutdown/erase, install/launch/terminate, and discovering the booted UDID and device scale, all through xcrun simctl
status: draft
sources:
  - "xcrun simctl help (per-Xcode; primary source for the commands and flags below)"
  - "xcrun simctl help <subcommand> (per-command flags)"
  - https://developer.apple.com/documentation/xcode/running-your-app-in-the-simulator-or-on-a-device
  - https://developer.apple.com/design/human-interface-guidelines/ (device logical point sizes, for the scale example)
---

# Simulator lifecycle

Reference for **ios-simulator**. Nearly every command here is `xcrun simctl`,
Apple's command-line control for the Simulator (the one exception, `open -a
Simulator`, is called out where it appears). `xcrun simctl help` and
`xcrun simctl help <subcommand>` are the authority; they ship with your Xcode and
match the version you have, so re-run them to confirm anything below.

## The `booted` shorthand

For any command that takes a `<device>`, the literal string `booted` targets a
booted device instead of a UDID. If more than one device is booted, `simctl`
picks one of them, so prefer an explicit UDID when more than one may be running.

## Discover devices

```bash
xcrun simctl list devices --json        # all devices, machine-readable
xcrun simctl list devices booted        # only what is currently booted
```

Use `-j`/`--json` for machine-readable output. `list` also takes `devicetypes`,
`runtimes`, and `pairs`, plus a case-insensitive search term and the keyword
`available`.

## Boot, shutdown, erase

```bash
xcrun simctl boot <udid>                # boot a specific device
open -a Simulator                       # show the Simulator window (boot alone is headless; NOT a simctl command)
xcrun simctl shutdown <udid|booted>     # power it down
xcrun simctl erase <udid|booted>        # wipe contents and settings to factory state
```

`boot` accepts `--arch=<arch>` (e.g. `arm64`) and `--enabledJob` / `--disabledJob`
to toggle launchd jobs. `erase` takes one or more devices, or the literal `all`
to erase every device.

## Install, launch, terminate, uninstall

```bash
xcrun simctl install <udid|booted> /path/to/App.app
xcrun simctl launch <udid|booted> <app-bundle-id>           # launch by bundle id
xcrun simctl launch --console <udid|booted> <app-bundle-id> # block and stream stdout/stderr
xcrun simctl terminate <udid|booted> <app-bundle-id>
xcrun simctl uninstall <udid|booted> <app-bundle-id>
xcrun simctl get_app_container <udid|booted> <app-bundle-id> # confirm an install; print its path
```

`launch` flags worth knowing: `--console` / `--console-pty` block and stream the
app's output to the terminal (log output usually goes to **stderr**, not stdout);
`--terminate-running-process` relaunches cleanly; `-w` / `--wait-for-debugger`
holds for a debugger. Trailing arguments after the bundle id are passed to the app.

## Discover the booted UDID and device scale

The UDID comes from the JSON device list. `.devices` is an object keyed by runtime
whose values are arrays of devices, so iterate both levels:

```bash
xcrun simctl list devices booted --json \
  | jq -r '.devices | to_entries[] | .value[] | select(.state=="Booted") | .udid'
```

Scale is **derived**, not a `simctl` command. A screenshot is the device's
framebuffer, so divide its pixel width by the device's logical point width (from
Apple's device specs); e.g. an iPhone 16 Pro screenshot is 1206 px wide at 402 pt,
so 3x:

```bash
xcrun simctl io booted screenshot /tmp/probe.png
```

Capturing the screen and reading its pixel dimensions lives in `capture.md`; map a
screenshot fraction to a device point by dividing by this scale.

## Passing environment into the launched app

Set variables in the calling environment with a `SIMCTL_CHILD_` prefix and `simctl`
forwards them (stripped of the prefix) into the app it launches:

```bash
SIMCTL_CHILD_MY_FLAG=1 xcrun simctl launch <udid|booted> <app-bundle-id>
```

## See also

- `capture.md`: screenshots and the device framebuffer.
- `permissions.md`: `simctl privacy` grants.
- `simulator-ui.md`: the Simulator app window and menus around these commands.
- For installing an Expo/React Native dev client and launching it, see
  **expo-ios-simulator** `references/development-builds.md`.

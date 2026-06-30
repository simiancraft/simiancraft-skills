---
title: Prerequisites
summary: verify the environment can run and drive an iOS Simulator before anything else, and install AXe
status: draft
sources:
  - "xcodebuild -version and xcrun simctl help (ship with Xcode; run to confirm availability)"
  - https://github.com/cameroncooke/AXe (the AXe driver; brew install)
  - "axe --help and axe --version (the AXe subcommands incl. list-simulators, and the installed version)"
  - https://developer.apple.com/documentation/xcode/running-your-app-in-the-simulator-or-on-a-device
---

# Prerequisites

Reference for **ios-simulator**. Gate every run on these; each is a one-line check with
a clear pass signal.

- **macOS.** Simulators are macOS-only; nothing here runs elsewhere.
- **Xcode and Command Line Tools.** `xcodebuild -version` prints a version, and `xcrun
  simctl help` lists subcommands; both ship with Xcode.
- **A simulator to target.** `xcrun simctl list devices` shows at least one device; boot
  one with `xcrun simctl boot <udid>` (see `references/lifecycle.md`).
- **AXe, the accessibility-first driver.** `brew install cameroncooke/axe/axe`, then
  `axe --version` prints a version and `axe list-simulators` lists devices. AXe reads and
  drives the accessibility tree; prefer it over coordinates (see **mobile-accessibility**).
- **cliclick (fallback only).** `brew install cliclick` for the no-AXe coordinate path in
  `references/driving.md`; unnecessary when AXe is available.

If a check fails, stop and fix it before driving; a missing tool surfaces later as a
confusing "command not found" or a silent no-op.

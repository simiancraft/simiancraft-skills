---
title: Development builds
summary: build and install an Expo dev client on the simulator; the expo run:ios device-picker pitfall, the direct xcodebuild + simctl path, Metro readiness, the dev-client deep link, and waiting for the first bundle
status: complete
sources:
  - https://docs.expo.dev/guides/local-app-development/ (npx expo run:ios; prebuild, compile, install, launch, and Metro)
  - "xcodebuild (Apple; the direct simulator build) and xcrun simctl install/launch/openurl"
  - "Observed behavior of npx expo run:ios and the dev-client deep link (reproducible; run to confirm for your Expo version)"
  - "Observed behavior of Metro's /status endpoint (packager-status:running) and the first-bundle Bundling banner (reproducible; run to confirm for your Expo version)"
---

# Development builds

Reference for **expo-ios-simulator**. An Expo app with native modules cannot run in
Expo Go; it needs a **development build** (a dev client). This is the build-and-install
half; the prompts and dev menu that follow are in `known-prompts.md`.

## The standard build: expo run:ios

`npx expo run:ios` runs prebuild if `ios/` is missing, installs pods (`pod install`), compiles
with Xcode, installs the binary, launches it, and starts Metro. It is the documented
one-shot path.

## The headless simulator pitfall

`expo run:ios` selects a target device, and driven headlessly it tends to choose a
**physical-device** build, which then fails with `No code signing certificates are
available`. The Expo docs do not cover simulator-vs-device or signing, so for a
reliable simulator build, bypass the picker and drive `xcodebuild` directly (the
`ios/` project already exists after one prebuild + pod install):

```bash
xcodebuild -workspace ios/<App>.xcworkspace -scheme <App> -configuration Debug \
  -sdk iphonesimulator -destination "id=<udid>" -derivedDataPath ios/build \
  CODE_SIGNING_ALLOWED=NO build
```

The product is `ios/build/Build/Products/Debug-iphonesimulator/<App>.app`. Install that
path with `xcrun simctl install booted <product-path>` (see **ios-simulator**
`references/lifecycle.md`).

## Metro, and connecting the dev client

In practice, with `CI=1`, `expo run:ios` exits after launching and does not keep Metro
alive, so the dev client lands on a "could not connect" screen. Start Metro as its own
persistent process (`CI=1` here too, so it never waits on its interactive terminal UI),
**verify it is serving before launching the app**, then point the dev client at it:

```bash
CI=1 npx expo start --dev-client &           # serve Metro on :8081 (its own process)
until curl -s http://localhost:8081/status | grep -q packager-status:running; do sleep 1; done
xcrun simctl launch booted <app-bundle-id>   # open the app; it reconnects to Metro
xcrun simctl openurl booted "<scheme>://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"  # or force a specific Metro URL
```

The deep link raises an "Open in '<App>'?" system dialog when the app is not already
frontmost (launching the app first, as above, can skip it); if it appears, dismiss it by
accessibility, not coordinates: `axe tap --label "Open" --udid <udid>`.

## Wait for the first bundle

The deep link does not make the app interactive: Metro then builds and serves the JS bundle
(a "Bundling NN%..." banner, then the splash screen), which takes tens of seconds cold.
Driving before it finishes taps into a void that still reports success (dispatch is not
confirmation; see **ios-simulator** `references/driving.md`). Wait by polling the
accessibility tree until the app's own labels appear:

```bash
until [ "$(axe describe-ui --udid <udid> | jq '[.. | objects | select(.AXLabel? != null)] | length')" -gt 2 ]; do sleep 3; done
```

A splash screen exposes at most a node or two; a rendered screen exposes many. Then read
what actually rendered (the label inventory one-liner in **ios-simulator**
`references/driving.md`) before the first tap.

Discover `<App>` (scheme and workspace) and `<app-bundle-id>` from `app.config`
(`scheme`, `ios.bundleIdentifier`); never hardcode them. If `app.config` sets no `scheme`,
the dev client registers the fallback `exp+<slug>`, so use
`exp+<slug>://expo-development-client/?url=...`.

## See also

- **ios-simulator** `references/lifecycle.md` (simctl install/launch) and `references/driving.md` (`axe tap`).
- `known-prompts.md`: the dialogs and the dev menu after launch.
- `execution-modes.md`: when a dev client is the right mode versus Expo Go or web.

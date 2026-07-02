---
title: Build failures
summary: the artifact will not build or install; code signing, CocoaPods, prebuild, and architecture, routed to the fixes
status: complete
sources:
  - https://docs.expo.dev/guides/local-app-development/ (npx expo prebuild, npx expo run:ios)
  - https://guides.cocoapods.org/using/using-cocoapods.html (pod install)
  - "xcodebuild and xcrun simctl install (Apple); the simulator code-signing fix lives in expo-ios-simulator/references/development-builds.md"
---

# Build failures

Reference for **ios-simulator-triage**. The symptom is that nothing reaches the device: the
compile, the pod install, or the prebuild failed, so there is no `.app` to install. The log
is the **xcodebuild output** (and its `.xcresult` bundle, which `xcrun xcresulttool get
build-results` reads into JSON; see `references/logging.md`). Match
the error, then apply the fix, which usually lives in a sibling skill.

## "No code signing certificates are available"

The most common simulator build failure, and a false alarm: it means the build targeted a
**physical device** (which needs signing) instead of the simulator. `npx expo run:ios`
driven headlessly tends to pick a device. The fix is to build explicitly for the simulator
with `CODE_SIGNING_ALLOWED=NO`, which is the whole point of **expo-ios-simulator**
`references/development-builds.md`; follow that file rather than re-deriving the `xcodebuild`
invocation here.

## CocoaPods: pod install failed

A native build needs its pods. If `xcodebuild` reports a missing pod or a sandbox mismatch,
run `pod install` in the `ios/` directory (or `npx pod-install`), then rebuild. A stale spec
repo shows as "could not find compatible versions"; update the repo and retry. `pod install`
is the documented CocoaPods step (CocoaPods Guides); `npx expo prebuild` also runs it.

## Prebuild: ios/ is missing

An Expo project has no `ios/` until prebuilt. If the native project is absent, run
`npx expo prebuild` (it also installs pods), then build. See **expo-ios-simulator**
`references/development-builds.md` for where prebuild sits in the dev-client flow.

## Architecture mismatch

"building for iOS Simulator, but linking in object file built for iOS" (or an `arm64`
exclusion error) means a dependency was compiled for the wrong destination. Confirm the build
targets `-sdk iphonesimulator` with the booted device's destination; the canonical simulator
`xcodebuild` line is in `references/development-builds.md` of **expo-ios-simulator**.

## See also

- **expo-ios-simulator** `references/development-builds.md`: the simulator `xcodebuild` line and signing.
- `references/logging.md`: reading the xcodebuild output and the `.xcresult` bundle.
- `references/runtime-failures.md`: when the build succeeds but the app then crashes.

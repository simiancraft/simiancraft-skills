---
title: Runtime failures
summary: the app launched but broke, split into the app's native runtime (crash reports, the unified log) and the Expo / React-Native runtime (missing native module, Metro disconnect, the red box)
status: draft
sources:
  - "xcrun simctl launch --console (stdout/stderr; log often goes to stderr), simctl spawn booted log stream, and simctl diagnose (from xcrun simctl help)"
  - https://docs.expo.dev/develop/development-builds/introduction/ (Expo Go's fixed native set; the missing-native-module failure)
  - https://docs.expo.dev/debugging/runtime-issues/ (debugging Expo runtime errors via the stack trace; native logs reveal crashes that do not surface in Metro)
---

# Runtime failures

Reference for **ios-simulator-triage**. The app installed and launched, then crashed or
misbehaved. The layer decides the log and the fix, so split it: an **app-native** crash and an
**Expo / React-Native** failure look alike on screen but are diagnosed differently.

## App-native runtime

A native crash (the app vanishes, or never draws) leaves evidence outside the JS world:

- **Crash report**: look in `~/Library/Logs/DiagnosticReports` for a fresh `.ips` report
  naming the thread and exception; or collect everything with `xcrun simctl diagnose`. The
  report is written by a host daemon and can lag the crash by seconds, so if none is there
  immediately, wait and re-check rather than concluding there was no crash. Turn a stripped
  report's addresses into function names with `atos` (give it the app binary or its `.dSYM` via
  `-o` and the load address via `-l`, matching the UUID from `dwarfdump --uuid`).
- **stdout / stderr**: relaunch with `xcrun simctl launch --console booted <bundle-id>`
  (see `references/logging.md`); log output is often on **stderr**, not stdout, so do not
  assume silence means nothing happened.
- **Unified log**: watch `xcrun simctl spawn booted log stream` (filtered with a predicate)
  while you reproduce; see `references/logging.md`.
- **Hang, not crash**: a frozen app (spinner, unresponsive) leaves no crash report and looks
  exactly like a missed tap. Watch the unified log for watchdog and `RunningBoard` terminations;
  a `0x8badf00d` exception code in an `.ips` report is the watchdog killing a hung app.

Discover `<bundle-id>` from the app config (`ios.bundleIdentifier`); never hardcode it.

## Expo / React-Native runtime

The JavaScript layer fails differently, and usually says so on screen (the red error overlay):

- **Missing native module**: the JS runs, then throws the instant it calls a native API that
  is not in the runtime. In **Expo Go** this is the fixed-native-set limit; the app needs a
  development build (see **expo-ios-simulator** `references/expo-go.md`). On a dev client it
  means the module is not linked; rebuild after adding it.
- **Metro disconnected** ("could not connect to development server"): Metro is not running or
  the client points at the wrong URL. Start it and reconnect per **expo-ios-simulator**
  `references/development-builds.md`.
- **A red-box JS error**: read it; the stack and the Metro terminal name the file and line.
  The Metro terminal (the `npx expo start` process) is the JS log, not the unified log.

## See also

- `references/logging.md`: the console, the unified log, crash reports, and the Metro terminal.
- **expo-ios-simulator** `references/expo-go.md`: the missing-native-module crash and its fix.
- **expo-ios-simulator** `references/development-builds.md`: Metro and reconnecting a dev client.

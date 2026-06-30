---
title: Where the logs live
summary: the log source for each failure layer (xcodebuild output, the unified log, console stdout/stderr, crash reports, simctl diagnose, the Metro terminal), indexed by layer
status: draft
sources:
  - "xcrun simctl help: launch --console/--console-pty/--stdout/--stderr, spawn, diagnose, get_app_container"
  - https://developer.apple.com/documentation/os/logging (the unified logging system that `log` reads)
---

# Where the logs live

Reference for **ios-simulator-triage**. Each failure layer has a different log; pulling the
right one turns a guess into a cause. This file is the index the other three reference.

## The unified log (runtime, system-wide)

The simulator runs Apple's unified logging system; reach it by spawning `log` inside the
device:

```bash
xcrun simctl spawn booted log stream                      # live
xcrun simctl spawn booted log show --last 5m              # recent, after the fact
```

Narrow the firehose with a predicate (`xcrun simctl spawn booted log help predicates`), for
example `--predicate 'process == "<AppName>"'` (the process, i.e. executable, name). Use this
for app-native runtime behavior.

## The app's stdout and stderr (runtime, one app)

Launch the app attached to your terminal:

```bash
xcrun simctl launch --console booted <bundle-id>          # block and print stdout + stderr
xcrun simctl launch --stdout=out.log --stderr=err.log booted <bundle-id>   # to files
```

Apple's note: **log output is often on stderr, not stdout**, so capture both. To set
environment variables for the launched app, export them in the calling shell with a
`SIMCTL_CHILD_` prefix. Discover `<bundle-id>` from the app config; never hardcode it.

## Crash reports and the diagnostic bundle

- A native crash writes an `.ips` report to `~/Library/Logs/DiagnosticReports`; the freshest
  one names the thread and exception.
- `xcrun simctl diagnose` collects logs and diagnostics into one bundle when you need the
  whole picture to attach or inspect.
- `xcrun simctl get_app_container booted <bundle-id> data` prints the app's data container,
  for inspecting files it wrote.

## The build log

A build failure's log is the **xcodebuild output** and its `.xcresult` bundle, not anything
above; see `references/build-failures.md`.

## The JS log (Expo / React-Native runtime)

The **Metro terminal** (the `npx expo start` process) is the JavaScript log; red-box errors
and `console.log` land there, not in the unified log. The in-app red overlay carries the same
stack. See `references/runtime-failures.md`.

## The accessibility dump (automation)

For an automation stall, the relevant "log" is the tree itself: capture
`axe describe-ui --udid <udid>` to a file as evidence of what was and was not addressable
when the tap missed (see `references/automation-failures.md`).

## Index by layer

- **Build** -> xcodebuild output / `.xcresult` (`references/build-failures.md`).
- **Runtime, app-native** -> unified log, `--console` stdout/stderr, crash report, `diagnose`.
- **Runtime, Expo / RN** -> the Metro terminal and the red box (`references/runtime-failures.md`).
- **Automation** -> the `describe-ui` dump (`references/automation-failures.md`).

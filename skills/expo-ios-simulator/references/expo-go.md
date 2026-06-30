---
title: Running under Expo Go
summary: the Expo Go path on the simulator (npx expo start, press i, auto-install) and the fixed-native-set limit that forces a dev client for any app with custom native code
status: draft
sources:
  - https://docs.expo.dev/get-started/set-up-your-environment/ (npx expo start; press i; Expo CLI installs Expo Go automatically)
  - https://docs.expo.dev/develop/development-builds/introduction/ (Expo Go ships a fixed set of native libraries; custom native code cannot be added; when to switch to a dev build)
---

# Running under Expo Go

Reference for **expo-ios-simulator**. Expo Go is the prebuilt Expo client from the App
Store: the fastest way to put a **pure-JS** Expo app on the simulator, and the wrong
tool the moment the app carries custom native code. For the dev-client path it forces
you onto, see `development-builds.md`; for choosing between the modes, `execution-modes.md`.

## Launching an app in Expo Go

Expo CLI installs and drives Expo Go for you; you do not build anything.

```bash
npx expo start    # start Metro (no --dev-client)
# press i to open the iOS Simulator
```

Expo CLI **installs Expo Go automatically** on the booted simulator, then opens the app
inside it. If several simulators are booted, target one first (see **ios-simulator**
`references/lifecycle.md`); pressing `i` acts on the active simulator.

## The hard limit: a fixed set of native modules

Expo Go ships **a fixed set of native libraries built in** (for example
`react-native-webview`). That native bundle is whatever was uploaded to the App Store;
it cannot be extended at runtime. The Expo docs put it plainly: *"There is no way to get
the native code into the Expo Go app unless it was already included in the bundle that
was uploaded to the app stores."*

So when an app imports a native library outside that set (a `react-native-firebase`, a
custom Expo Module, anything with its own Swift/Obj-C), the **JavaScript still runs but
errors the instant it calls the missing native code**. The failure is not a build error;
it is a runtime crash on first use, which is why it is easy to mistake for an app bug.
Triage of that symptom lives in **ios-simulator-triage** `references/runtime-failures.md`.

## When Expo Go is the wrong mode

Per the Expo docs, you need a **development build** (not Expo Go) to:

- use any native library outside Expo Go's fixed set, or a config plugin;
- test app icon, name, or splash-screen changes;
- exercise remote push notifications;
- exercise App / Universal links;
- support older SDK versions on a device.

Expo positions Expo Go as *"a playground app for students and learners"*; a real app with
native dependencies belongs on a dev client. If you are unsure which the project is, check
the app config and `package.json` for native modules or config plugins, then default to
`development-builds.md`.

## See also

- `development-builds.md`: the dev-client build the native-set limit forces you onto.
- `execution-modes.md`: Expo Go versus dev client versus Storybook-mobile versus web.
- **ios-simulator-triage** `references/runtime-failures.md`: the missing-native-module crash.
- **ios-simulator** `references/lifecycle.md`: targeting one of several booted simulators.

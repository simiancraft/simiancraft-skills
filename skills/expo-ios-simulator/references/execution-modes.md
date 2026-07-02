---
title: Execution modes
summary: the four ways to run an Expo app on the simulator (Expo Go, a dev client, Storybook-mobile, web-on-mobile), what each is, and when to use it
status: complete
sources:
  - https://docs.expo.dev/guides/local-app-development/ (npx expo run:ios; local dev builds)
  - "xcrun simctl help openurl (web-on-mobile) and the STORYBOOK_ENABLED env gate (observed; project-defined)"
  - https://docs.expo.dev/develop/development-builds/introduction/ (development builds vs Expo Go)
---

# Execution modes

Reference for **expo-ios-simulator**. There are four ways to put an Expo app in front
of you on the simulator. Pick by what the app needs, then follow the linked file.

## Expo Go

The prebuilt Expo client app from the App Store, driven by `npx expo start` (no
`--dev-client`). It runs only the Expo SDK; an app with **custom native modules cannot
run in Expo Go**. Use it for a pure-JS prototype. Details and limits: `expo-go.md`.

## Development build (dev client)

A custom build of the app with its own native modules; the normal mode for a real
app. Build and install it, then serve Metro with `npx expo start --dev-client`. The
build path, Metro, and the connect deep link are in `development-builds.md`.

## Storybook for mobile

The React Native Storybook UI rendered inside the dev client, for working on a
component in isolation. When the project wires RN Storybook behind an env flag (often
`STORYBOOK_ENABLED`), start Metro with that flag set and reload the dev client; it
loads the Storybook UI instead of the app. The flag and entry are project-defined, so
check the project's `metro.config`/`app.config`.

## Web on mobile

Not the native app: a URL opened in mobile Safari with
`xcrun simctl openurl booted https://...`. Use it to view a web build on the device or
to confirm a universal link; deep links into the app use the app's scheme instead. See
**ios-simulator** `references/simulator-ui.md`.

## See also

- `expo-go.md`: the Expo Go path and its native-module limits.
- `development-builds.md`: building and connecting a dev client.
- **ios-simulator** `references/simulator-ui.md`: opening a URL on the device.

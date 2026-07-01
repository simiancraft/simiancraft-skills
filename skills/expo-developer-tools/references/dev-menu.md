---
title: The developer menu
summary: the developer-menu items top to bottom as the app presents them, what each is and what an agent reads it for, including the performance monitor's two-thread FPS and the element inspector's four modes
status: draft
sources:
  - https://docs.expo.dev/debugging/tools/ (the developer-menu items, the performance monitor, and the element inspector)
---

# The developer menu

Reference for **expo-developer-tools**. Once the menu is open (`opening.md`), these are its items,
top to bottom in the order the app lists them. Each entry is what the tool is and what an agent
reads it for; deeper cross-tool recipes are in `techniques.md`.

## The items, in order

1. **Copy link**: copies the dev-server address (dev client) or `exp://` link (Expo Go). Rarely
   needed for driving; useful to confirm which bundle the app is pointed at.
2. **Reload**: reloads the app. "Usually, not necessary since Fast Refresh is enabled by default";
   reach for it when Fast Refresh has not picked up a change or the JS context is wedged.
3. **Go home**: leaves the app for the dev client's or Expo Go's home screen. Use it to switch
   which project is loaded.
4. **Toggle performance monitor**: an on-screen overlay of live performance (see below).
5. **Toggle element inspector**: an overlay to inspect rendered elements (see below).
6. **Open DevTools** (formerly "Open JS debugger"): opens **React Native DevTools** for apps using
   **Hermes**, the deep instrument. Its panels have their own file, `react-native-devtools.md`.
7. **Fast Refresh**: toggles automatic refresh of the JS bundle when you save a file.

## Toggle performance monitor

The overlay reports, live on the device:

- **FPS for the UI thread and the JS thread**, as two separate readouts. The split is the whole
  point: a low **UI-thread** FPS points at rendering or native work, a low **JS-thread** FPS points
  at the JavaScript thread being blocked. Read both before concluding where a jank is.
- **RAM** usage of the app, and the **JavaScript heap** (watch it climb to spot a leak).
- Two **Views** counts: on-screen views and total component views.

## Toggle element inspector

An overlay with four modes: **Inspect**, **Perf**, **Network**, and **Touchables**. Inspect shows
an element's box and styles when you tap it. This is the **in-app overlay inspector**, and it
is distinct from React Native DevTools' Components panel "Select element" flow (`react-native-devtools.md`);
do not conflate them. While the overlay is on it **intercepts taps**, so a driver's taps stop
reaching the app until it is toggled back off; recovery on iOS is in **expo-ios-simulator**
`references/known-prompts.md`.

## See also

- `react-native-devtools.md`: the panels behind Open DevTools.
- `techniques.md`: combining the performance monitor, Components, and the Profiler.
- **expo-ios-simulator** `references/known-prompts.md`: the element-inspector-trap recovery on iOS.

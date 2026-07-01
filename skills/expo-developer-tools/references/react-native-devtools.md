---
title: React Native DevTools
summary: the panels behind "Open DevTools" (Console, Sources, Network, Memory, Performance, Components, Profiler), what each shows and how an agent reads it, plus the reconnection dialog
status: complete
sources:
  - https://reactnative.dev/docs/react-native-devtools (the DevTools panels and the reconnection dialog)
  - https://docs.expo.dev/debugging/tools/ (Open DevTools; the Network panel's Expo-only note)
---

# React Native DevTools

Reference for **expo-developer-tools**. Opened from the dev menu's **Open DevTools**
(`dev-menu.md`), React Native DevTools **replaced the Chrome-based (Hermes) debugger frontend in React Native 0.76**
and supports apps running **Hermes**. Its panels:

## Console

View and filter messages, evaluate JavaScript, and inspect object properties. **Live Expressions**
watch a value over time; **Preserve Logs** persists messages across reloads; `Cmd/Ctrl + L` clears.

## Sources and breakpoints

View source files and set breakpoints to pause and inspect live state. Add a breakpoint by clicking
the line-number column (`Cmd/Ctrl + P` opens a file); **conditional breakpoints** and **logpoints**
narrow when a breakpoint fires. While paused, a "Paused in Debugger" overlay appears (tap it to
resume), and the right-hand panels show the current **scope and call stack**; set **watch
expressions** there. A `debugger;` statement in the source sets a breakpoint from your editor.

## Network (since 0.83, Expo only)

Inspect requests with timings, headers, and response previews. It records `fetch()`,
`XMLHttpRequest`, and `<Image>` requests; the **Initiator** tab shows the call stack that started a
request. It does **not** yet cover WebSocket events, response mocking, or throttling (for those,
reach for a Rozenite plugin, see `rozenite.md`). Response previews sit in an on-device buffer capped
around 100 MB, oldest evicted first. This panel is available only when `expo` is installed.

## Memory

Take a heap snapshot and watch JS memory over time. `Cmd/Ctrl + F` filters for an object; the
**allocation-timeline** report graphs memory over time to find a leak.

## Performance (since 0.83)

Record a session to see where JavaScript time goes: JS execution, React performance tracks, network
events, and custom User Timings in one timeline. **Annotations** (shift-drag) label a trace before
you download and share it; the `PerformanceObserver` API captures performance events at runtime.
This whole-timeline panel is distinct from the React **Profiler** below (which is about component
renders).

## Components (React)

Inspect and update the rendered React component tree. Hover or select a node to highlight it on the
device; the top-left **Select element** button plus a tap on the device locates a node in the tree.
**Props and state can be viewed and modified at runtime** in the right-hand panel. A component
optimized by React Compiler carries a **`Memo ✨` badge**. In View Settings (the `⚙︎` icon), **Highlight
updates when components render** flashes components as they re-render, which is how you *see* a
runaway re-render.

## Profiler (React)

Record a profile to understand the timing of component renders and React commits; it shows **flame
graphs** of render timing. Use it to price a re-render you spotted with the highlight-updates toggle.

## When DevTools disconnects

DevTools drops the connection when the app closes, is rebuilt, crashes natively, when Metro quits,
or when a physical device disconnects. The dialog offers **Dismiss** (the close icon or a click
outside, keeping the last DevTools state) or **Reconnect DevTools** (once you have fixed the cause).

## See also

- `dev-menu.md`: the Open DevTools item that launches this.
- `rozenite.md`: plugins that add panels the built-ins lack (WebSocket, store inspection).
- `techniques.md`: using Components highlight-updates and the Profiler together.

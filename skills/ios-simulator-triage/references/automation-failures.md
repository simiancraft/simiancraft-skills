---
title: Automation failures
summary: the app runs but AXe cannot act; no booted device, an empty describe-ui tree, an app that is not interactive yet, a missed tap, or a blocking overlay
status: complete
sources:
  - "axe --help (list-simulators, describe-ui, tap --id/--label) and xcrun simctl list devices booted (from xcrun simctl help)"
  - "the accessibility-tree cause is owned by mobile-accessibility; the overlay causes by expo-ios-simulator/references/known-prompts.md"
---

# Automation failures

Reference for **ios-simulator-triage**. The app is on screen, but the driver cannot find or
act on an element. These often emit **no error**; AXe reports success on a tap that hit
nothing, so the symptom is a flow that silently stalls. Work down this list.

## No booted simulator, or the wrong one

`axe` needs a `--udid`, and every command targets one device. If commands no-op or error on
the device, confirm one is booted and you have the right UDID:
`xcrun simctl list devices booted` (see **ios-simulator** `references/lifecycle.md`). Driving
the wrong booted device looks exactly like a broken flow.

## describe-ui is empty or sparse

If `axe describe-ui --udid <udid>` returns little or nothing, the app is **not addressable**:
elements are missing accessibility, so there is no handle or label to tap. This is a source
problem, not a driver problem; the app needs `accessibilityLabel` and `testID` set. See
**mobile-accessibility** for what makes a tree readable. Confirm the app (not a launcher or a
dialog) is in the foreground first.

## The app is not interactive yet

A launch or deep link returning is not the app being ready: a splash screen, a first JS
bundle still building, or a screen mid-transition accepts taps and drops them, and the
driver still reports success. The tell is a **sparse tree that then grows**: poll
`describe-ui` until the screen's own labels appear before the first tap (for Expo's Metro
and first-bundle gates, see **expo-ios-simulator** `references/development-builds.md`).
This cause looks identical to "describe-ui is empty" above; the difference is time. Rule
out "too early" before concluding "not addressable".

## A tap by label or id misses

- **By label**: labels are user-facing and drift with copy, locale, and SDK version. Re-run
  `describe-ui` and read the current `AXLabel`; do not trust a label from an earlier version.
- **By id**: if `--id` misses, the `testID` is unset or different from what you expect; read
  the current `AXUniqueId` from `describe-ui`. Prefer the id over the label once it exists
  (see **mobile-accessibility**).

## An overlay is intercepting taps

If taps stop reaching the app, or land somewhere other than the target, something is on
top of it:

- the **element-inspector** overlay (easy to toggle on by accident),
- the **stacking push-token alert** that darkens the screen after reloads,
- the **dev menu** or an "Open in app?" dialog,
- the **LogBox toast** covering the bottom of the screen (and its full-screen inspector,
  if the toast body got tapped), or
- the **software keyboard**, which floods the tree with per-key nodes and covers the lower
  half of the screen after any tap into a text field, or
- the **device's own chrome**: an element scrolled under the status bar at the top or the
  home-indicator band at the bottom reports a valid frame and accepts dispatch, yet the app
  never receives the gesture. Scroll it to mid-screen (**ios-simulator**
  `references/driving.md`, the dead-zone note).

The Expo overlays, and their recovery, are in **expo-ios-simulator**
`references/known-prompts.md`. The fastest check is the label inventory one-liner
(**ios-simulator** `references/driving.md`): alert buttons, dev-menu items, or a page of
single-letter key labels name the culprit immediately. Clear the overlay by accessibility,
then resume the flow.

## See also

- **ios-simulator** `references/driving.md`: `axe describe-ui`, `axe tap --id` / `--label`.
- **mobile-accessibility**: why an element is or is not addressable.
- **expo-ios-simulator** `references/known-prompts.md`: the overlays that block taps.
- `references/logging.md`: capturing a `describe-ui` dump as evidence of the tree's state.

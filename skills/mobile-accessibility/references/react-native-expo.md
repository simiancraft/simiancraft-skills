---
title: React Native / Expo accessibility
summary: accessibilityLabel/role/state/value/accessible and testID; the handle-vs-name distinction; how RN props map onto the native iOS tree
status: draft
sources:
  - https://reactnative.dev/docs/accessibility (accessible, accessibilityLabel, accessibilityRole, accessibilityState, accessibilityValue, accessibilityHint, and the isAccessibilityElement mapping)
  - https://reactnative.dev/docs/view (testID: "Used to locate this view in end-to-end tests")
  - "Observed (AXe v1.7.1 describe-ui): a view's testID surfaces as the element's accessibilityIdentifier (AXUniqueId)"
---

# React Native / Expo accessibility

Reference for **mobile-accessibility**. An Expo app is a React Native app; it has no
separate Expo accessibility API. You make an app addressable with React Native's
accessibility props, which map onto the native iOS fields in `references/ios-native.md`.

## The props

From the React Native accessibility docs (the cross-platform props; some are iOS- or
Android-only, noted where it matters):

- **`accessible`**: *"When `true`, indicates that the view is discoverable by assistive
  technologies such as screen readers and hardware keyboards."* On iOS this *"translates
  into native `isAccessibilityElement`"*; it decides whether the view is in the tree at all.
- **`accessibilityLabel`**: the name. *"A screen reader will verbalize this string when the
  associated element is selected,"* so VoiceOver and TalkBack users *"know what element they
  have selected."*
- **`accessibilityRole`**: the element's purpose. The documented values are `adjustable`,
  `alert`, `button`, `checkbox`, `combobox`, `grid`, `header`, `image`, `imagebutton`,
  `keyboardkey`, `link`, `menu`, `menubar`, `menuitem`, `none`, `progressbar`, `radio`,
  `radiogroup`, `scrollbar`, `search`, `spinbutton`, `summary`, `switch`, `tab`, `tablist`,
  `text`, `timer`, `togglebutton`, and `toolbar`.
- **`accessibilityState`**: the element's state, an object with the keys `disabled`,
  `selected`, `checked` (boolean or `'mixed'`), `busy`, and `expanded`.
- **`accessibilityValue`**: the current value, an object with the keys `min`, `max`, `now`,
  and `text`.
- **`accessibilityHint`**: extra context about the result of acting on the element.
- **`testID`**: *"Used to locate this view in end-to-end tests."* This is the **driving
  handle**.

(React Native also accepts web-aligned `aria-*` aliases, for example `aria-label` and
`aria-disabled`; the `accessibility*` props above are the canonical form.)

## The handle versus the name

`testID` and `accessibilityLabel` look interchangeable and are not:

- **`testID`** is the **handle** a driver should prefer: it does not change with copy or
  locale, and it is the documented e2e-location prop.
- **`accessibilityLabel`** is the **name** a human hears; it is localized and may change.

Driving by `testID` is stable; driving by label is the fallback when no `testID` exists.
This is the same handle-versus-name split Apple draws natively (see
`references/ios-native.md`).

## How RN props map to the native iOS tree

| React Native prop | Native iOS field | describe-ui key |
|---|---|---|
| `accessible` | `isAccessibilityElement` | (gates presence) |
| `accessibilityLabel` | `accessibilityLabel` | `AXLabel` |
| `accessibilityValue` | `accessibilityValue` | `AXValue` |
| `accessibilityRole` + `accessibilityState` | `accessibilityTraits` | `type` / `role` |
| `testID` | `accessibilityIdentifier` | `AXUniqueId` |

The `accessible` -> `isAccessibilityElement` mapping is stated in the RN docs. The
`testID` -> `accessibilityIdentifier` row is **observed** (an AXe `describe-ui` dump shows a
view's `testID` as the element's `AXUniqueId`); it is consistent with both sides' documented
purpose, RN's *"locate this view in end-to-end tests"* and Apple's automation identifier.
Confirm against `describe-ui` for your RN version rather than assuming it.

## See also

- `references/ios-native.md`: the native fields these props set, with Apple's definitions.
- `references/auditing.md`: checking that labels, roles, and states are present and correct.
- **expo-ios-simulator** `SKILL.md`: running the Expo app whose tree you are driving.

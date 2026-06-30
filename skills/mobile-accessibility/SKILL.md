---
name: mobile-accessibility
description: >-
  Make a mobile app driveable AND auditable through the accessibility tree, the
  shared dependency behind every tap-by-label interaction. One tree, two consumers
  reading different fields: driving reads the stable handle (testID ->
  accessibilityIdentifier); auditing reads the user-facing semantics (label, role,
  state, focus order). Covers iOS-native (UIAccessibility) and React Native / Expo
  (accessibilityLabel/role/state/accessible + testID) and how RN maps to the native
  tree. Prefer accessibility over coordinates. Referenced by ios-simulator and
  expo-ios-simulator for driving, and by the auditing skills for completeness.
status: draft
sources:
  - https://reactnative.dev/docs/accessibility (the React Native accessibility props)
  - https://reactnative.dev/docs/view (testID: "Used to locate this view in end-to-end tests")
  - https://developer.apple.com/documentation/uikit/uiaccessibilityidentification/accessibilityidentifier (the automation handle, distinct from the label)
  - https://developer.apple.com/documentation/uikit/uiaccessibilityelement/accessibilitylabel (the user-facing name)
---

# Mobile Accessibility (the shared trunk)

Why its own skill: the same tags serve two consumers (driving vs auditing); owning
them here keeps both DRY. Driving skills read the handle; auditing skills read the
semantics.

## The model: one tree, two readers

An accessible app exposes an **accessibility tree**: a hierarchy of elements that
assistive technology (VoiceOver) navigates, and that an automation driver (AXe) reads
to find and tap things. Every element can carry a few fields. Two of them matter most,
and they exist for **different** reasons:

| Field (iOS) | React Native prop | Who reads it | What it is for |
|---|---|---|---|
| `accessibilityIdentifier` | `testID` | the **driver** | a stable **handle** to find an element in a script |
| `accessibilityLabel` | `accessibilityLabel` | the **human** (VoiceOver) and the **auditor** | the element's **name**, spoken aloud |

Apple draws this line itself: an identifier lets a script *"uniquely identify an element"*
and thereby *"avoid inappropriately setting or accessing an element's accessibility label"*
(`accessibilityIdentifier` docs). React Native's `testID` is the same idea from the other
side: *"Used to locate this view in end-to-end tests."* The label, by contrast, is *"a
string that succinctly identifies the accessibility element"* for a user; Apple's example
is "Save," not "Save button."

So:

- **Driving** wants the handle. Prefer `testID` -> `accessibilityIdentifier`; it does not
  change when copy, locale, or layout changes. Tapping by visible label is the fallback
  when no handle exists. Coordinates are the last resort (brittle; see **ios-simulator**
  `references/driving.md`).
- **Auditing** wants the semantics: is there a label at all, is the role right, is the
  state (disabled, selected, checked) correct, is the focus order sane.

## Where to go

- iOS-native fields and how they surface to a driver: `references/ios-native.md`.
- React Native / Expo props and the RN -> native mapping: `references/react-native-expo.md`.
- The auditing lens (completeness, correctness): `references/auditing.md`.

## Rules

- Prefer the **handle** (`testID`) for driving; fall back to the label; avoid coordinates.
- A label names; an identifier handles. Do not overload one for the other (Apple's own warning).
- Every factual claim here and in the references cites a primary source (Apple, React
  Native, or AXe's own help); a prior-art skill is never a source.

## Out of scope

Web a11y -> future web-accessibility. Cross-platform auditing -> future accessibility.
Android specifics -> android-emulator-harness lineage.

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
status: scaffold
sources: []
---

# Mobile Accessibility (the shared trunk)

Why its own skill: the same tags serve two consumers (driving vs auditing); owning
them here keeps both DRY. Driving skills read the handle; auditing skills read the
semantics.


## Scope
TODO

## Out of scope
Web a11y -> future web-accessibility. Cross-platform auditing -> future accessibility.
Android specifics -> android-emulator-harness lineage.


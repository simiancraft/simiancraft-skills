---
title: iOS native accessibility
summary: the UIAccessibility fields a driver and an auditor read (isAccessibilityElement, accessibilityLabel, accessibilityValue, accessibilityTraits, accessibilityIdentifier), and how they surface in an AXe describe-ui dump
status: complete
sources:
  - https://developer.apple.com/documentation/uikit/uiaccessibilityelement/isaccessibilityelement (in or out of the tree)
  - https://developer.apple.com/documentation/uikit/uiaccessibilityelement/accessibilitylabel (the name)
  - https://developer.apple.com/documentation/uikit/uiaccessibilityelement/accessibilityvalue (the current value)
  - https://developer.apple.com/documentation/uikit/uiaccessibilityelement/accessibilitytraits (role and state)
  - https://developer.apple.com/documentation/uikit/uiaccessibilityidentification/accessibilityidentifier (the automation handle)
  - "AXe v1.7.1 describe-ui output keys (observed): AXLabel, AXValue, AXUniqueId, type, role"
---

# iOS native accessibility

Reference for **mobile-accessibility**. These are the UIKit fields that put an element
into the accessibility tree and describe it. A React Native / Expo app does not set them
directly; it sets the RN props in `references/react-native-expo.md`, which map onto these.
This file is the native target of that mapping, and what an AXe `describe-ui` dump is
actually showing you.

## Whether an element is in the tree

`isAccessibilityElement` is *"A Boolean value indicating whether the item is an
accessibility element an assistive application can access."* Its default is `false`, but
*"if the receiver is a UIKit control, the default value is `true`."* An element that is
not an accessibility element is invisible to both VoiceOver and a driver; there is nothing
to tap by label or id.

## The name: accessibilityLabel

*"A string that succinctly identifies the accessibility element."* Apple's guidance: the
label *"does not include the type of the control or view. For example, the label for a Save
button is 'Save,' not 'Save button.'"* Standard controls derive a label from their title;
a custom control needs one set explicitly, *"so that assistive applications can supply
accurate information to users."* This is the field VoiceOver speaks, and the field an
auditor checks for presence and correctness.

## The current value: accessibilityValue

*"A string that represents the current value of the accessibility element."* Use it *"only
when an accessibility element can have a value that is not represented by its label."*
Apple's example: a slider labelled "Volume" whose value is the current level. A Save button
needs no value; the label says everything.

## Role and state: accessibilityTraits

*"The combination of traits that best characterize the accessibility element."* Traits are
combined with an OR to describe an element's behavior, state, or usage (for example button,
link, header, selected, not-enabled). UIKit supplies an appropriate combination for standard
controls. This is where "is the role right, is the state correct" lives for an auditor.

## The automation handle: accessibilityIdentifier

*"A string that identifies the element,"* from the `UIAccessibilityIdentification` protocol
(*"Methods that associate a unique identifier with elements in your user interface."*). Its
purpose is automation, not users: *"An identifier can be used to uniquely identify an element
in the scripts you write using the UI Automation interfaces. Using an identifier allows you
to avoid inappropriately setting or accessing an element's accessibility label."* This is the
stable handle a driver prefers; it is not spoken by VoiceOver and is not part of the
user-facing semantics.

## How these surface to a driver

AXe's `describe-ui` dumps the tree as the driver sees it. The fields above appear under
stable keys (observed, AXe v1.7.1):

| Native field | describe-ui key | Used to |
|---|---|---|
| `accessibilityIdentifier` | `AXUniqueId` | tap by id: `axe tap --id "<id>" --udid <udid>` |
| `accessibilityLabel` | `AXLabel` | tap by label: `axe tap --label "<label>" --udid <udid>` |
| `accessibilityValue` | `AXValue` | assert or read a value |
| traits | `type` / `role` | filter by element kind |

Run `describe-ui` first, read the key, then drive by id or label; never guess coordinates.
The driving vocabulary is **ios-simulator** `references/driving.md`.

## See also

- `references/react-native-expo.md`: the RN / Expo props that set these native fields.
- `references/auditing.md`: checking the name, role, and state for correctness.
- **ios-simulator** `references/driving.md`: `axe describe-ui`, `axe tap --id` / `--label`.

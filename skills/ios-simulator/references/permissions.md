---
title: Simulator permissions
summary: grant, revoke, and reset app privacy permissions on a simulator with simctl privacy, including the services it covers and the ones it does not
status: draft
sources:
  - "xcrun simctl help privacy (actions, the service list, examples, and the Info.plist warning)"
  - https://developer.apple.com/documentation/xcode/running-your-app-in-the-simulator-or-on-a-device
---

# Simulator permissions

Reference for **ios-simulator**. `xcrun simctl privacy` grants, revokes, or resets an
app's privacy permissions on a device without the on-device prompt, which is how you
keep an automated flow from stalling on a permission dialog.

## Command

```bash
xcrun simctl privacy <udid|booted> <action> <service> [<app-bundle-id>]
```

## Actions

- `grant`, grant access without prompting. Requires a bundle id.
- `revoke`, revoke access, denying all use of the service. Requires a bundle id.
- `reset`, reset access so the app prompts on next use. Bundle id optional.

Some permission changes terminate the app if it is running.

## Services

`all`, `calendar`, `contacts-limited`, `contacts`, `location`, `location-always`,
`photos-add`, `photos`, `media-library`, `microphone`, `motion`, `reminders`, and
`siri`. `all` applies the action to every service. Re-run `xcrun simctl help privacy`
to confirm the list for your Xcode; it can change between versions.

## Examples

```bash
xcrun simctl privacy booted reset all                        # reset every permission
xcrun simctl privacy booted grant photos <app-bundle-id>     # pre-grant photo access
xcrun simctl privacy booted revoke location <app-bundle-id>  # deny location
```

## What this does not cover

That list is the complete service set of `simctl privacy`; permissions outside it
(for example camera and notifications) are not managed by this command. Granting a
permission also does not give the simulator a capability it physically lacks; the
simulator's hardware and delivery limits (no real camera frames, no remote push
delivery) are covered in **ios-simulator-flow-evidence** (the can't-do list).

## Warning

`simctl privacy` itself warns that applications normally must have valid `Info.plist`
usage-description keys and follow the API guidelines to request access to services,
and that using this command to bypass that can mask bugs.

In practice, prefer `grant` for test setup, not as a substitute for exercising the
real permission flow; a blanket `grant` hides a missing usage string or a request the
app never actually makes.

## See also

- `lifecycle.md`, launching the app you are granting permissions to.
- **ios-simulator-flow-evidence**, the simulator capability limits (push, camera).

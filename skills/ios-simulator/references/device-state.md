---
title: Device state and content
summary: put the simulated device into a known state and inject content by script (appearance, status bar, location, media, clipboard, keychain, and push); all scriptable simctl verbs, not menu-only affordances
status: draft
sources:
  - "xcrun simctl help status_bar | location | ui | addmedia | pbcopy | pbpaste | keychain | push (each verb's own usage; run to confirm the value sets)"
  - https://developer.apple.com/documentation/xcode/running-your-app-in-the-simulator-or-on-a-device
---

# Device state and content

Reference for **ios-simulator**. Beyond booting and driving, a flow often needs the device in a
known state: a fixed status bar for clean screenshots, a GPS coordinate, a seeded photo library,
dark mode. These are all **scriptable `simctl` verbs**, window-independent like the framebuffer;
they are not menu actions (see the note in `simulator-ui.md`). Discover the booted UDID per
`references/lifecycle.md`.

## Appearance (light / dark, contrast)

```bash
xcrun simctl ui <udid> appearance dark        # or light; no arg prints the current style
xcrun simctl ui <udid> increase_contrast enabled   # accessibility contrast; no arg prints state
```

Scriptable and deterministic; prefer this over the Simulator's Features menu. Relevant to
**mobile-accessibility** auditing (contrast) as well as dark-mode flows.

## Status bar overrides (deterministic screenshots)

```bash
xcrun simctl status_bar <udid> override \
  --time "9:41" --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --batteryState charged --batteryLevel 100
xcrun simctl status_bar <udid> list      # show current overrides
xcrun simctl status_bar <udid> clear     # remove them
```

`override` needs at least one flag; the full value sets (`--dataNetwork`, `--wifiMode`,
`--cellularMode`, `--batteryState`, and the `0-3` bar counts) are in `simctl status_bar` help.
This is the standard clean-screenshot setup (fixed 9:41 clock, full battery, no carrier jitter);
reach for it before capturing evidence (see **ios-simulator-flow-evidence** `references/screenshots.md`).

## Location (simulated GPS)

```bash
xcrun simctl location <udid> set <lat>,<lon>          # a fixed coordinate
xcrun simctl location <udid> list                     # built-in scenarios
xcrun simctl location <udid> run <scenario>           # e.g. a city run/drive scenario
xcrun simctl location <udid> start <lat1,lon1> <lat2,lon2> ...   # interpolate between waypoints
xcrun simctl location <udid> clear
```

`start` takes at least two waypoints and interpolates over time (`--speed` m/s, default 20;
`--distance`/`--interval` to control update cadence; `-` reads waypoints from stdin). This exercises
map, geofence, and "near me" UI. Setting a coordinate is separate from granting the location
**permission**; do both (see `references/permissions.md`).

## Seed the photo library and contacts

```bash
xcrun simctl addmedia <udid> photo1.jpg clip.mov card.vcf
```

`addmedia` imports photos, live photos (provide the paired photo and video), videos, and vCard
contacts. Use it to give an image-picker, upload, or share-sheet flow something to pick without a
real camera; pair it with the `photos` permission (`references/permissions.md`).

## Clipboard

```bash
echo "seed text" | xcrun simctl pbcopy <udid>   # host stdin -> device pasteboard
xcrun simctl pbpaste <udid>                      # device pasteboard -> host stdout
```

`pbcopy` seeds a paste-into-field input (and sidesteps `axe type`'s US-keyboard HID limit);
`pbpaste` asserts a copy-to-clipboard behavior in a flow.

## Push a simulated notification

```bash
xcrun simctl push <udid> <bundle-id> payload.apns   # or '-' to read the JSON from stdin
```

The payload is APNs JSON with an `aps` key (4096-byte cap); a top-level `Simulator Target Bundle`
key can carry the bundle id instead of the argument. This delivers a **simulated** remote push to
test notification-handling UI on the simulator; it is not a real APNs device token (see
**expo-ios-simulator** `references/known-prompts.md`). Discover `<bundle-id>` from the app config.

## Keychain (test isolation, trusted certs)

```bash
xcrun simctl keychain <udid> reset               # clear stored credentials between runs
xcrun simctl keychain <udid> add-root-cert <path>   # trust a local TLS proxy's root
xcrun simctl keychain <udid> add-cert <path>
```

`reset` isolates a run from a prior run's stored credentials; `add-root-cert` lets a flow trust a
local debugging proxy.

## See also

- `references/permissions.md`: grant the permission; this file sets the state behind it.
- `references/lifecycle.md`: discovering the booted UDID; provisioning and boot-ready checks.
- **ios-simulator-flow-evidence** `references/screenshots.md`: status-bar overrides for clean captures.
- `references/simulator-ui.md`: which affordances are genuinely menu-only versus scriptable here.

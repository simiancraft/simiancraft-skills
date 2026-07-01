---
title: Driving the UI
summary: tap, type, swipe, run preset gestures, key combos, and hardware-button presses via AXe, addressing elements by accessibility id or label before coordinates
status: draft
sources:
  - "axe describe-ui --help, axe tap --help, axe type --help, axe swipe --help, axe gesture --help, axe key-combo --help, axe button --help (AXe per-subcommand surface; run to confirm for your version)"
  - "axe describe-ui output (the AXUniqueId / AXLabel / AXValue / type key names)"
  - https://github.com/cameroncooke/AXe
---

# Driving the UI

Reference for **ios-simulator**. Drive the simulator with **AXe** (installed per
`../prerequisites.md`), which acts through the accessibility tree. The rule:
**address elements by accessibility identity, not coordinates.** Labels and ids are
stable; pixel coordinates are brittle. See **mobile-accessibility** for what makes an
app addressable (the accessibilityIdentifier-as-handle versus accessibilityLabel-as-name
distinction); this file is the command vocabulary.

Every AXe command needs `--udid <udid>` (discover it in `lifecycle.md`).

## Find what to target: describe-ui

```bash
axe describe-ui --udid <udid>                # dump the accessibility hierarchy
axe describe-ui --udid <udid> --point <x,y>  # only the element at x,y
```

The output is JSON; each node carries `AXUniqueId` (the accessibilityIdentifier),
`AXLabel` (the accessibilityLabel), `AXValue`, and `type`. Read these before tapping.
A tap that "can't find" an element is an absent or mislabeled node here, not a flaky
tap.

## Tap

Prefer identity over coordinates:

```bash
axe tap --id <accessibility-id> --udid <udid>      # by AXUniqueId (accessibilityIdentifier, the stable handle)
axe tap --label <accessibility-label> --udid <udid> # by AXLabel (accessibilityLabel, the visible name)
axe tap --value <value> --udid <udid>              # by AXValue (the current value of a control)
axe tap -x <x> -y <y> --udid <udid>                # by coordinate; ignores --id/--label/--value when both -x and -y are given
```

`--element-type <type>` (e.g. `Button`, `TextField`, `Switch`) narrows an ambiguous
id/label/value match. `--wait-timeout <seconds>` with `--poll-interval <seconds>`
waits for the element to appear; `--pre-delay` and `--post-delay` pad timing. When you
must use `-x -y`, derive the device coordinate from a screenshot fraction times the
device scale (see `capture.md` and `lifecycle.md`); no window math, no full-screen.

## Type

```bash
axe type "some text" --udid <udid>
echo "from stdin" | axe type --stdin --udid <udid>
axe type --file text.txt --udid <udid>
```

Tap the field first so it has focus. **US-keyboard characters only** (a HID limit):
`A-Z`, `a-z`, `0-9`, and the symbols `!@#$%^&*()_+-={}[]|\:";'<>?,./` plus `` ` `` and
`~`. International and accented characters (£, é, ñ) are not supported.

## Swipe and preset gestures

```bash
axe swipe --start-x <x1> --start-y <y1> --end-x <x2> --end-y <y2> --udid <udid>   # explicit path
axe gesture scroll-down --udid <udid>                                            # coordinate-free preset
axe gesture swipe-from-left-edge --screen-width <w> --screen-height <h> --udid <udid>
```

`gesture` presets are `scroll-up`, `scroll-down`, `scroll-left`, `scroll-right`,
`swipe-from-left-edge`, `swipe-from-right-edge`, `swipe-from-top-edge`, and
`swipe-from-bottom-edge`. Both `swipe` and `gesture` accept `--duration` and
`--delta`; edge gestures take the screen size.

## Key combos and hardware buttons

```bash
axe key-combo --modifiers 227 --key 4 --udid <udid>   # Cmd+A (modifier 227 = Left Command, key 4 = A)
axe button home --udid <udid>                          # hardware button
```

`key-combo` holds the modifier keycode(s), presses `--key`, then releases in reverse
order. Left-hand modifier keycodes are `224` Control, `225` Shift, `226` Alt/Option,
`227` Command; `228`-`231` are the right-hand variants. `button` presses a hardware
button: `apple-pay`, `home`, `lock`, `side-button`, or `siri`, with optional
`--duration`.

## When AXe is unavailable

The no-install fallback drives by **screen** coordinate with `cliclick`, mapping a
device fraction onto the Simulator window:

1. Read the live window bounds (the `osascript` line in `simulator-ui.md`).
2. Map a device fraction (from a screenshot, see `capture.md`) into that rect,
   allowing for the window title bar.
3. Click it: `cliclick c:<screen-x>,<screen-y>`.

It is coordinate-only and breaks if the window moves or resizes, so re-read the bounds
before each click and prefer AXe whenever it can be installed.

## See also

- **mobile-accessibility**: what makes elements addressable (`--id` versus `--label`).
- `capture.md` and `lifecycle.md`: deriving a device coordinate for the `-x -y` fallback.
- `simulator-ui.md`: reading the live window bounds the coordinate fallback maps onto.

---
title: Driving the UI
summary: tap, type, swipe, run preset gestures, key combos, and hardware-button presses via AXe, addressing elements down the targeting ladder (id, label, value, derived coordinate)
status: complete
sources:
  - "axe describe-ui --help, axe tap --help, axe type --help, axe slider --help, axe swipe --help, axe gesture --help, axe key-combo --help, axe button --help, axe touch --help, axe batch --help (AXe per-subcommand surface; run to confirm for your version)"
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

## Dispatch is not confirmation

AXe synthesizes HID events: a command confirms the event was **dispatched**, not that the app
**processed** it. A tap can land before the screen is interactive or mid-transition and silently
do nothing, yet still report success. So when the outcome matters, **verify it**: re-run
`describe-ui`, or capture a screenshot and read it, and confirm the state actually changed. This is
why a green run can still be wrong, and why the wait flags below exist.

## Find what to target: describe-ui

```bash
axe describe-ui --udid <udid>                # dump the accessibility hierarchy
axe describe-ui --udid <udid> --point <x,y>  # only the element at x,y
```

The output is JSON; each node carries `AXUniqueId` (the accessibilityIdentifier),
`AXLabel` (the accessibilityLabel), `AXValue`, and `type`, plus its rectangle twice:
`AXFrame` (a display string) and `frame` (an object with `x`, `y`, `width`, and `height`;
use this one for arithmetic). Read these before tapping.
A tap that "can't find" an element is an absent or mislabeled node here, not a flaky
tap. On a dense screen the full dump is large; narrow it with `--point`, or filter the JSON for
the node you want by label or id (substring, optionally by type):

```bash
axe describe-ui --udid <udid> | jq '.. | objects | select(.AXLabel? and (.AXLabel | test("Save"; "i")))'
```

To orient on an unfamiliar screen before targeting anything, dump its whole label
inventory (one line per unique label) and read that instead of the raw JSON:

```bash
axe describe-ui --udid <udid> | jq -r '[.. | objects | select(.AXLabel? != null) | .AXLabel] | unique | .[]'
```

## The targeting ladder

Target every element by working down this ladder; each rung's failure names the next rung:

1. **`--id`** (`AXUniqueId`, the accessibilityIdentifier): the stable handle. Absent from
   the tree → the app never set a `testID`; that is a source gap (**mobile-accessibility**),
   so drop a rung.
2. **`--label`** (`AXLabel`, the accessibilityLabel): the visible name. Drifts with copy and
   locale; ambiguous → narrow with `--element-type`, still ambiguous → drop a rung.
3. **`--value`** (`AXValue`): what the control currently shows. An input with no id and no
   label is still targetable by its placeholder or current text.
4. **Coordinates, derived, never guessed**: the element's own `frame` object from
   `describe-ui` (its center, or an offset for a sub-control inside it), or a screenshot
   fraction times the device scale (`capture.md`).

A node visible in `describe-ui` can always be hit by rung 4, because every node carries its
`frame`; a node absent from `describe-ui` cannot be hit by any rung until the overlay
hiding it is cleared or the app exposes it (**mobile-accessibility**).

## Tap

The ladder above, as flags:

```bash
axe tap --id <accessibility-id> --udid <udid>      # by AXUniqueId (accessibilityIdentifier, the stable handle)
axe tap --label <accessibility-label> --udid <udid> # by AXLabel (accessibilityLabel, the visible name)
axe tap --value <value> --udid <udid>              # by AXValue (the current value of a control)
axe tap -x <x> -y <y> --udid <udid>                # by coordinate; ignores --id/--label/--value when both -x and -y are given
```

`--element-type <type>` (e.g. `Button`, `TextField`, `Switch`) narrows an ambiguous
id/label/value match; if a `--label` still matches several nodes and none carry an `AXUniqueId`,
fall back to `-x -y` for that one step. `--wait-timeout <seconds>` with `--poll-interval <seconds>`
waits for the element to appear; `--pre-delay` and `--post-delay` pad timing. A `Switch`
or toggle that will not flip under the default tap usually needs `--tap-style physical`;
the default `automatic` already uses a physical touch for switches and a simulator tap
elsewhere. When you
must use `-x -y`, derive the device coordinate from a screenshot fraction times the
device scale (see `capture.md` and `lifecycle.md`); no window math, no full-screen.

**Long-press and double-tap** have no dedicated verb. A long press is a `touch` down-and-up with a
hold at the element's point (read the point from `describe-ui`); a double-tap is two quick `tap`s
at the same target:

```bash
axe touch -x <x> -y <y> --down --up --delay 1.0 --udid <udid>   # long press (hold 1s)
```

## Type

```bash
axe type "some text" --udid <udid>
echo "from stdin" | axe type --stdin --udid <udid>
axe type --file text.txt --udid <udid>
```

Tap the field first so it has focus. **US-keyboard characters only** (a HID limit):
`A-Z`, `a-z`, `0-9`, and the symbols `!@#$%^&*()_+-={}[]|\:";'<>?,./` plus `` ` `` and
`~`. International and accented characters (£, é, ñ) are not supported.

## Set a slider

```bash
axe slider --label <accessibility-label> --value <0-100> --udid <udid>
```

`slider` sets a slider to a percentage from 0 to 100 by accessibility (`--id` or `--label`),
which is deterministic where a bare `swipe` across the track is not. AXe also has lower-level
`drag`, `touch`, `key`, and `key-sequence` for cases the higher-level verbs do not cover.

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

## Batch a flow in one session

For a multi-step flow, `batch` runs an ordered sequence of steps in a **single HID session** (one
process, one continuous input session), which is faster and steadier than spawning `axe` per step:

```bash
axe batch --udid <udid> \
  --step "tap --label 'Sign in'" \
  --step "type 'user@example.com'" \
  --step "sleep 1" \
  --step "tap --label 'Continue'"
axe batch --udid <udid> --file steps.txt      # one step per line; or --stdin
```

Steps may be `tap`, `swipe`, `gesture`, `touch`, `type`, `button`, `key`, `key-sequence`, and
`key-combo`, plus a batch-only `sleep <seconds>` pseudo-step; step lines omit `--udid`. It does
**not** run `slider`, `drag`, `describe-ui`, `screenshot`, or video, so keep those as separate
calls. `--wait-timeout` with `--poll-interval` makes the batch wait for an element that only
appears after a navigation step, the resilient way to script a multi-screen flow;
`--continue-on-error` keeps going past a failed step (default is fail-fast); `--ax-cache
perBatch|perStep|none` controls how often the accessibility snapshot refreshes between selector
taps. Dispatch is still not confirmation, so verify the end state after the batch.

## When AXe is unavailable

The no-install fallback drives by **screen** coordinate with `cliclick`, mapping a
device fraction onto the Simulator window:

1. Read the live window bounds (the `osascript` line in `simulator-ui.md`).
2. Map a device fraction (from a screenshot, see `capture.md`) into that rect,
   allowing for the window title bar.
3. Click it: `cliclick c:<screen-x>,<screen-y>`.

It is coordinate-only and breaks if the window moves or resizes, so re-read the bounds
before each click and prefer AXe whenever it can be installed. The Simulator's Window menu
(Physical Size, Point Accuracy, Pixel Accuracy) changes the window's content scale without
changing the framebuffer, so a coordinate computed from window bounds can be off under a
non-default mode; AXe drives the framebuffer directly and is unaffected, a second reason to
prefer it.

## See also

- **mobile-accessibility**: what makes elements addressable (`--id` versus `--label`).
- `capture.md` and `lifecycle.md`: deriving a device coordinate for the `-x -y` fallback.
- `simulator-ui.md`: reading the live window bounds the coordinate fallback maps onto.

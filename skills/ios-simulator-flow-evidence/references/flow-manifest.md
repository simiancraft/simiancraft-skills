---
title: Flow manifest
summary: the manifest.json schema tying each driven step to its artifact and the state it proves, including a device-only list for what the simulator cannot show
status: complete
sources:
  - "the manifest is a convention this skill defines; artifact paths reference the formats in artifact-contract.md (PNG, MP4/MOV)"
---

# Flow manifest

Reference for **ios-simulator-flow-evidence**. The manifest is the bundle's index: a small
JSON file that lets a reviewer (or the **prove-work-on-github** skill) understand what
each artifact proves **without re-running the flow**. It lives at the bundle root as
`manifest.json` (see `references/artifact-contract.md`).

## The shape

```json
{
  "flow": "sign-in",
  "device": { "udid": "<udid>", "name": "<device name>" },
  "steps": [
    {
      "index": 1,
      "action": "launch the app",
      "artifact": "screenshots/01-launch.png",
      "expected": "splash, then the sign-in screen",
      "verified": true
    },
    {
      "index": 2,
      "action": "tap Sign in",
      "artifact": "screenshots/02-signed-in.png",
      "expected": "the home screen with the signed-in user",
      "verified": true
    }
  ],
  "video": "video/flow.mp4",
  "deviceOnly": ["push delivery"]
}
```

## The fields

- **`flow`**: the flow name, matching the bundle directory.
- **`device`**: the `udid` and human-readable `name` the flow ran on (discover the booted
  UDID per **ios-simulator** `references/lifecycle.md`).
- **`steps[]`**: one entry per driven step:
  - **`index`**: the step's order, matching the screenshot's `NN` prefix.
  - **`action`**: what was driven (the tap, type, or gesture).
  - **`artifact`**: the bundle-relative path to that step's screenshot.
  - **`expected`**: the concrete state the step should produce.
  - **`verified`**: whether the artifact was confirmed to show `expected` (the
    vision-verification from `references/screenshots.md`). A step with `verified: false` is a
    recorded gap, not a pass.
- **`video`**: the bundle-relative path to the recording, or omitted if none.
- **`deviceOnly`**: the parts of the flow a simulator cannot prove (push delivery, real
  camera or microphone, a phone call, true network conditions; see the honest can't-do list in
  `SKILL.md`). Naming them here keeps the bundle from implying coverage it does not have.

## Why it earns its place

The manifest is what turns a folder of PNGs into evidence: it states what each shot was
supposed to show and whether it did, and it is honest about what the simulator left
uncovered. Write it as you capture, not after, so `expected` reflects the intent of the step
rather than a rationalization of the image.

## See also

- `references/artifact-contract.md`: where the manifest sits in the bundle.
- `references/screenshots.md`: the `verified` check the manifest records.
- **ios-simulator** `references/lifecycle.md`: discovering the booted UDID and device name.

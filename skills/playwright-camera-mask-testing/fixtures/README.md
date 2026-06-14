# Fixtures

## person-web.png

640x480 webcam-shaped frame: full-body subject centered, ~82% of frame height,
opaque light-gray ground (`#CDD0D4`). Feed it to Chromium as a `.y4m` (see
SKILL.md); selfie segmentation reads it as a person at typical webcam framing.

Derived from `android-emulator-mask-testing/fixtures/person-framed.png`
(1080x1920, subject deliberately at x=0.25W to cancel the Android emulator's
sensor shift; web has no such shift, so the subject is recentered here):

```bash
ffmpeg -i ../../android-emulator-mask-testing/fixtures/person-framed.png \
  -vf "crop=540:940:0:640,scale=264:460,pad=640:480:188:10:color=0xCDD0D4" \
  person-web.png
```

To swap in your own subject, match the shape: landscape 4:3 or 16:9, even
dimensions, subject centered at 50-85% of frame height, opaque contrasting
background (the background is what gets replaced, so it must read as
not-person).

## office-empty.png

1280x720 empty office: desks, chairs, plants, windows, hard sun shadows; no
people. The guaranteed-clean no-person feed: use it when an effect (blur,
whole-frame behavior, scene-only flows) must be asserted without a person,
real or spurious, in the mask. Chosen because it does NOT false-positive;
validated against MediaPipe Selfie Segmentation: at threshold 0.75 nothing in it
segments (no phantom cutout; replacement covers the full frame, blur is uniform).

Downscaled (cover-crop) from a 1456x816 source:

```bash
ffmpeg -i <source>.png \
  -vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720" \
  office-empty.png
```

Mind the y4m size at this resolution: 1280x720 x 1.5 bytes x 30 frames ≈ 41 MB
in /tmp per run.

## Provenance and license

`person-web.png` is a reframed crop of `person-framed.png` from the sibling
android-emulator-mask-testing skill (published in this same marketplace), which is
original work by [simiancraft](https://github.com/simiancraft) under the
repository's MIT license, with no third-party material, stock-photo licensing, or
model-release encumbrance; the figure is a constructed test subject, not a
photograph of a real person. The derived `person-web.png` carries the same MIT
terms. Reuse, modify, or swap in your own subject under MIT.

`office-empty.png` is a simiancraft-generated image (Midjourney, under a paid
subscription, from a simiancraft prompt); it depicts no people and includes no
third-party source material, and is published under the repository's MIT license.

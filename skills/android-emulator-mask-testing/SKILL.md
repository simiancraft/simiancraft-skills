---
name: android-emulator-mask-testing
description: >-
  Specialization of android-emulator-harness for CAMERA / segmentation testing:
  get a real PERSON in front of the emulator camera so MediaPipe / ML Kit selfie
  segmentation produces an actual mask, then verify background-replacement / blur /
  shader effects and tune mask threshold by vision. Use when the task is "test the
  mask", "verify segmentation", "tune mask threshold", "check a camera/background
  effect on Android", or any time an app must SEE a human through the emulator camera
  without a physical device. Read android-emulator-harness FIRST for bring-up, drive,
  and assert; this skill only overrides the camera-specific pieces. Validated on
  Linux/WSL with a 32-bit x86 emulator image and MediaPipe/ML Kit segmentation.
---

# Camera / Mask Testing: specialization of android-emulator-harness

**Read `android-emulator-harness` first.** That base covers KVM, AVD creation,
headless boot, app install/launch, Maestro driving, logcat/screenshot assertion,
and teardown. This skill changes only what's needed to put a segmentable human in
the camera and run GPU segmentation. Everything else (drive with Maestro, assert on
logcat + screenshot) is identical to the base.

This skill ships two fixtures alongside it: **`fixtures/person.png`** (a full-body
subject on a transparent background, the raw asset) and **`fixtures/person-framed.png`**
(the same subject pre-positioned for the emulator's camera-feed crop; see "Version
note"). Use them directly, or swap in your own subject of the same shape.

## The three camera-specific overrides (each cost real debugging time)

1. **Use a 32-bit `x86` system image, NOT the base's `x86_64`.** MediaPipe Tasks
   Vision ships `libmediapipe_tasks_vision_jni.so` for `arm64-v8a`, `armeabi-v7a`,
   and `x86`, **not `x86_64`**. On x86_64 it fails with `UnsatisfiedLinkError` and
   segmentation silently falls through to the raw frame. API 30 is the highest
   32-bit x86 `google_apis` image. Verify in the APK: `unzip -l app.apk | grep mediapipe`
   (expect a `lib/x86/…` entry).
   ```bash
   yes | "$SDKMGR" "system-images;android-30;google_apis;x86"
   echo no | "$AVDMGR" create avd -n harness_x86 -k "system-images;android-30;google_apis;x86" -d pixel_3 --force
   ```

2. **Boot with `-gpu swangle_indirect`, NOT the base's `swiftshader_indirect`.**
   MediaPipe runs through TFLite's GPU delegate, which needs **GLES 3.1 compute
   shaders**. Raw SwiftShader is only GLES 3.0 → `[GL_INVALID_ENUM] glCreateShader`
   in `TensorsToSegmentationCalculator`. `swangle` (ANGLE over SwiftShader-Vulkan)
   exposes GLES 3.1. Confirm after boot; this is the make-or-break check:
   ```bash
   adb shell dumpsys SurfaceFlinger | grep -m1 "GLES:"   # MUST say "OpenGL ES 3.1 ... ANGLE"
   ```

3. **Put a person in the scene via the virtualscene wall poster.** Older emulator
   builds have no `-camera-back imagefile:`/`videofile:` (a recent addition; see
   "Version note"); their modes are `emulated/webcam<N>/virtualscene/videoplayback/none`.
   The headless virtualscene camera pose is NOT settable (telnet `sensor set` is
   ignored; only the gRPC physical model moves it), so **move the poster into the
   camera's fixed view, not the camera**. Camera sits near origin looking down −Z.
   ```bash
   # this skill ships fixtures/person.png (full-body subject, transparent bg, ~2:3)
   cp fixtures/person.png /tmp/android-harness/person.png
   cp "$SDK/emulator/resources/Toren1BD.posters" "$SDK/emulator/resources/Toren1BD.posters.bak" 2>/dev/null || true
   cat > "$SDK/emulator/resources/Toren1BD.posters" <<'EOF'
poster wall
size 2 3
position 0 0 -3.0
rotation 0 0 0
default poster.png

poster table
size 1 1
position -2.205 -0.077 3.949
rotation -90 0 120
EOF
   ```
   Framing: `position 0 0 -1.5` = closer/bigger (midsection); `-3.0` = full body.
   `size W H` in metres ≈ image aspect. Use the **`wall`** anchor (guaranteed to
   render; arbitrary poster names may not).

## Full launch (base boot + the three overrides)

```bash
sg kvm -c "nohup $EMU -avd harness_x86 \
  -no-window -no-audio -no-boot-anim -no-snapshot \
  -gpu swangle_indirect \
  -camera-back virtualscene \
  -virtualscene-poster wall=/tmp/android-harness/person.png \
  -accel on -port 5554 > /tmp/android-harness/emulator.log 2>&1 &"
# then base boot-wait, then dumpsys SurfaceFlinger GLES check MUST be 3.1/ANGLE
```

`-virtualscene-poster wall=<file>` sets the poster IMAGE without editing resources;
the `.posters` file only sets geometry. `-no-snapshot` forces a clean boot so
poster changes take effect.

## Asserting the mask (beyond the base's logcat gate)

Add these to the base's HARD logcat gate (all must be ABSENT):
`UnsatisfiedLink`, `GL_INVALID_ENUM`, `glCreateShader`, `CalculatorGraph::Run() failed`.

Then drive an effect (Maestro: `tapOn: "Dark Office"`) and Read the screenshot. A
working mask shows the **person kept** and the background **replaced**. Failure
modes: unchanged room (segmentation fell through) or person gone (empty mask). For
threshold tuning, iterate the app's maskThreshold/hardness controls and re-Read.

## What this adds to the base's scope

- **CAN now also validate:** mask SHAPE + compositing (person carved, bg swapped).
- **Still CANNOT:** temporal mask quality (flicker/edge stability) from a STATIC
  poster; that needs a moving subject. Path to motion: the version note below.

## Version note: the direct camera-feed path (recent emulator builds)

Recent emulator builds add official direct camera feeds, which remove the poster hack
entirely. Confirm support with `"$EMU" -help-camera-back` (look for `imagefile:` /
`videofile:`):
- `-camera-back imagefile:<abs>/fixtures/person-framed.png` for a full-frame static
  subject.
- `-camera-back videofile:<abs>/subject.mp4` for a full-frame **moving** subject; the
  right tool for temporal mask testing (flicker/edge stability).

Feed the **pre-framed** image (`fixtures/person-framed.png`), not the bare cutout. The
emulator's imagefile-to-sensor path does not present the image 1:1; it crops and shifts,
so a subject centered in the source lands off to the right with the head clipped.
Pre-compensate in the source. The working framing that lands the subject centered and
fully in frame:
- **Frame:** 9:16 portrait (e.g. 1080 x 1920).
- **Subject height:** ~0.42 of the frame height (full body, not a close-up).
- **Subject center:** x = **0.25 W**, y = **0.58 H**. The left-quarter x is deliberate;
  it cancels the sensor path's rightward shift so the subject reads centered on screen.
- **Background:** opaque and contrasting (a light neutral gray works); segmentation
  needs a clean figure/ground split, and the background is what gets replaced.

These offsets are emulator/AVD/version specific: feed the image, select no effect to see
the raw camera preview, screenshot it, and nudge the subject's x-center until it reads
centered before trusting a run. Regenerate `person-framed.png` from `fixtures/person.png`
(the bare transparent subject) if your AVD crops differently.

Upgrade: `yes | "$SDKMGR" emulator`, then re-check `"$EMU" -help-camera-back`.

## Teardown (restore resources)

```bash
adb -s emulator-5554 emu kill
cp "$SDK/emulator/resources/Toren1BD.posters.bak" "$SDK/emulator/resources/Toren1BD.posters" 2>/dev/null || true
```

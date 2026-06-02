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

This skill ships one fixture: **`fixtures/person-framed.png`**, a full-body subject
pre-positioned for the emulator's camera-feed crop (see override 3). Feed it directly,
or swap in your own subject framed the same way.

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

3. **Feed the framed subject straight into the camera (`-camera-back imagefile:`).**
   A recent emulator presents a still image as the back camera. Confirm support first
   (`"$EMU" -help-camera-back` lists `imagefile:` / `videofile:`); upgrade if missing
   (`yes | "$SDKMGR" emulator`). Feed the **pre-framed** image, not a bare cutout: the
   imagefile-to-sensor path does not present the image 1:1; it crops and shifts, so a
   subject centered in the source lands off to the right with the head clipped.
   `fixtures/person-framed.png` is pre-compensated. The framing that lands the subject
   centered and fully in frame:
   - **Frame:** 9:16 portrait (e.g. 1080 x 1920).
   - **Subject height:** ~0.42 of the frame height (full body, not a close-up).
   - **Subject center:** x = **0.25 W**, y = **0.58 H**. The left-quarter x is
     deliberate; it cancels the sensor path's rightward shift so the subject reads
     centered on screen.
   - **Background:** opaque and contrasting (a light neutral gray works); segmentation
     needs a clean figure/ground split, and the background is what gets replaced.

   These offsets are emulator/AVD/version specific. Calibrate once: feed the image,
   select no effect to see the raw camera preview, screenshot it, and nudge the
   subject's x-center until it reads centered before trusting a run. To re-frame for a
   different crop, recompose from your own transparent subject using the offsets above.

## Full launch (base boot + the three overrides)

```bash
sg kvm -c "nohup $EMU -avd harness_x86 \
  -no-window -no-audio -no-boot-anim -no-snapshot \
  -gpu swangle_indirect \
  -camera-back imagefile:$PWD/fixtures/person-framed.png \
  -accel on -port 5554 > /tmp/emulator.log 2>&1 &"
# then base boot-wait, then dumpsys SurfaceFlinger GLES check MUST be 3.1/ANGLE
```

`-no-snapshot` forces a clean boot so the camera feed takes effect. Pass an absolute
path to the imagefile; the example uses `$PWD` assuming you launch from the skill dir.

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
  image; that needs motion. Use `-camera-back videofile:<abs>/subject.mp4` for a
  full-frame moving subject when you need to test edge stability over time.

## Older emulators without `imagefile:`

Builds whose `-help-camera-back` lacks `imagefile:` can still put a subject in view via
the `virtualscene` wall poster. The headless camera pose is not settable (telnet
`sensor set` is ignored; only the gRPC physical model moves it), so move the poster
into the camera's fixed view (camera sits near origin looking down −Z): feed your own
transparent full-body cutout as `-camera-back virtualscene -virtualscene-poster wall=<subject.png>`
and set geometry in `$SDK/emulator/resources/Toren1BD.posters` (back it up first; the
`wall` anchor is guaranteed to render). Upgrading the emulator to get `imagefile:` is
simpler; prefer that.

## Teardown

```bash
adb -s emulator-5554 emu kill
# only if you used the virtualscene fallback and edited resources:
# cp "$SDK/emulator/resources/Toren1BD.posters.bak" "$SDK/emulator/resources/Toren1BD.posters" 2>/dev/null || true
```

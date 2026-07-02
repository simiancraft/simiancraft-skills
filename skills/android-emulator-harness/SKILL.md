---
name: android-emulator-harness
description: >-
  Bring up an Android app in a headless emulator on Linux/WSL and drive it for
  automated integration testing, the Android analog of Playwright for web.
  Boots an AVD under KVM, installs an APK (standalone or dev-client+Metro), drives
  the UI with Maestro (resilient tap-by-label/wait/assert), and gates on logcat +
  screenshots that come back for inspection. Use for ANY Android/Expo/React-Native
  project (not just one app) when the task is "run the app on an emulator", "drive
  the Android UI", "smoke-test a screen", "reproduce a tap-and-crash", "automate an
  Android flow", or "set up Android UI testing". Project-agnostic base; layer a
  domain skill on top for specialized inputs (see android-emulator-mask-testing for
  camera/segmentation). Validated on Linux/WSL with KVM, Maestro 2.x, and JDK 17.
---

# Android Emulator Harness (headless, WSL/Linux, Maestro-driven)

Specializations (e.g. camera/mask) sit ON TOP of this kernel and override only the
parts they must.

> **Runtime/package manager.** Examples use `bun`/`bunx`; substitute your own
> runner (`npm`/`npx`, `pnpm`/`pnpm dlx`, or `yarn`) wherever they appear. The
> Android tooling itself (`adb`, `emulator`, Maestro, the JDK) is unaffected.

## Environment gotchas (verify once per machine)

- **KVM group.** x86/x86_64 emulation needs `/dev/kvm`; the user must be in the
  `kvm` group: `sudo gpasswd -a $USER kvm` (needs a real terminal for the password).
  No relogin if you launch under `sg kvm -c "..."`. Symptom if missing:
  `x86_64 emulation currently requires hardware acceleration!`.
- **JDK 17 must be the *active* `java`** for `sdkmanager`/`avdmanager`/Maestro. Maestro
  2.x aborts on Java 8 with `ERROR: Java 17 or higher is required`; it reads the
  `java` on PATH, so exporting `JAVA_HOME` alone is not enough; prepend it to PATH.
  Symptom: bare `~/.maestro/bin/maestro --version` fails until you do.
- **EAS builds/artifacts.** If `eas` isn't on PATH, install `eas-cli` and use it
  directly, or use the Expo MCP `mcp__expo-mcp__*` tools if your host provides them.
- **GPU.** Under WSL there is usually no GPU passthrough (`/dev/dri` absent); on
  native Linux you may have one. Either way the default software GLES is fine for
  UI/logic; only GPU-compute workloads (e.g. MediaPipe) need the `swangle` override,
  which the specialized camera skill covers.
- **Resolve binaries explicitly** and put JDK 17 on PATH; don't trust a stale PATH
  `emulator` or the system `java`. This one block gets you to an operating state:
  ```bash
  # ANDROID_HOME varies by OS: Linux (Android Studio default) $HOME/Android/Sdk, macOS $HOME/Library/Android/sdk
  export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
  # JDK 17 home is OS/distro-specific; point this at wherever your JDK 17 lives.
  #   Debian/Ubuntu: /usr/lib/jvm/java-17-openjdk-amd64   macOS: $(/usr/libexec/java_home -v 17)
  export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
  export PATH="$JAVA_HOME/bin:$PATH"          # so Maestro's wrapper sees Java 17
  SDK="$ANDROID_HOME"; EMU="$SDK/emulator/emulator"; ADB="$SDK/platform-tools/adb"
  # modern SDKs install to cmdline-tools/latest/bin; older/hand-installed to cmdline-tools/tools/bin
  CLT="$(ls -d "$SDK"/cmdline-tools/latest/bin 2>/dev/null || ls -d "$SDK"/cmdline-tools/*/bin 2>/dev/null | head -1)"
  SDKMGR="$CLT/sdkmanager"; AVDMGR="$CLT/avdmanager"
  MAESTRO="$HOME/.maestro/bin/maestro"
  # preflight: java -version → 17; $ADB version; $MAESTRO --version → 2.x
  ```

## 1. Create an AVD (one-time)

Default to **x86_64** (faster under KVM, widest native-lib coverage). Use 32-bit
`x86` ONLY when a required native lib lacks an x86_64 variant (see
android-emulator-mask-testing).

```bash
yes | "$SDKMGR" "system-images;android-34;google_apis;x86_64" "platforms;android-34"
# device profile must exist in this SDK's catalog; pixel_3 is safe on older SDKs, pixel_6 on newer
echo no | "$AVDMGR" create avd -n harness -k "system-images;android-34;google_apis;x86_64" -d pixel_6 --force
```

## 2. Boot headless under KVM

```bash
sg kvm -c "nohup $EMU -avd harness \
  -no-window -no-audio -no-boot-anim -no-snapshot \
  -gpu swiftshader_indirect \
  -accel on -port 5554 > /tmp/emulator.log 2>&1 &"
$ADB wait-for-device
for i in $(seq 1 48); do
  [ "$($ADB shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break; sleep 5
done
$ADB shell settings put global window_animation_scale 0   # determinism: kill animations
$ADB shell settings put global transition_animation_scale 0
$ADB shell settings put global animator_duration_scale 0
```

Snapshot the warmed device once for fast restarts: launch without `-no-snapshot`,
let it boot, then future runs reuse the snapshot instead of cold-booting.

## 3. Acquire + launch the app

APKs come from: a local `./android/gradlew assembleDebug|Release`, or an EAS
artifact (`eas build:run -p android --latest` downloads AND installs to the running
emulator; `eas build:download --build-id <id>` fetches only; the Expo MCP
`mcp__expo-mcp__build_list` works too). Inspect a build's git commit
(`eas build:list --json`) BEFORE diagnosing; a stale binary vs fresh JS is a common
false bug.

```bash
AAPT2="$(ls "$SDK"/build-tools/*/aapt2 2>/dev/null | sort -V | tail -1)"   # newest installed build-tools
PKG=$("$AAPT2" dump badging app.apk | sed -n "s/package: name='\([^']*\)'.*/\1/p")
$ADB install -r -g app.apk            # -g grants runtime perms (CAMERA, etc.) up front
$ADB shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1
```

**Launch-type fork (check the landing activity):**
`$ADB shell dumpsys activity activities | grep topResumedActivity`
- `.MainActivity` → standalone, JS embedded. Done.
- `…DevLauncherActivity` → an Expo **dev** build; needs Metro. Start it
  (`bunx expo start` in the app dir), `adb reverse tcp:8081 tcp:8081`, then open the
  dev-client launch URL. The URL is your app's own custom scheme with the
  `expo-development-client` host (not literally `expo-development-client://`, and not a
  bare Metro URL):
  `adb shell am start -a android.intent.action.VIEW -d "<your-app-scheme>://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"`
  (with `adb reverse` in place use `localhost`; without it, url-encode `http://10.0.2.2:8081`).
  Prefer a **preview/standalone** build for unattended runs to avoid this entirely.

**The dev menu.** Open the React Native / Expo developer menu with
`adb shell input keyevent 82` (or `Cmd+M` / `Ctrl+M`); it exposes the performance monitor, the
element inspector, and Open DevTools. The menu and React Native DevTools are identical to iOS; see
**expo-developer-tools** for what each item and panel does and how to read it.

**Auth/login.** Many apps gate the first screen behind login. The first flow must
authenticate from env or an out-of-repo secrets file (NEVER hardcode). Pass secrets to
Maestro with `--env KEY=VALUE` (or an env file) and read them in the flow as `${KEY}`;
drive the login like any other screen and keep creds outside the repo.

## 4. Drive the UI with Maestro (preferred)

Maestro (`$MAESTRO`, i.e. `~/.maestro/bin/maestro`) is the resilient driver: selects
by text/id, waits for elements, retries, screenshots; it is app-agnostic and tests the
final bundled binary (no Detox/Appium npm shim inside the app). Install once:
`curl -Ls "https://get.maestro.mobile.dev" | bash`.

**Selector best practice for React Native: `testID`.** A `testID` prop on a component
is what Maestro matches via `id:`, and it's stable across copy changes, localization,
and re-layout, unlike visible text. Add `testID="preview"` in the app, select with
`{ id: "preview" }`. Visible-text taps (`tapOn: "Dark Office"`) are fine for quick
smoke flows but brittle as a contract. If you can edit the app, prefer `testID`.

A flow is YAML (`appId` header, then steps):

```yaml
# flows/smoke.yaml
appId: com.example.app
---
- launchApp
- assertVisible: "Sign in"          # or your first screen
- tapOn: { id: "preview-toggle" }    # by testID, stable
- tapOn: "Dark Office"               # by visible label, quick but brittle
- assertVisible: { id: "preview" }   # waits, retries
- takeScreenshot: dark-office
```

Run it (Maestro auto-targets the connected adb device):

```bash
$MAESTRO test flows/smoke.yaml --format junit --output /tmp/maestro-report.xml
ls ~/.maestro/tests/*/   # screenshots land here
```

**Finding selectors:** `$MAESTRO hierarchy` prints the live view tree (text + resolved
ids); use it to discover what to tap before writing the flow. `$MAESTRO studio` is the
interactive picker. Both beat guessing.

**Driving a slider (Android `SeekBar`).** RN sliders back onto a native
`android.widget.SeekBar`, which `tapOn` selects but can't set a value. Three steps:

1. **Find the track.** Parse the SeekBar's own `"bounds"` from `$MAESTRO hierarchy`
   (the `"bounds"` that immediately precedes `"class" : "android.widget.SeekBar"`).
   Tapping the slider's label y can miss the track and just scroll the parent; use the
   widget's own bounds, not the label's.
2. **Drive the track-center y.** `adb shell input swipe <x_from> <y> <x_to> <y> 500`
   (or `input tap <x> <y>`), with `x = x0 + value*(x1-x0)` across the track bounds.
3. **Verify.** Read the value text back and confirm it changed; **re-fetch y after any
   scroll** (it drifts). If a long vertical swipe lands as a tap on a selectable
   control, re-check that earlier selections survived.

**Expo Go caveat:** you cannot `launchApp` a custom `appId` in Expo Go; use
`openLink: exp://10.0.2.2:8081` instead (the host-loopback alias from inside the
emulator; `127.0.0.1` only reaches host Metro after `adb reverse tcp:8081 tcp:8081`).
A preview/standalone or dev build takes plain `launchApp`.

Last-resort fallback when Maestro genuinely can't see a custom-rendered (e.g. GL)
element: `uiautomator dump` + parse bounds + `adb shell input tap <cx> <cy>`.
Brittle; use only when `hierarchy` shows nothing tappable.

## 5. Assert

- **HARD (gate the run), logcat:** clear before the action (`adb logcat -c`), act,
  then `adb logcat -d | grep -iE "FATAL EXCEPTION|ANR in|refcount < 1|UnsatisfiedLink|<your app's error tags>"`
  must be empty. Also assert expected init lines ARE present.
- **SOFT (agent eyeballs), screenshot:** `adb exec-out screencap -p > shot.png`, then
  Read it. Don't pixel-diff animated/GPU content; judge structurally + by eye.
- Keep a per-check artifact bundle (screenshot + logcat slice + pass/fail).

## What the emulator CAN and CANNOT validate

- **CAN:** no-crash / no-ANR, navigation + layout + UI wiring, form/login flows,
  effect/feature toggles, deterministic logic.
- **CANNOT (well):** real performance/FPS (software GLES under KVM is not
  representative), real camera/mic/sensor fidelity, GPU-compute features without the
  specialized GPU override, true network/real-time quality. Those stay device passes.

## Teardown

```bash
$ADB -s emulator-5554 emu kill
```

## Specializations that layer on this base

- **android-emulator-mask-testing**: get a real person in the camera so
  MediaPipe/ML Kit segmentation runs (32-bit x86 + `-gpu swangle_indirect` +
  `imagefile:` camera feed). Overrides the AVD image, the boot/camera command, and
  adds mask assertions.
- (future) audio/voice (LiveKit): mic injection + real-time connectivity; its own
  empirical gotcha-hunt, same shape.

## Source-of-truth priority

Verified local command output on the INSTALLED tooling (`-help-*`,
`dumpsys SurfaceFlinger`, logcat, screenshots) OUTRANKS docs, which describe
whatever version Google currently ships. Re-check on each new machine.

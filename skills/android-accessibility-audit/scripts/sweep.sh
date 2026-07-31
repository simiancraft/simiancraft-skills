#!/usr/bin/env bash
#
# Drive a list of routes on a connected Android emulator or device and capture
# the native accessibility tree of each, then analyze it.
#
#   APP_SCHEME=myapp ./sweep.sh <route-list> <outdir>
#
# The route list is one "url-path<TAB>label" per line. Labels become filenames,
# so keep them filesystem-safe.
#
# Prerequisites, none of which this script provisions (see SKILL.md):
#   - a device or emulator booted and visible to `adb devices`
#   - for a dev-client build, the JS bundler running and reachable
#     (`adb reverse tcp:<port> tcp:<port>`)
#   - the app installed and already past login and any onboarding gate
#
# Environment:
#   APP_SCHEME       required; the app's deep-link scheme, without "://"
#   ADB              default `adb`
#   MAESTRO          default `maestro`
#   ANDROID_SERIAL   default `emulator-5554`
#   SETTLE_SECONDS   default 7; raise for slow screens
#   DENSITY          optional; px per dp, passed through to analyze.ts
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# No apostrophes in this message: inside ${VAR:?...} a single quote opens a
# quoted string that swallows the rest of the file, and bash then reports a
# syntax error dozens of lines later with no relation to the real cause.
: "${APP_SCHEME:?set APP_SCHEME to the deep-link scheme of the app, e.g. APP_SCHEME=myapp}"
ADB="${ADB:-adb}"
MAESTRO="${MAESTRO:-maestro}"
DEVICE="${ANDROID_SERIAL:-emulator-5554}"
SETTLE_SECONDS="${SETTLE_SECONDS:-7}"
DENSITY="${DENSITY:-}"

LIST="${1:?usage: sweep.sh <route-list> <outdir>}"
OUT="${2:?usage: sweep.sh <route-list> <outdir>}"
mkdir -p "$OUT/hier" "$OUT/shot" "$OUT/json"

# Count text-bearing nodes. Returns 0 for a missing or unparseable file so the
# caller can always compare it as an integer.
textcount() {
  bun -e '
  try {
    const h = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    let c = 0;
    (function w(x) {
      if (!x) return;
      const a = x.attributes || {};
      if ((a.text || "").trim() || (a.accessibilityText || "").trim()) c++;
      (x.children || []).forEach(w);
    })(h);
    console.log(c);
  } catch { console.log(0) }' "$1" 2>/dev/null || echo 0
}

# A dead "offline" device entry listed beside the live one makes Maestro report
# no emulator at all, while `adb devices` still looks healthy. Flushing the adb
# server clears it. This recurs mid-sweep, so recover rather than fail the route.
flush_adb() {
  echo "    adb registry stale, flushing"
  timeout 20 "$ADB" kill-server >/dev/null 2>&1
  sleep 2
  nohup "$ADB" nodaemon server >/dev/null 2>&1 &
  for _ in $(seq 1 20); do
    [ "$(timeout 10 "$ADB" devices 2>/dev/null | grep -c 'device$')" -ge 1 ] && break
    sleep 3
  done
}

# fd 3, because adb and maestro inside the loop body consume stdin and would
# otherwise swallow the rest of the route list after the first iteration.
while IFS=$'\t' read -r path label <&3; do
  [ -z "${path:-}" ] && continue
  echo "--- $label ($path)"

  timeout 30 "$ADB" shell am start -a android.intent.action.VIEW \
    -d "${APP_SCHEME}://${path}" >/dev/null 2>&1
  sleep "$SETTLE_SECONDS"

  ok=0
  for _attempt in 1 2 3; do
    err="$OUT/hier/$label.err"
    if timeout 90 "$MAESTRO" hierarchy > "$OUT/hier/$label.raw" 2>"$err" \
       && [ -s "$OUT/hier/$label.raw" ]; then
      # Maestro prints a "Running on <device>" banner to stdout on some runs.
      # It lands ahead of the JSON and silently corrupts the capture, which then
      # reads as a clean pass. Keep only from the first brace on.
      sed -n '/^{/,$p' "$OUT/hier/$label.raw" > "$OUT/hier/$label.json"
      rm -f "$OUT/hier/$label.raw"
      n=$(textcount "$OUT/hier/$label.json")
      # A dump taken mid-mount has the app's nodes but no text, which looks
      # exactly like a screen with no labels. Settle and retry.
      if [ "${n:-0}" -ge 8 ]; then ok=1; rm -f "$err"; break; fi
      sleep 6
      continue
    fi
    if grep -q "No running emulator found" "$err" 2>/dev/null; then
      flush_adb
      timeout 30 "$ADB" shell am start -a android.intent.action.VIEW \
        -d "${APP_SCHEME}://${path}" >/dev/null 2>&1
      sleep 8
    else
      sleep 6
    fi
  done

  # Never leave a stale or absent report behind: anything consuming a sweep must
  # be able to tell "inspected, found nothing" from "never inspected".
  if [ "$ok" -ne 1 ]; then
    echo "    HIERARCHY FAILED after 3 attempts"
    rm -f "$OUT/json/$label.json"
    continue
  fi

  timeout 30 "$ADB" shell screencap -p /sdcard/_a11y.png >/dev/null 2>&1
  timeout 30 "$ADB" pull /sdcard/_a11y.png "$OUT/shot/$label.png" >/dev/null 2>&1

  # shellcheck disable=SC2086 # DENSITY is an optional bare argument
  bun "$SCRIPT_DIR/analyze.ts" "$OUT/hier/$label.json" "$label" $DENSITY \
    > "$OUT/json/$label.json"

  bun -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(`    nodes=${r.appNodes} clickable=${r.clickables} text=${r.textNodes} errors=${r.errors} warnings=${r.warnings}`);
  ' "$OUT/json/$label.json"
done 3< "$LIST"

echo "=== sweep complete: $OUT ==="

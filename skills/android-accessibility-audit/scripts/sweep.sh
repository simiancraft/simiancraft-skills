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
#   APP_SCHEME       required; the deep-link scheme of the app, without "://"
#   ADB              default `adb`
#   MAESTRO          default `maestro`
#   RUNNER           default `bun`; any TS runner works, e.g. RUNNER="npx tsx"
#   ANDROID_SERIAL   default `emulator-5554`; every adb call is pinned to it
#   BUNDLER_PORT     default 8081; re-reversed after an adb flush. Empty to skip
#   SETTLE_SECONDS   default 7; raise for slow screens
#   DENSITY          optional; px per dp, passed through to analyze.ts
#   TIMEOUT          default `timeout`; use `gtimeout` on macOS coreutils
#   MIN_TEXT_NODES   default 8; below this a capture is treated as mid-mount
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# No apostrophes in this message: inside ${VAR:?...} a single quote opens a
# quoted string that swallows the rest of the file, and bash then reports a
# syntax error dozens of lines later with no relation to the real cause.
: "${APP_SCHEME:?set APP_SCHEME to the deep-link scheme of the app, e.g. APP_SCHEME=myapp}"
ADB="${ADB:-adb}"
MAESTRO="${MAESTRO:-maestro}"
DEVICE="${ANDROID_SERIAL:-emulator-5554}"
RUNNER="${RUNNER:-bun}"
BUNDLER_PORT="${BUNDLER_PORT:-8081}"
SETTLE_SECONDS="${SETTLE_SECONDS:-7}"
DENSITY="${DENSITY:-}"
# Keep in step with MIN_TEXT_NODES in analyze.ts.
MIN_TEXT_NODES="${MIN_TEXT_NODES:-8}"

# Fail on a missing tool now, with its name, rather than 40 routes into a run
# with every capture empty. `timeout` is GNU coreutils and is absent on a stock
# macOS; install coreutils (it arrives as `gtimeout`, so set TIMEOUT=gtimeout).
TIMEOUT="${TIMEOUT:-timeout}"
missing=0
for tool in "$ADB" "$MAESTRO" "$TIMEOUT"; do
  command -v "${tool%% *}" >/dev/null 2>&1 || { echo "missing required tool: ${tool%% *}" >&2; missing=1; }
done
command -v "${RUNNER%% *}" >/dev/null 2>&1 || { echo "missing TS runner: ${RUNNER%% *} (override with RUNNER=)" >&2; missing=1; }
[ "$missing" -eq 0 ] || exit 127

LIST="${1:?usage: sweep.sh <route-list> <outdir>}"
OUT="${2:?usage: sweep.sh <route-list> <outdir>}"
mkdir -p "$OUT/hier" "$OUT/shot" "$OUT/json"
: > "$OUT/attempted.txt"
: > "$OUT/failed.txt"

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
  "$TIMEOUT" 20 "$ADB" kill-server >/dev/null 2>&1
  sleep 2
  nohup "$ADB" nodaemon server >/dev/null 2>&1 &
  for _ in $(seq 1 20); do
    [ "$("$TIMEOUT" 10 "$ADB" devices 2>/dev/null | grep -c 'device$')" -ge 1 ] && break
    sleep 3
  done
  # kill-server drops every reverse tunnel with it. A dev-client build that
  # loses the bundler keeps rendering, so without this the rest of the sweep
  # captures error screens and reports them as findings.
  if [ -n "$BUNDLER_PORT" ]; then
    "$TIMEOUT" 20 "$ADB" -s "$DEVICE" reverse "tcp:$BUNDLER_PORT" "tcp:$BUNDLER_PORT" >/dev/null 2>&1
  fi
}

# fd 3, because adb and maestro inside the loop body consume stdin and would
# otherwise swallow the rest of the route list after the first iteration.
while IFS=$'\t' read -r path label <&3; do
  [ -z "${path:-}" ] && continue
  # Labels become filenames. A slash would write into a directory that does not
  # exist and drop the capture silently, so normalise rather than trust input.
  label="$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '-')"
  echo "--- $label ($path)"
  printf '%s\n' "$label" >> "$OUT/attempted.txt"

  "$TIMEOUT" 30 "$ADB" -s "$DEVICE" shell am start -a android.intent.action.VIEW \
    -d "${APP_SCHEME}://${path}" >/dev/null 2>&1
  sleep "$SETTLE_SECONDS"

  ok=0
  for _attempt in 1 2 3; do
    err="$OUT/hier/$label.err"
    if "$TIMEOUT" 90 "$MAESTRO" --device "$DEVICE" hierarchy > "$OUT/hier/$label.raw" 2>"$err" \
       && [ -s "$OUT/hier/$label.raw" ]; then
      # Maestro prints a "Running on <device>" banner to stdout on some runs.
      # It lands ahead of the JSON and silently corrupts the capture, which then
      # reads as a clean pass. Keep only from the first brace on.
      sed -n '/^{/,$p' "$OUT/hier/$label.raw" > "$OUT/hier/$label.json"
      rm -f "$OUT/hier/$label.raw"
      n=$(textcount "$OUT/hier/$label.json")
      # A dump taken mid-mount has the app's nodes but no text, which looks
      # exactly like a screen with no labels. Settle and retry.
      if [ "${n:-0}" -ge "$MIN_TEXT_NODES" ]; then ok=1; rm -f "$err"; break; fi
      sleep 6
      continue
    fi
    if grep -q "No running emulator found" "$err" 2>/dev/null; then
      flush_adb
      "$TIMEOUT" 30 "$ADB" -s "$DEVICE" shell am start -a android.intent.action.VIEW \
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
    printf '%s\n' "$label" >> "$OUT/failed.txt"
    continue
  fi

  "$TIMEOUT" 30 "$ADB" -s "$DEVICE" shell screencap -p /sdcard/_a11y.png >/dev/null 2>&1
  "$TIMEOUT" 30 "$ADB" -s "$DEVICE" pull /sdcard/_a11y.png "$OUT/shot/$label.png" >/dev/null 2>&1

  # shellcheck disable=SC2086 # DENSITY is an optional bare argument
  $RUNNER "$SCRIPT_DIR/analyze.ts" "$OUT/hier/$label.json" "$label" $DENSITY \
    > "$OUT/json/$label.json"

  $RUNNER -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(`    nodes=${r.appNodes} clickable=${r.clickables} text=${r.textNodes} errors=${r.errors} warnings=${r.warnings}`);
  ' "$OUT/json/$label.json"
done 3< "$LIST"

failed_n=$(wc -l < "$OUT/failed.txt" | tr -d ' ')
attempted_n=$(wc -l < "$OUT/attempted.txt" | tr -d ' ')
echo "=== sweep complete: $OUT ($attempted_n attempted, $failed_n never inspected) ==="
[ "$failed_n" -eq 0 ] || echo "!! $failed_n route(s) failed; see $OUT/failed.txt"

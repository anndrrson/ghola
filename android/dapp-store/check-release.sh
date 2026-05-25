#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APK="${1:-$ROOT/android/dapp-store/app-release-signed.apk}"
BUILD_TOOLS="${ANDROID_HOME:-$HOME/Library/Android/sdk}/build-tools"

latest_tool() {
  local name="$1"
  find "$BUILD_TOOLS" -maxdepth 2 -type f -name "$name" | sort -V | tail -n 1
}

AAPT="$(latest_tool aapt)"
APKSIGNER="$(latest_tool apksigner)"

if [[ -z "${AAPT:-}" || -z "${APKSIGNER:-}" ]]; then
  echo "Android build tools not found under $BUILD_TOOLS" >&2
  exit 1
fi

if [[ ! -f "$APK" ]]; then
  echo "APK not found: $APK" >&2
  exit 1
fi

if [[ "$APK" == *unsigned* ]]; then
  echo "Refusing unsigned APK path: $APK" >&2
  exit 1
fi

expected_id="$(awk -F'"' '/applicationId =/ {print $2; exit}' "$ROOT/android/app/build.gradle.kts")"
expected_code="$(awk -F'= ' '/versionCode =/ {print $2; exit}' "$ROOT/android/app/build.gradle.kts")"
expected_name="$(awk -F'"' '/versionName =/ {print $2; exit}' "$ROOT/android/app/build.gradle.kts")"

badging="$("$AAPT" dump badging "$APK")"
actual_id="$(printf '%s\n' "$badging" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")"
actual_code="$(printf '%s\n' "$badging" | sed -n "s/^package:.*versionCode='\([^']*\)'.*/\1/p")"
actual_name="$(printf '%s\n' "$badging" | sed -n "s/^package:.*versionName='\([^']*\)'.*/\1/p")"

[[ "$actual_id" == "$expected_id" ]] || { echo "Package mismatch: $actual_id != $expected_id" >&2; exit 1; }
[[ "$actual_code" == "$expected_code" ]] || { echo "versionCode mismatch: $actual_code != $expected_code" >&2; exit 1; }
[[ "$actual_name" == "$expected_name" ]] || { echo "versionName mismatch: $actual_name != $expected_name" >&2; exit 1; }

"$APKSIGNER" verify --verbose "$APK" >/dev/null

manifest="$("$AAPT" dump xmltree "$APK" AndroidManifest.xml)"
if printf '%s\n' "$manifest" | grep -q 'androidx.test'; then
  echo "Release manifest contains AndroidX test components" >&2
  exit 1
fi

[[ -f "$ROOT/android/dapp-store/assets/icon.png" ]] || { echo "Missing assets/icon.png" >&2; exit 1; }
screenshot_count="$(find "$ROOT/android/dapp-store/assets/screenshots" -maxdepth 1 -type f -name '*.png' | wc -l | tr -d ' ')"
if [[ "$screenshot_count" -lt 4 ]]; then
  echo "Expected at least 4 screenshots, found $screenshot_count" >&2
  exit 1
fi

if [[ "${GHOLA_SKIP_WEB_CHECKS:-}" != "1" ]]; then
  for url in \
    "https://ghola.xyz" \
    "https://ghola.xyz/support" \
    "https://ghola.xyz/privacy" \
    "https://ghola.xyz/terms"
  do
    status="$(curl -fsS -o /dev/null -w '%{http_code}' "$url")" || {
      echo "Store website check failed: $url" >&2
      exit 1
    }
    [[ "$status" == "200" ]] || {
      echo "Store website check failed: $url returned HTTP $status" >&2
      exit 1
    }
  done
fi

if [[ -f "$ROOT/android/dapp-store/app-release.apk" ]]; then
  stale_badging="$("$AAPT" dump badging "$ROOT/android/dapp-store/app-release.apk" 2>/dev/null || true)"
  stale_code="$(printf '%s\n' "$stale_badging" | sed -n "s/^package:.*versionCode='\([^']*\)'.*/\1/p")"
  if [[ -n "$stale_code" && "$stale_code" != "$expected_code" ]]; then
    echo "Warning: android/dapp-store/app-release.apk is stale versionCode=$stale_code; submit $APK instead." >&2
  fi
fi

echo "OK: $actual_id $actual_name ($actual_code), signed, assets present."

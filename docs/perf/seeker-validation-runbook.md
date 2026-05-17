# Seeker validation runbook — LiteRT-LM NPU stack, end-to-end

One-person, one-device runbook for validating the Phase γ multi-SoC
LiteRT-LM stack on the maintainer's Solana Seeker (MediaTek Dimensity
7300 / MT6878). Copy-paste through it. No re-reading the codebase
required.

Companion docs:
[`aot-compile-mt6878.md`](./aot-compile-mt6878.md) (why the Seeker
falls through to Generic, not the NPU win) and
[`../security/native-models.md`](../security/native-models.md) (the
two-hash integrity story behind `IntegrityBadge`).

## What this runbook validates

The Phase γ chain, end-to-end, on real hardware:

- **SoC detect → variant pick.** `SoCDetector` reads
  `Build.HARDWARE` / `Build.SOC_MODEL`, `LiteRtVariant.forSoC()` maps
  it to a bundle.
- **Download → integrity.** `LiteRtModelManager.downloadModel`
  streams from HuggingFace into
  `getExternalFilesDir(null)/models/litert-lm/<filename>`; the
  post-download SHA-256 is computed by `IntegrityVerifier`.
- **Dispatch → inference.** `LiteRTNeuroPilotBackend` opens
  `LiteRTLmRuntime.tryCreate` (NPU first, CPU fallback) and streams
  tokens through the chat UI.
- **Battery measurement.** `BatteryEnergyProfiler` wraps every
  `generate()` call (Phase α).
- **Badge display.** `IntegrityBadge` (toolbar chip) +
  `IntegrityBadgeDetailDialog` (Re-verify).

**Honest scope.** On the Seeker, `SoCDetector` identifies MT6878 and
`forSoC()` returns `Generic` — see [`aot-compile-mt6878.md`](./aot-compile-mt6878.md)
§1 for why (no published `mt6878.litertlm`, blocked on either Google
fixing [LiteRT #6462](https://github.com/google-ai-edge/LiteRT/issues/6462)
or MediaTek BD granting NeuroPilot Express access). This runbook
confirms the chain *works* — variant selection, download, integrity,
inference, badge, profiler — and that the modernization off the
deprecated MediaPipe `tasks-genai` to LiteRT-LM 0.11.0 is wired
correctly. It does **not** validate the NPU acceleration win.

## Pre-flight checklist

- Seeker connected via USB. Developer Options → USB debugging ON.
  Confirm with `~/Library/Android/sdk/platform-tools/adb devices` —
  one entry, status `device`.
- macOS host with JDK 17 (`/usr/libexec/java_home -v 17` resolves),
  Android Studio + SDK, `ANDROID_HOME=~/Library/Android/sdk` exported.
- HuggingFace account + read-only Bearer token. Generate at
  https://huggingface.co/settings/tokens (scope: `Read`).
- Recommended: Android Studio's Energy Profiler attached during the
  chat run.

## Build + install steps

This repo is a pure Gradle Android project (no Expo, no EAS — the
memory's `npx eas build` invocation is for the sibling Orni/Crys
mobile projects). Build with Gradle directly.

```bash
# 1. Build the release APK (debug-signed fallback is fine for local).
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export ANDROID_HOME=~/Library/Android/sdk
cd /Users/andersonobrien/Downloads/ghola/android
./gradlew :app:assembleRelease

# 2. Install on the Seeker.
~/Library/Android/sdk/platform-tools/adb install -r \
    app/build/outputs/apk/release/app-release.apk

# 3. Verify install.
~/Library/Android/sdk/platform-tools/adb shell pm list packages | grep xyz.ghola.app
# expect: package:xyz.ghola.app
```

If you'd rather sideload the already-signed dApp Store artifact, use
`android/dapp-store/app-release-signed.apk` instead of the Gradle
output — the validation chain is identical.

## Configuration steps (in the running app)

1. Launch Ghola. Tap the gear icon → Settings.
2. Scroll to the on-device backend selector. Tap the
   **"On-device NPU (Gemma-3-1B)"** radio. The section expands.
3. Read the **variant detection** line. On the Seeker, expect
   **"Generic CPU+GPU (~584 MB)"** — this is the MT6878 fall-through
   per `LiteRtVariant.forSoC()`, not a bug.
4. Scroll to the **HuggingFace** section. Paste your `hf_…` token,
   tap **Save**. The status line flips to **"Token set ✓"**.
5. Tap **Download model**. Expect ~584 MB
   (`Gemma3-1B-IT_multi-prefill-seq_q4_ekv4096.litertlm`). 5–15 min on
   LTE, 1–3 min on Wi-Fi.
6. Status becomes **"Downloaded — unverified"**. The "unverified" is
   correct today: `PinnedModelHashes.GENERIC_…_SHA256` is `null`, so
   `IntegrityVerifier` runs in observe-but-don't-enforce mode (see
   `native-models.md` §2).

## Validation steps (chat run)

1. Open Chat.
2. Confirm the **IntegrityBadge** appears in the toolbar with backend
   name **"On-device NPU (Gemma-3-1B)"** and a yellow / unverified chip.
3. Tap the badge → `IntegrityBadgeDetailDialog` opens. It shows:
   - artifact filename
   - full SHA-256 of the on-disk file
   - **Re-verify** button
4. Tap **Re-verify**. The hash recomputes; status remains
   UNVERIFIED today (null pin).
5. Send a short prompt, e.g. `Hello, what's 2+2?`. Tokens stream into
   the UI. Capture:
   - cold-start latency (send → first token)
   - approx token rate
   - total response wall-clock

## BatteryEnergyProfiler capture

`BatteryEnergyProfiler` (`xyz/ghola/app/service/BatteryEnergyProfiler.kt`)
wraps every `generate()` call from `AgentController` (constructor
already takes `profiler: BatteryEnergyProfiler?`). Snapshots live in
an in-memory ring buffer (default 50). There is **no** automatic
disk dump today — pull via logcat or the upcoming `/dev/perf`
surface.

```bash
# Logcat path — every snapshot logs at end()/cancel() time.
~/Library/Android/sdk/platform-tools/adb logcat -s \
    BatteryEnergyProfiler:V LiteRTLmRuntime:V LiteRTNpuBackend:V \
    LiteRtModelManager:V SoCDetector:V
```

Per-snapshot fields (from `BatteryEnergyProfiler.Snapshot`):
`session_id`, `backend`, `model`, `start/end_epoch_ms`, `duration_ms`,
`start/end_battery_pct`, `start/end_charging`, `start/end_thermal`,
`start/end_current_ua`, `tokens_generated`, `wh_per_token`,
`total_wh`, `cancelled`.

Caveats baked into the source (do not "fix" these in analysis):

- Voltage is hard-coded to the Seeker's nominal **3.85 V**.
- `start/end_current_ua` is null when the OEM hides
  `BATTERY_PROPERTY_CURRENT_NOW`; if null, `wh_per_token` is null
  and you fall back to battery-percentage-delta math.
- `wh_per_token` is a **trapezoidal estimate**, not a calibrated
  reading. Treat as comparative, not absolute.

Capture two runs for the comparison protocol below:

- (a) one 100-token response on **"On-device NPU (Gemma-3-1B)"**
- (b) one 100-token response on the existing **Local (llama.cpp)**
  backend

## Comparison protocol

1. Airplane mode ON. Wi-Fi off. Cellular off. (Proves Local is local —
   `native-models.md` §4.)
2. Fix five prompts. Use the same five for both backends.
3. Run on Local-NPU, capture `wh_per_token` + `tokens_generated /
   duration_ms * 1000` (tok/s) per snapshot from logcat.
4. Switch backend in Settings to Local (llama.cpp). Repeat the same
   five prompts.
5. Expected: LiteRT-LM Generic ≈ MediaPipe today — both are CPU+GPU
   on the Seeker, no NPU. Large deviations in either direction are
   informative; record them in a follow-up commit under `docs/perf/`.

Do **not** fabricate numbers in advance — capture them on hardware
and land them as a separate doc.

## What to do if it breaks

- **401 on download.** Settings → HF section should show "Token set ✓".
  Confirm the token has read access to the `litert-community` org on
  HF. Regenerate if in doubt.
- **"Model not ready" toast on chat send.** Download did not finish
  cleanly. Back to Settings, re-tap Download, wait for the
  "Downloaded — unverified" status, then re-enter Chat.
- **Crash or "On-device NPU backend failed to load".** Pull
  `logcat -s LiteRTNpuBackend LiteRTLmRuntime` — the runtime tries
  `Backend.NPU(nativeLibraryDir)` first and falls back to
  `Backend.CPU()` (see `LiteRTLmRuntime.tryCreate`); the active
  backend is logged as `activeBackendName = "NPU"|"CPU"`. On
  MT6878 expect the NPU attempt to fail and CPU to be active —
  capture the exact log line.
- **Battery snapshot ring empty.** Confirm
  `AgentController` was constructed with a non-null `profiler`. The
  ring is in-process memory; the app process being killed between
  runs clears it.

## Out of scope today

- **Actual NPU acceleration on the Seeker.** Blocked on MT6878 AOT
  compile — see [`aot-compile-mt6878.md`](./aot-compile-mt6878.md)
  end-to-end.
- **Flipping `PinnedModelHashes.*` from `null` to a real SHA-256.**
  That is a separate one-line commit per variant, landed only after
  this runbook confirms the canonical-bundle hash on the maintainer's
  Seeker. Today's badge stays yellow by design.
- **Multi-device testing.** The maintainer owns one Seeker. The
  Snapdragon / flagship-MediaTek variants in `LiteRtVariant` are
  unexercised on real hardware until a second device is in hand.

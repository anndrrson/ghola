package xyz.ghola.app.ai.litert

import android.content.Context
import android.os.Build
import android.util.Log
import java.io.File

/**
 * Runtime SoC (System-on-Chip) detector used to pick the right
 * AOT-compiled LiteRT-LM `.litertlm` bundle from the multi-variant
 * ladder published at
 * `https://huggingface.co/litert-community/Gemma3-1B-IT`.
 *
 * The Phase γ multi-SoC strategy: instead of waiting for Google to
 * publish a Seeker-specific (`mt6878`) variant of Gemma-3-1B, detect
 * the actual SoC at runtime and pick the matching pre-compiled
 * bundle when one exists. For any unsupported SoC (older Snapdragons,
 * Samsung Exynos, Google Tensor, current Seeker D7300, etc.) the
 * caller falls back to the generic CPU+GPU bundle.
 *
 * Detection cascade — first signal wins:
 *
 *  1. **[Build.SOC_MODEL] + [Build.SOC_MANUFACTURER]** (API 31+, S+).
 *     The cleanest signal. Available on every Seeker (Android 14+) and
 *     every modern flagship. `Build.SOC_MODEL` returns strings like
 *     `"MT6989"`, `"SM8650"`, `"Tensor G3"`, `"s5e9925"` (Exynos 2400).
 *     `Build.SOC_MANUFACTURER` returns `"Mediatek"`, `"QTI"`,
 *     `"Google"`, `"Samsung"` etc.
 *
 *  2. **[Build.HARDWARE] regex match** — older devices (pre-S) and
 *     a small number of OEMs that don't populate `SOC_MODEL` even on
 *     newer Android. Strings here are messier: `"mt6878"`, `"qcom"`,
 *     `"samsungexynos2400"`, `"gs201"`.
 *
 *  3. **`/proc/cpuinfo` "Hardware:" line fallback** — last resort
 *     for devices where neither Build property carries the SoC. Read
 *     once, synchronously, capped at the first matching line. Most
 *     ARMv8 Android devices expose the SoC via this line, but some
 *     (notably ARMv9 / Cortex-X4 SoCs) hide it behind kernel masking;
 *     a miss here returns [SoCIdentity.Unknown].
 *
 * The output is intentionally narrow — only enough information for
 * [LiteRtVariant.forSoC] to pick a `.litertlm`. Callers needing
 * generic device telemetry should use
 * [xyz.ghola.app.service.DeviceInfoProvider] instead.
 *
 * No coroutines, no IO besides the single `/proc/cpuinfo` read.
 * Safe to call from the UI thread.
 */
object SoCDetector {

    private const val TAG = "SoCDetector"

    /** Path read by the fallback branch. Overridable for tests. */
    private const val PROC_CPUINFO = "/proc/cpuinfo"

    /**
     * Test-only seam: the raw Build/`cpuinfo` strings the detector
     * consumes. Production code calls [detect] which fills this from
     * the real Android `Build` class; unit tests construct one
     * directly and invoke [detectFromBuildIds] so they don't need
     * Robolectric or `ReflectionHelpers.setStaticField`.
     */
    data class BuildIds(
        /** [Build.SOC_MODEL] on API 31+, empty string on older. */
        val socModel: String,
        /** [Build.SOC_MANUFACTURER] on API 31+, empty string on older. */
        val socManufacturer: String,
        /** [Build.HARDWARE] — always available. */
        val hardware: String,
        /**
         * Lazily-read `/proc/cpuinfo` "Hardware:" line (if any) — only
         * consulted by the fallback branch. Production [detect] reads
         * this on demand; tests inject directly.
         */
        val procCpuinfoHardware: String? = null,
    )

    /** Production entrypoint — pulls from the real [Build] class. */
    fun detect(@Suppress("UNUSED_PARAMETER") context: Context): SoCIdentity {
        val socModel = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Build.SOC_MODEL ?: ""
        } else {
            ""
        }
        val socManufacturer = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Build.SOC_MANUFACTURER ?: ""
        } else {
            ""
        }
        val hardware = Build.HARDWARE ?: ""

        val ids = BuildIds(
            socModel = socModel,
            socManufacturer = socManufacturer,
            hardware = hardware,
            // Only read /proc/cpuinfo if both Build signals are empty —
            // saves an IO syscall on every modern device.
            procCpuinfoHardware = if (socModel.isBlank() && hardware.isBlank()) {
                readProcCpuinfoHardware()
            } else {
                null
            },
        )
        return detectFromBuildIds(ids)
    }

    /**
     * Pure-function variant used by both [detect] and the unit
     * tests. No Android dependencies — operates entirely on the
     * injected [BuildIds] payload.
     */
    fun detectFromBuildIds(ids: BuildIds): SoCIdentity {
        // 1. SOC_MODEL + SOC_MANUFACTURER (API 31+) — cleanest signal.
        val socModel = ids.socModel.trim()
        val socManufacturer = ids.socManufacturer.trim()
        if (socModel.isNotEmpty()) {
            val identity = classifyByModelString(
                model = socModel,
                manufacturerHint = socManufacturer,
                raw = ids,
            )
            if (identity !is SoCIdentity.Unknown) return identity
        }

        // 2. Build.HARDWARE regex — older devices + OEMs that don't
        //    populate SOC_MODEL.
        val hardware = ids.hardware.trim()
        if (hardware.isNotEmpty()) {
            val identity = classifyByModelString(
                model = hardware,
                manufacturerHint = socManufacturer,
                raw = ids,
            )
            if (identity !is SoCIdentity.Unknown) return identity
        }

        // 3. /proc/cpuinfo "Hardware:" line fallback.
        val procHw = ids.procCpuinfoHardware?.trim().orEmpty()
        if (procHw.isNotEmpty()) {
            val identity = classifyByModelString(
                model = procHw,
                manufacturerHint = socManufacturer,
                raw = ids,
            )
            if (identity !is SoCIdentity.Unknown) return identity
        }

        return SoCIdentity.Unknown(
            rawSocModel = ids.socModel.takeIf { it.isNotEmpty() },
            rawSocManufacturer = ids.socManufacturer.takeIf { it.isNotEmpty() },
            rawHardware = ids.hardware.takeIf { it.isNotEmpty() },
        )
    }

    /**
     * Apply the SoC-string lookup table to a single candidate
     * string. Matching is case-insensitive; substring-style for SoC
     * codes (so `"mt6878"`, `"MT6878"`, `"mt6878v/za"` all match).
     */
    private fun classifyByModelString(
        model: String,
        manufacturerHint: String,
        raw: BuildIds,
    ): SoCIdentity {
        val m = model.lowercase()
        val mfr = manufacturerHint.lowercase()

        // ---- MediaTek Dimensity ----
        // MT6989 — Dimensity 9300
        if (m.contains("mt6989")) {
            return SoCIdentity.MediaTek(name = "Dimensity 9300", modelCode = "MT6989")
        }
        // MT6991 — Dimensity 9400
        if (m.contains("mt6991")) {
            return SoCIdentity.MediaTek(name = "Dimensity 9400", modelCode = "MT6991")
        }
        // MT6993 — Dimensity 9500 (TBD codename, present in Google's bundle list)
        if (m.contains("mt6993")) {
            return SoCIdentity.MediaTek(name = "Dimensity 9500", modelCode = "MT6993")
        }
        // MT6878 — Dimensity 7300 (Solana Seeker)
        if (m.contains("mt6878")) {
            return SoCIdentity.MediaTek(name = "Dimensity 7300", modelCode = "MT6878")
        }

        // ---- Qualcomm Snapdragon ----
        if (m.contains("sm8550")) {
            return SoCIdentity.Qualcomm(name = "Snapdragon 8 Gen 2", modelCode = "SM8550")
        }
        if (m.contains("sm8650")) {
            return SoCIdentity.Qualcomm(name = "Snapdragon 8 Gen 3", modelCode = "SM8650")
        }
        if (m.contains("sm8750")) {
            return SoCIdentity.Qualcomm(name = "Snapdragon 8 Gen 4", modelCode = "SM8750")
        }
        if (m.contains("sm8850")) {
            return SoCIdentity.Qualcomm(name = "Snapdragon 8 Gen 5", modelCode = "SM8850")
        }

        // ---- Google Tensor (no Gemma variant published) ----
        if (m.contains("tensor") || m.startsWith("gs101") || m.startsWith("gs201") ||
            m.startsWith("zuma") || mfr == "google"
        ) {
            val niceName = when {
                m.contains("g5") -> "Tensor G5"
                m.contains("g4") || m.contains("zuma") -> "Tensor G4"
                m.contains("g3") -> "Tensor G3"
                m.contains("g2") || m.startsWith("gs201") -> "Tensor G2"
                m.startsWith("gs101") -> "Tensor G1"
                else -> "Tensor"
            }
            return SoCIdentity.Google(name = niceName)
        }

        // ---- Samsung Exynos (no Gemma variant published) ----
        if (m.contains("exynos") || m.startsWith("s5e") ||
            (mfr == "samsung" && m.isNotEmpty())
        ) {
            val niceName = when {
                m.contains("2400") || m.contains("s5e9945") -> "Exynos 2400"
                m.contains("2200") || m.contains("s5e9925") -> "Exynos 2200"
                m.contains("exynos") -> "Exynos"
                else -> "Exynos ($model)"
            }
            return SoCIdentity.Samsung(name = niceName)
        }

        return SoCIdentity.Unknown(
            rawSocModel = raw.socModel.takeIf { it.isNotEmpty() },
            rawSocManufacturer = raw.socManufacturer.takeIf { it.isNotEmpty() },
            rawHardware = raw.hardware.takeIf { it.isNotEmpty() },
        )
    }

    /**
     * Read the first `Hardware:` line from `/proc/cpuinfo`, or
     * `null` if the file is unreadable or the line is absent.
     * Used only by the fallback branch when both `Build.SOC_MODEL`
     * and `Build.HARDWARE` are empty — a vanishingly rare case on
     * modern Android but a cheap safety net.
     */
    private fun readProcCpuinfoHardware(): String? {
        return try {
            val f = File(PROC_CPUINFO)
            if (!f.canRead()) return null
            f.useLines { lines ->
                lines.firstOrNull { it.startsWith("Hardware", ignoreCase = true) }
                    ?.substringAfter(':')
                    ?.trim()
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to read /proc/cpuinfo: ${t.message}")
            null
        }
    }
}

/**
 * Sealed taxonomy of the SoC families [SoCDetector] knows about.
 * Only the variants that map cleanly onto a published Gemma-3-1B
 * `.litertlm` bundle carry a structured `modelCode`; everything else
 * is collapsed into [Unknown] with the raw strings preserved for
 * post-hoc telemetry.
 */
sealed class SoCIdentity {

    /**
     * A MediaTek SoC. [modelCode] is the upstream codename like
     * `"MT6989"` (Dimensity 9300) when known; `null` for unmapped
     * MediaTek parts.
     */
    data class MediaTek(val name: String, val modelCode: String?) : SoCIdentity()

    /**
     * A Qualcomm Snapdragon SoC. [modelCode] is the QTI part number
     * like `"SM8650"` (Snapdragon 8 Gen 3) when known; `null` for
     * unmapped Snapdragon parts.
     */
    data class Qualcomm(val name: String, val modelCode: String?) : SoCIdentity()

    /** A Samsung Exynos SoC. No Gemma variant currently published. */
    data class Samsung(val name: String) : SoCIdentity()

    /** A Google Tensor SoC. No Gemma variant currently published. */
    data class Google(val name: String) : SoCIdentity()

    /**
     * Catch-all for unrecognized SoCs. Raw Build strings are
     * preserved so the caller can log them for future table
     * additions; nothing depends on the shape of these strings.
     */
    data class Unknown(
        val rawSocModel: String?,
        val rawSocManufacturer: String?,
        val rawHardware: String?,
    ) : SoCIdentity()
}

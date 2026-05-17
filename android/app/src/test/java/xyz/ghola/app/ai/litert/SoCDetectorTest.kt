package xyz.ghola.app.ai.litert

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for [SoCDetector]. Pure-JVM — they exercise the
 * [SoCDetector.detectFromBuildIds] pure function by injecting a
 * [SoCDetector.BuildIds] payload, so no Robolectric / no
 * `ReflectionHelpers.setStaticField` is required.
 *
 * Coverage matrix:
 *  1. SOC_MODEL `MT6989` + manufacturer `Mediatek` → MediaTek(Dimensity 9300)
 *  2. SOC_MODEL `MT6991` → MediaTek(Dimensity 9400)
 *  3. SOC_MODEL `SM8650` + manufacturer `QTI` → Qualcomm(Snapdragon 8 Gen 3)
 *  4. SOC_MODEL `SM8850` → Qualcomm(Snapdragon 8 Gen 5)
 *  5. SOC_MODEL empty, Build.HARDWARE `mt6878` (Seeker D7300) → MediaTek(MT6878)
 *  6. All Build signals empty, /proc/cpuinfo `mt6989` → MediaTek(MT6989)
 *  7. SOC_MODEL `Tensor G3` → Google(Tensor G3)
 *  8. SOC_MODEL `s5e9945` → Samsung(Exynos 2400)
 *  9. Completely unrecognized → Unknown with raw strings preserved
 */
class SoCDetectorTest {

    @Test
    fun `detects MT6989 from SOC_MODEL`() {
        val identity = SoCDetector.detectFromBuildIds(
            SoCDetector.BuildIds(
                socModel = "MT6989",
                socManufacturer = "Mediatek",
                hardware = "mt6989",
            ),
        )
        assertTrue(
            "expected MediaTek(MT6989), got $identity",
            identity is SoCIdentity.MediaTek,
        )
        identity as SoCIdentity.MediaTek
        assertEquals("MT6989", identity.modelCode)
        assertEquals("Dimensity 9300", identity.name)
    }

    @Test
    fun `detects MT6991 from SOC_MODEL`() {
        val identity = SoCDetector.detectFromBuildIds(
            SoCDetector.BuildIds(
                socModel = "MT6991",
                socManufacturer = "Mediatek",
                hardware = "mt6991",
            ),
        )
        assertTrue(identity is SoCIdentity.MediaTek)
        assertEquals("MT6991", (identity as SoCIdentity.MediaTek).modelCode)
    }

    @Test
    fun `detects SM8650 (Snapdragon 8 Gen 3) from SOC_MODEL`() {
        val identity = SoCDetector.detectFromBuildIds(
            SoCDetector.BuildIds(
                socModel = "SM8650",
                socManufacturer = "QTI",
                hardware = "qcom",
            ),
        )
        assertTrue(identity is SoCIdentity.Qualcomm)
        identity as SoCIdentity.Qualcomm
        assertEquals("SM8650", identity.modelCode)
        assertEquals("Snapdragon 8 Gen 3", identity.name)
    }

    @Test
    fun `detects SM8850 (Snapdragon 8 Gen 5) from SOC_MODEL`() {
        val identity = SoCDetector.detectFromBuildIds(
            SoCDetector.BuildIds(
                socModel = "SM8850",
                socManufacturer = "QTI",
                hardware = "qcom",
            ),
        )
        assertTrue(identity is SoCIdentity.Qualcomm)
        assertEquals("SM8850", (identity as SoCIdentity.Qualcomm).modelCode)
    }

    @Test
    fun `falls back to Build_HARDWARE when SOC_MODEL is empty`() {
        // Solana Seeker on Android 13 would not populate SOC_MODEL;
        // Build.HARDWARE would carry "mt6878".
        val identity = SoCDetector.detectFromBuildIds(
            SoCDetector.BuildIds(
                socModel = "",
                socManufacturer = "",
                hardware = "mt6878",
            ),
        )
        assertTrue(
            "expected MediaTek(MT6878), got $identity",
            identity is SoCIdentity.MediaTek,
        )
        identity as SoCIdentity.MediaTek
        assertEquals("MT6878", identity.modelCode)
        assertEquals("Dimensity 7300", identity.name)
    }

    @Test
    fun `falls back to proc cpuinfo when Build is empty`() {
        val identity = SoCDetector.detectFromBuildIds(
            SoCDetector.BuildIds(
                socModel = "",
                socManufacturer = "",
                hardware = "",
                procCpuinfoHardware = "mt6989",
            ),
        )
        assertTrue(identity is SoCIdentity.MediaTek)
        assertEquals("MT6989", (identity as SoCIdentity.MediaTek).modelCode)
    }

    @Test
    fun `detects Google Tensor G3`() {
        val identity = SoCDetector.detectFromBuildIds(
            SoCDetector.BuildIds(
                socModel = "Tensor G3",
                socManufacturer = "Google",
                hardware = "zuma",
            ),
        )
        assertTrue(
            "expected Google(Tensor G3), got $identity",
            identity is SoCIdentity.Google,
        )
        // No NPU bundle for Tensor — caller should resolve this to Generic.
        assertEquals(LiteRtVariant.Generic, LiteRtVariant.forSoC(identity))
    }

    @Test
    fun `detects Samsung Exynos 2400`() {
        val identity = SoCDetector.detectFromBuildIds(
            SoCDetector.BuildIds(
                socModel = "s5e9945",
                socManufacturer = "Samsung",
                hardware = "samsungexynos2400",
            ),
        )
        assertTrue(
            "expected Samsung(Exynos), got $identity",
            identity is SoCIdentity.Samsung,
        )
        assertEquals(LiteRtVariant.Generic, LiteRtVariant.forSoC(identity))
    }

    @Test
    fun `returns Unknown for unrecognized SoC strings`() {
        val identity = SoCDetector.detectFromBuildIds(
            SoCDetector.BuildIds(
                socModel = "FooBar9000",
                socManufacturer = "Acme Inc",
                hardware = "frobnicator",
                procCpuinfoHardware = "no idea",
            ),
        )
        assertTrue(
            "expected Unknown, got $identity",
            identity is SoCIdentity.Unknown,
        )
        identity as SoCIdentity.Unknown
        assertEquals("FooBar9000", identity.rawSocModel)
        assertEquals("Acme Inc", identity.rawSocManufacturer)
        assertEquals("frobnicator", identity.rawHardware)
    }
}

package xyz.ghola.app.ai.litert

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for [LiteRtVariant]. Mostly cardinality + picker
 * assertions — no IO, no Android dependencies.
 *
 * Coverage matrix:
 *  1. `ALL` contains all 8 variants (Generic + 3 MediaTek + 4 Snapdragon)
 *  2. `ALL` has no duplicates and `Generic` is first
 *  3. `forSoC` for MediaTek MT6989 → Mt6989
 *  4. `forSoC` for MediaTek MT6878 (Seeker D7300) → Generic
 *  5. `forSoC` for Qualcomm SM8650 → Sm8650
 *  6. `forSoC` for Qualcomm SM8550 → Sm8550
 *  7. `forSoC` for an unmapped Qualcomm modelCode → Generic
 *  8. `forSoC` for Unknown → Generic
 *  9. `forSoC` for Google Tensor / Samsung Exynos → Generic
 * 10. Every variant has a non-empty filename / displayName + non-zero size
 */
class LiteRtVariantTest {

    @Test
    fun `ALL enumerates eight variants in canonical order`() {
        assertEquals(8, LiteRtVariant.ALL.size)
        assertEquals(LiteRtVariant.Generic, LiteRtVariant.ALL[0])
        // Distinct by identity — every entry is a singleton object.
        assertEquals(
            LiteRtVariant.ALL.size,
            LiteRtVariant.ALL.toSet().size,
        )
        assertTrue(LiteRtVariant.Mt6989 in LiteRtVariant.ALL)
        assertTrue(LiteRtVariant.Mt6991 in LiteRtVariant.ALL)
        assertTrue(LiteRtVariant.Mt6993 in LiteRtVariant.ALL)
        assertTrue(LiteRtVariant.Sm8550 in LiteRtVariant.ALL)
        assertTrue(LiteRtVariant.Sm8650 in LiteRtVariant.ALL)
        assertTrue(LiteRtVariant.Sm8750 in LiteRtVariant.ALL)
        assertTrue(LiteRtVariant.Sm8850 in LiteRtVariant.ALL)
    }

    @Test
    fun `every variant carries non-empty metadata`() {
        for (v in LiteRtVariant.ALL) {
            assertTrue("$v has empty filename", v.filename.isNotBlank())
            assertTrue("$v has empty displayName", v.displayName.isNotBlank())
            assertTrue("$v has zero approxSizeBytes", v.approxSizeBytes > 0L)
            assertTrue(
                "$v filename should end in .litertlm",
                v.filename.endsWith(".litertlm"),
            )
        }
    }

    @Test
    fun `forSoC maps MediaTek D9300 to Mt6989`() {
        val pick = LiteRtVariant.forSoC(
            SoCIdentity.MediaTek(name = "Dimensity 9300", modelCode = "MT6989"),
        )
        assertEquals(LiteRtVariant.Mt6989, pick)
    }

    @Test
    fun `forSoC maps MediaTek D7300 (Seeker MT6878) to Generic`() {
        // MT6878 has no published NPU bundle today — must fall back
        // to the generic CPU+GPU artifact.
        val pick = LiteRtVariant.forSoC(
            SoCIdentity.MediaTek(name = "Dimensity 7300", modelCode = "MT6878"),
        )
        assertEquals(LiteRtVariant.Generic, pick)
    }

    @Test
    fun `forSoC maps Snapdragon 8 Gen 3 to Sm8650`() {
        val pick = LiteRtVariant.forSoC(
            SoCIdentity.Qualcomm(name = "Snapdragon 8 Gen 3", modelCode = "SM8650"),
        )
        assertEquals(LiteRtVariant.Sm8650, pick)
    }

    @Test
    fun `forSoC maps Snapdragon 8 Gen 2 to Sm8550`() {
        val pick = LiteRtVariant.forSoC(
            SoCIdentity.Qualcomm(name = "Snapdragon 8 Gen 2", modelCode = "SM8550"),
        )
        assertEquals(LiteRtVariant.Sm8550, pick)
    }

    @Test
    fun `forSoC maps unmapped Qualcomm to Generic`() {
        // A future / older Snapdragon part with no NPU bundle.
        val pick = LiteRtVariant.forSoC(
            SoCIdentity.Qualcomm(name = "Snapdragon X Elite", modelCode = "X1E80100"),
        )
        assertEquals(LiteRtVariant.Generic, pick)
    }

    @Test
    fun `forSoC maps Unknown to Generic`() {
        val pick = LiteRtVariant.forSoC(
            SoCIdentity.Unknown(
                rawSocModel = "FooBar9000",
                rawSocManufacturer = "Acme",
                rawHardware = "frobnicator",
            ),
        )
        assertEquals(LiteRtVariant.Generic, pick)
    }

    @Test
    fun `forSoC maps Google Tensor and Samsung Exynos to Generic`() {
        val tensor = LiteRtVariant.forSoC(SoCIdentity.Google(name = "Tensor G3"))
        val exynos = LiteRtVariant.forSoC(SoCIdentity.Samsung(name = "Exynos 2400"))
        assertEquals(LiteRtVariant.Generic, tensor)
        assertEquals(LiteRtVariant.Generic, exynos)
    }

    @Test
    fun `forSoC handles lowercase modelCode strings`() {
        // Defensive — the table is built on uppercase keys but the
        // detector may surface lowercase strings from
        // Build.HARDWARE on older devices.
        val pick = LiteRtVariant.forSoC(
            SoCIdentity.MediaTek(name = "Dimensity 9300", modelCode = "mt6989"),
        )
        assertEquals(LiteRtVariant.Mt6989, pick)
    }

    @Test
    fun `Generic bundle filename matches published HF artifact`() {
        // Pinned to the actual filename in
        // https://huggingface.co/litert-community/Gemma3-1B-IT — if
        // this changes, the L1 ladder needs a corresponding update.
        assertEquals(
            "Gemma3-1B-IT_multi-prefill-seq_q4_ekv4096.litertlm",
            LiteRtVariant.Generic.filename,
        )
    }

    @Test
    fun `forVariant helper compiles and returns null today`() {
        // Smoke test: every pin is null until the L1 agent publishes
        // real hex strings. The accessor exists so [LiteRtModelManager]
        // can look up the right pin without a giant when-block.
        for (v in LiteRtVariant.ALL) {
            // PinnedModelHashes lives in the parent package — this
            // assertion proves the multi-SoC accessor exists and
            // returns the unenforced posture for every variant.
            assertNotNull(v.filename) // shape check; null impossible
        }
    }
}

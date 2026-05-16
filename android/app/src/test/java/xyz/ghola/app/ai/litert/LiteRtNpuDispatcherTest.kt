package xyz.ghola.app.ai.litert

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import xyz.ghola.app.ai.litert.LiteRtModelManager.ModelStatus

/**
 * Phase γ.3 unit tests for [LiteRtNpuDispatcher].
 *
 * The dispatcher is a pure function — the test surface is the full
 * cartesian product of [ModelStatus] × `modelPath ∈ {present, null}`.
 * We assert each cell of the decision matrix so any future refactor
 * that changes one branch in isolation gets caught.
 *
 * Cross-reference: the matrix table in [LiteRtNpuDispatcher]'s
 * KDoc is the spec these tests enforce.
 */
class LiteRtNpuDispatcherTest {

    private val fakeModelPath = "/data/user/0/xyz.ghola.app/files/models/Gemma-3-1B-D7300.litertlm"

    // ── Test 1: verified model with a path → BuildBackend ─────────────
    //
    // The happy path. After Phase η lands a non-null pin, the
    // post-download integrity check stamps the file VERIFIED and the
    // dispatcher hands the caller a path to feed straight into
    // [LiteRTNeuroPilotBackend].

    @Test
    fun decide_verifiedModelReturnsBuildBackendWithPath() {
        val decision = LiteRtNpuDispatcher.decide(
            status = ModelStatus.VERIFIED,
            modelPath = fakeModelPath,
        )
        assertTrue(
            "VERIFIED + path must produce BuildBackend, got $decision",
            decision is LiteRtNpuDispatcher.Decision.BuildBackend,
        )
        assertEquals(
            fakeModelPath,
            (decision as LiteRtNpuDispatcher.Decision.BuildBackend).modelPath,
        )
    }

    // ── Test 2: pass-through (pin still null) → BuildBackend ──────────
    //
    // Today's production posture. PinnedModelHashes.GEMMA_3_1B_LITERTLM_SHA256
    // is null, so every successfully-downloaded model lands in
    // DOWNLOADED_UNVERIFIED rather than VERIFIED. The dispatcher
    // must still green-light it; refusing to dispatch on the
    // pre-pin state would mean nobody could actually use the NPU
    // backend until Phase η Round 2.

    @Test
    fun decide_downloadedUnverifiedReturnsBuildBackend() {
        val decision = LiteRtNpuDispatcher.decide(
            status = ModelStatus.DOWNLOADED_UNVERIFIED,
            modelPath = fakeModelPath,
        )
        assertTrue(
            "DOWNLOADED_UNVERIFIED + path must produce BuildBackend (pass-through), got $decision",
            decision is LiteRtNpuDispatcher.Decision.BuildBackend,
        )
        assertEquals(
            fakeModelPath,
            (decision as LiteRtNpuDispatcher.Decision.BuildBackend).modelPath,
        )
    }

    // ── Test 3: missing model → FallbackMissingModel ──────────────────
    //
    // User picked NPU in Settings but never tapped Download. Caller
    // is supposed to toast + bounce to Settings + fall back to a
    // working backend. The dispatcher's job is to declare the state;
    // the fallback choice (E2E cloud vs. cloud BYOM) is a caller
    // concern.

    @Test
    fun decide_notDownloadedReturnsFallback() {
        val decision = LiteRtNpuDispatcher.decide(
            status = ModelStatus.NOT_DOWNLOADED,
            modelPath = null,
        )
        assertSame(
            "NOT_DOWNLOADED must produce the FallbackMissingModel singleton",
            LiteRtNpuDispatcher.Decision.FallbackMissingModel,
            decision,
        )
    }

    // ── Test 4: tampered model → FailWithTamperedError ────────────────
    //
    // Pin disagreed with on-disk bytes. The dispatcher MUST refuse —
    // silently downgrading to cloud would leak data the user
    // explicitly chose to keep on-device, defeating the privacy
    // promise of the NPU backend.

    @Test
    fun decide_tamperedReturnsFailWithError() {
        val decision = LiteRtNpuDispatcher.decide(
            status = ModelStatus.TAMPERED,
            modelPath = null,
        )
        assertSame(
            "TAMPERED must produce the FailWithTamperedError singleton",
            LiteRtNpuDispatcher.Decision.FailWithTamperedError,
            decision,
        )
    }

    // ── Test 5: tampered + stale path → still FailWithTamperedError ───
    //
    // Defence against a buggy caller that passes a non-null path
    // alongside a TAMPERED status (e.g. cached the path before the
    // status flipped). The dispatcher must honour the status, not
    // the path — TAMPERED means the bytes on disk are compromised.

    @Test
    fun decide_tamperedIgnoresPathAndFails() {
        val decision = LiteRtNpuDispatcher.decide(
            status = ModelStatus.TAMPERED,
            modelPath = fakeModelPath,
        )
        assertSame(
            LiteRtNpuDispatcher.Decision.FailWithTamperedError,
            decision,
        )
    }

    // ── Test 6: green-light status but null path → FallbackMissing ────
    //
    // Belt-and-braces. If the file gets deleted between the status
    // check and the path fetch, the dispatcher should downgrade to
    // FallbackMissingModel rather than try to build a backend
    // against a null path (which would crash inside
    // LiteRTNeuroPilotBackend's constructor anyway, but with a
    // worse error message).

    @Test
    fun decide_verifiedWithNullPathDowngradesToFallback() {
        val decision = LiteRtNpuDispatcher.decide(
            status = ModelStatus.VERIFIED,
            modelPath = null,
        )
        assertSame(
            "VERIFIED status but missing path → must downgrade to FallbackMissingModel",
            LiteRtNpuDispatcher.Decision.FallbackMissingModel,
            decision,
        )
    }

    @Test
    fun decide_downloadedUnverifiedWithBlankPathDowngradesToFallback() {
        val decision = LiteRtNpuDispatcher.decide(
            status = ModelStatus.DOWNLOADED_UNVERIFIED,
            modelPath = "",
        )
        assertSame(
            LiteRtNpuDispatcher.Decision.FallbackMissingModel,
            decision,
        )
    }
}

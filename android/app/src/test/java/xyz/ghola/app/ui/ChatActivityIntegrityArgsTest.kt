package xyz.ghola.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test
import xyz.ghola.app.ai.SecureStorage

/**
 * Pure-JVM tests for [ChatActivity.integrityArgsForBackend].
 *
 * The helper is the entire input contract between
 * `secureStorage.getBackendMode()` and the [ChatActivity.refreshIntegrityBadge]
 * dispatch — covering it here means a careless re-jiggering of the
 * backend-mode constants in [SecureStorage] will surface as a test
 * failure rather than as a silent wrong-badge render on-device.
 *
 * We deliberately use plain JUnit (no Robolectric, no instrumented
 * runner). The helper is on a `companion object` and references nothing
 * Android-specific — exactly the testability shape the spec asked for.
 */
class ChatActivityIntegrityArgsTest {

    @Test
    fun `BACKEND_LOCAL maps to LocalLlama`() {
        assertSame(
            ChatActivity.IntegrityArgs.LocalLlama,
            ChatActivity.integrityArgsForBackend(SecureStorage.BACKEND_LOCAL),
        )
    }

    @Test
    fun `BACKEND_LITERT_NPU maps to LiteRtNpu`() {
        assertSame(
            ChatActivity.IntegrityArgs.LiteRtNpu,
            ChatActivity.integrityArgsForBackend(SecureStorage.BACKEND_LITERT_NPU),
        )
    }

    @Test
    fun `BACKEND_CLOUD maps to Cloud`() {
        assertSame(
            ChatActivity.IntegrityArgs.Cloud,
            ChatActivity.integrityArgsForBackend(SecureStorage.BACKEND_CLOUD),
        )
    }

    @Test
    fun `BACKEND_QWEN_CLOUD maps to Cloud`() {
        assertSame(
            ChatActivity.IntegrityArgs.Cloud,
            ChatActivity.integrityArgsForBackend(SecureStorage.BACKEND_QWEN_CLOUD),
        )
    }

    @Test
    fun `BACKEND_E2E_CLOUD maps to Cloud`() {
        assertSame(
            ChatActivity.IntegrityArgs.Cloud,
            ChatActivity.integrityArgsForBackend(SecureStorage.BACKEND_E2E_CLOUD),
        )
    }

    @Test
    fun `unknown backend strings fall back to Cloud`() {
        // Defensive: an unrecognised mode (e.g. a stale value persisted
        // by an older build, or a future backend we haven't taught the
        // badge about yet) MUST hide the chip rather than crash or
        // assert against a manager that can't materialise.
        assertSame(
            ChatActivity.IntegrityArgs.Cloud,
            ChatActivity.integrityArgsForBackend("future_backend_that_doesnt_exist"),
        )
        assertSame(
            ChatActivity.IntegrityArgs.Cloud,
            ChatActivity.integrityArgsForBackend(""),
        )
    }

    @Test
    fun `every distinct backend constant yields a stable mapping`() {
        // Sanity table — if a constant gets renamed but the when-table
        // in integrityArgsForBackend isn't updated, this catches the
        // silent fall-through to Cloud.
        val expected = mapOf(
            SecureStorage.BACKEND_LOCAL to ChatActivity.IntegrityArgs.LocalLlama,
            SecureStorage.BACKEND_LITERT_NPU to ChatActivity.IntegrityArgs.LiteRtNpu,
            SecureStorage.BACKEND_CLOUD to ChatActivity.IntegrityArgs.Cloud,
            SecureStorage.BACKEND_QWEN_CLOUD to ChatActivity.IntegrityArgs.Cloud,
            SecureStorage.BACKEND_E2E_CLOUD to ChatActivity.IntegrityArgs.Cloud,
        )
        for ((mode, tag) in expected) {
            assertEquals(
                "backend mode $mode should map to $tag",
                tag,
                ChatActivity.integrityArgsForBackend(mode),
            )
        }
    }
}

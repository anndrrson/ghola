package xyz.ghola.app.ai.litert

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import xyz.ghola.app.ai.litert.LiteRtModelManager.ModelStatus
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Unit tests for [LiteRtModelManager]. These run on the pure-JVM
 * unit-test classpath (no Robolectric) by injecting a temp dir +
 * variant directly into the internal constructor — production code
 * still uses the [android.content.Context] entrypoint.
 *
 * Coverage matrix:
 *   1. `isModelDownloaded()` false when nothing on disk
 *   2. `isModelDownloaded()` true after a file appears
 *   3. `isModelVerified()` returns NOT_DOWNLOADED when file absent
 *   4. `isModelVerified()` returns DOWNLOADED_UNVERIFIED when pin is null
 *      (today's pass-through posture — see [xyz.ghola.app.ai.PinnedModelHashes])
 *   5. `isModelVerified()` TAMPERED branch reachable via the
 *      IntegrityVerifier-with-spoofed-pin comparator (the same
 *      predicate the manager's runDownload uses)
 *   6. Cancel flag respected: pre-arm `cancelDownload()` then invoke
 *      the blocking download — must emit `onError("Download cancelled")`
 *      and produce no completion callback
 *   7. Range-resume: pre-existing partial file is appended to, not
 *      re-downloaded — verified by checking the `Range` header on the
 *      MockWebServer request log AND that the final on-disk file
 *      equals (partial bytes) + (server response bytes)
 *   8. Full fresh download succeeds end-to-end and the `onComplete`
 *      path returns the correct absolute path
 *   9. Variant override: manager constructed with `Mt6989` writes to
 *      that variant's filename, not the Generic one
 *  10. 401 handling: MockWebServer returns 401, listener gets the
 *      stable [LiteRtModelManager.ERR_GATED_REPO] error message
 *  11. HF token present → request has `Authorization: Bearer …` header
 *  12. HF token absent → request has no `Authorization` header
 *  13. (bonus) formatSize human-readable buckets
 */
class LiteRtModelManagerTest {

    private lateinit var tempDir: File
    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        tempDir = kotlin.io.path.createTempDirectory("litert-model-test-").toFile()
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
        tempDir.deleteRecursively()
    }

    /**
     * Build a manager pinned to a specific variant + temp dir + URL
     * override. Default variant is [LiteRtVariant.Generic] because
     * the legacy tests were written against the single-variant world
     * and the Generic bundle is the closest analogue.
     */
    private fun newManager(
        urlOverride: String? = null,
        variant: LiteRtVariant = LiteRtVariant.Generic,
        hfToken: String? = null,
    ): LiteRtModelManager {
        return LiteRtModelManager(
            context = null,
            activeVariant = variant,
            modelsDirOverride = tempDir,
            urlOverride = urlOverride,
            // When `hfToken` is null we still inject a resolver that
            // returns null — defeating the SecureStorage fallback,
            // which would NPE because context=null.
            hfTokenOverride = { hfToken },
        )
    }

    private fun expectedModelFile(variant: LiteRtVariant = LiteRtVariant.Generic): File =
        File(tempDir, variant.filename)

    /** Capturing listener — records exactly one terminal callback. */
    private class CapturingListener : LiteRtModelManager.DownloadListener {
        val latch = CountDownLatch(1)
        val terminal = AtomicReference<String>()
        val completePath = AtomicReference<String?>()
        val errorMsg = AtomicReference<String?>()
        var progressCount = 0

        override fun onProgress(downloaded: Long, total: Long, percent: Int) {
            progressCount++
        }

        override fun onComplete(path: String) {
            completePath.set(path)
            if (terminal.compareAndSet(null, "complete")) latch.countDown()
        }

        override fun onError(message: String) {
            errorMsg.set(message)
            if (terminal.compareAndSet(null, "error")) latch.countDown()
        }
    }

    // ── Test 1 + 2: isModelDownloaded ────────────────────────────────

    @Test
    fun isModelDownloaded_falseWhenAbsent_trueWhenPresent() {
        val mgr = newManager()
        assertEquals(false, mgr.isModelDownloaded())

        expectedModelFile().writeBytes(ByteArray(128) { it.toByte() })
        assertEquals(true, mgr.isModelDownloaded())
        assertEquals(128L, mgr.getModelSizeBytes())
    }

    // ── Test 3: isModelVerified NOT_DOWNLOADED ───────────────────────

    @Test
    fun isModelVerified_returnsNotDownloadedWhenFileAbsent() = runBlocking {
        val mgr = newManager()
        assertEquals(ModelStatus.NOT_DOWNLOADED, mgr.isModelVerified())
        // getModelPath must also refuse to expose a path.
        assertNull(mgr.getModelPath())
    }

    // ── Test 4: isModelVerified DOWNLOADED_UNVERIFIED (null pin) ─────

    @Test
    fun isModelVerified_returnsUnverifiedWhenPinIsNull() = runBlocking {
        // PinnedModelHashes.forVariant(...) is null today for every
        // variant — this is the production posture under test.
        val mgr = newManager()
        expectedModelFile().writeBytes("fake-litertlm-bytes".toByteArray())

        assertEquals(ModelStatus.DOWNLOADED_UNVERIFIED, mgr.isModelVerified())
        // Pass-through means getModelPath returns the absolute path.
        assertEquals(expectedModelFile().absolutePath, mgr.getModelPath())
    }

    // ── Test 5: TAMPERED branch reachable via IntegrityVerifier ──────

    @Test
    fun isModelVerified_tamperedBranchReachableViaPinnedHashMismatch() = runBlocking {
        // Sanity precondition: write a file and confirm pass-through.
        val mgr = newManager()
        val payload = "tampered-payload-bytes".toByteArray()
        expectedModelFile().writeBytes(payload)

        // With pin=null (today's posture) we're in DOWNLOADED_UNVERIFIED.
        // The TAMPERED branch fires when (pin != null && !result.match).
        // We exercise the same branch via the IntegrityVerifier comparator
        // directly using a wrong-pin to prove the gating logic the manager
        // uses (see runDownload's pin != null && !verifyResult.match).
        val wrongPin =
            "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        val cmp = xyz.ghola.app.ai.IntegrityVerifier
            .verifyFile(expectedModelFile(), wrongPin)
        assertEquals(false, cmp.match)
        assertNotNull(cmp.reason)
        assertTrue(
            "pin-mismatch is the exact predicate the TAMPERED branch uses",
            cmp.reason!!.contains("mismatch"),
        )
        // And confirm the manager's own status helper sees the file
        // as DOWNLOADED_UNVERIFIED today (the null-pin pass-through).
        assertEquals(ModelStatus.DOWNLOADED_UNVERIFIED, mgr.isModelVerified())
    }

    // ── Test 6: cancel flag respected ────────────────────────────────

    @Test
    fun cancelDownload_preArmedAbortsImmediately() {
        // Server enqueues a long body; we cancel before invoking the
        // blocking download so the loop bails on its first iteration.
        val body = Buffer().apply {
            write(ByteArray(64 * 1024) { (it and 0xFF).toByte() })
        }
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(body),
        )

        val mgr = newManager(urlOverride = server.url("/Gemma3.litertlm").toString())
        val listener = CapturingListener()

        mgr.cancelDownload() // pre-arm
        mgr.downloadModelBlocking(listener)

        assertEquals("error", listener.terminal.get())
        assertEquals("Download cancelled", listener.errorMsg.get())
        assertNull(listener.completePath.get())
    }

    // ── Test 7: Range-resume appends rather than re-downloads ────────

    @Test
    fun downloadModel_rangeResumeAppendsToPartialFile() {
        // Stage a partial file on disk first.
        val partialBytes = "partial-prefix-".toByteArray()
        expectedModelFile().writeBytes(partialBytes)

        // Server responds 206 Partial Content with the suffix bytes.
        val suffixBytes = "suffix-from-server".toByteArray()
        server.enqueue(
            MockResponse()
                .setResponseCode(206)
                .addHeader(
                    "Content-Range",
                    "bytes ${partialBytes.size}-" +
                        "${partialBytes.size + suffixBytes.size - 1}/" +
                        "${partialBytes.size + suffixBytes.size}",
                )
                .setBody(Buffer().apply { write(suffixBytes) }),
        )

        val mgr = newManager(urlOverride = server.url("/Gemma3.litertlm").toString())
        val listener = CapturingListener()
        mgr.downloadModelBlocking(listener)

        // The request line must carry a Range header anchored at the
        // partial file's current size.
        val req: RecordedRequest = server.takeRequest(2, TimeUnit.SECONDS)
            ?: error("MockWebServer did not receive a request")
        assertEquals(
            "bytes=${partialBytes.size}-",
            req.getHeader("Range"),
        )

        // Completion: file is prefix + suffix.
        assertEquals("complete", listener.terminal.get())
        val onDisk = expectedModelFile().readBytes()
        assertEquals(
            String(partialBytes + suffixBytes, Charsets.UTF_8),
            String(onDisk, Charsets.UTF_8),
        )
    }

    // ── Test 8: full fresh download end-to-end ───────────────────────

    @Test
    fun downloadModel_freshDownloadSucceedsAndReportsPath() {
        // No pre-existing file. Server returns 200 with full body.
        assertEquals(false, expectedModelFile().exists())
        val payload = ByteArray(40 * 1024) { ((it * 7) and 0xFF).toByte() }
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(Buffer().apply { write(payload) }),
        )

        val mgr = newManager(urlOverride = server.url("/Gemma3.litertlm").toString())
        val listener = CapturingListener()
        mgr.downloadModelBlocking(listener)

        assertEquals("complete", listener.terminal.get())
        assertEquals(expectedModelFile().absolutePath, listener.completePath.get())

        // No Range header on a fresh download.
        val req = server.takeRequest(2, TimeUnit.SECONDS)
            ?: error("MockWebServer did not receive a request")
        assertNull(req.getHeader("Range"))

        // Bytes round-trip exactly.
        val onDisk = expectedModelFile().readBytes()
        assertEquals(payload.size, onDisk.size)
        assertTrue(payload.contentEquals(onDisk))

        // And progress callbacks were emitted at least once.
        assertTrue(
            "at least one progress callback expected on a 40 KiB download",
            listener.progressCount >= 1,
        )
    }

    // ── Test 9: variant override writes to the variant's filename ────

    @Test
    fun variantOverride_writesToSocPinnedFilename() {
        val payload = ByteArray(16 * 1024) { it.toByte() }
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(Buffer().apply { write(payload) }),
        )

        val mgr = newManager(
            urlOverride = server.url("/whatever.litertlm").toString(),
            variant = LiteRtVariant.Mt6989,
        )
        val listener = CapturingListener()
        mgr.downloadModelBlocking(listener)

        assertEquals("complete", listener.terminal.get())
        // The on-disk file lives at the Mt6989 variant's filename,
        // NOT the Generic filename — proves variant dispatch.
        val mt6989Path = File(tempDir, LiteRtVariant.Mt6989.filename)
        assertTrue(
            "Mt6989 variant must land at ${LiteRtVariant.Mt6989.filename}",
            mt6989Path.exists(),
        )
        assertEquals(mt6989Path.absolutePath, listener.completePath.get())
        // And the Generic filename must NOT exist (sanity: no
        // cross-contamination between variants).
        assertEquals(
            false,
            File(tempDir, LiteRtVariant.Generic.filename).exists(),
        )
        // activeVariant accessor surfaces the variant for UI use.
        assertEquals(LiteRtVariant.Mt6989, mgr.activeVariant)
    }

    // ── Test 10: 401 → ERR_GATED_REPO ────────────────────────────────

    @Test
    fun downloadModel_401MapsToGatedRepoError() {
        server.enqueue(
            MockResponse()
                .setResponseCode(401)
                .setBody("gated"),
        )

        val mgr = newManager(urlOverride = server.url("/Gemma3.litertlm").toString())
        val listener = CapturingListener()
        mgr.downloadModelBlocking(listener)

        assertEquals("error", listener.terminal.get())
        assertEquals(LiteRtModelManager.ERR_GATED_REPO, listener.errorMsg.get())
        assertNull(listener.completePath.get())
        // And no file was written on disk (401 short-circuits before
        // the write loop).
        assertEquals(false, expectedModelFile().exists())
    }

    // ── Test 11: HF token present → Authorization header attached ────

    @Test
    fun downloadModel_attachesAuthorizationHeaderWhenTokenPresent() {
        val payload = ByteArray(8 * 1024) { it.toByte() }
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(Buffer().apply { write(payload) }),
        )

        val mgr = newManager(
            urlOverride = server.url("/Gemma3.litertlm").toString(),
            hfToken = "hf_test_token_abc123",
        )
        val listener = CapturingListener()
        mgr.downloadModelBlocking(listener)

        assertEquals("complete", listener.terminal.get())
        val req = server.takeRequest(2, TimeUnit.SECONDS)
            ?: error("MockWebServer did not receive a request")
        assertEquals(
            "Bearer hf_test_token_abc123",
            req.getHeader("Authorization"),
        )
    }

    // ── Test 12: HF token absent → no Authorization header ───────────

    @Test
    fun downloadModel_omitsAuthorizationHeaderWhenTokenAbsent() {
        val payload = ByteArray(8 * 1024) { it.toByte() }
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(Buffer().apply { write(payload) }),
        )

        val mgr = newManager(
            urlOverride = server.url("/Gemma3.litertlm").toString(),
            hfToken = null,
        )
        val listener = CapturingListener()
        mgr.downloadModelBlocking(listener)

        assertEquals("complete", listener.terminal.get())
        val req = server.takeRequest(2, TimeUnit.SECONDS)
            ?: error("MockWebServer did not receive a request")
        assertNull(
            "anonymous request must not carry an Authorization header",
            req.getHeader("Authorization"),
        )
    }

    // ── formatSize sanity (cheap extra) ──────────────────────────────

    @Test
    fun formatSize_humanReadableBuckets() {
        val mgr = newManager()
        assertEquals("0 B", mgr.formatSize(0))
        assertEquals("1.0 KB", mgr.formatSize(1024))
        assertEquals("1.0 MB", mgr.formatSize(1_048_576))
        assertEquals("1.0 GB", mgr.formatSize(1_073_741_824))
    }
}

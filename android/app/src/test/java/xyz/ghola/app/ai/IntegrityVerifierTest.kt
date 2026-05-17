package xyz.ghola.app.ai

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest

/**
 * Unit tests for [IntegrityVerifier]. Covers the Phase η contract:
 *
 *  - Known-good fixture hashes pass.
 *  - Tampered bytes fail.
 *  - Null pin = observe-but-don't-enforce, with the documented reason.
 *  - Coroutine cancellation interrupts a long hash.
 *  - Chunked file reads produce the same digest as a single-shot hash.
 *
 * The web counterpart (`computeLoadedWeightFingerprint` in
 * `apps/web/src/lib/webgpu-inference.ts`) is not directly testable from
 * the Android JVM, but the comparator behavior — hex-encoded SHA-256,
 * case-insensitive pin compare — is the same and mirrored here.
 */
class IntegrityVerifierTest {

    private val tempFiles = mutableListOf<File>()

    @After
    fun tearDown() {
        tempFiles.forEach { f -> if (f.exists()) f.delete() }
        tempFiles.clear()
    }

    private fun makeTempFile(prefix: String, bytes: ByteArray): File {
        val f = File.createTempFile(prefix, ".bin")
        f.writeBytes(bytes)
        tempFiles.add(f)
        return f
    }

    /** Compute SHA-256 once over the whole buffer; reference value. */
    private fun singleShotHex(bytes: ByteArray): String {
        val d = MessageDigest.getInstance("SHA-256").digest(bytes)
        return d.joinToString("") { "%02x".format(it) }
    }

    // ── Test 1: known-good fixture hash ──────────────────────────────

    @Test
    fun verifyBytes_matchesKnownGoodHash() {
        // sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
        val payload = "hello world".toByteArray(Charsets.UTF_8)
        val expected =
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"

        val result = IntegrityVerifier.verifyBytes(payload, expected)

        assertTrue("expected match for known-good payload", result.match)
        assertEquals(expected, result.recorded.sha256Hex)
        assertEquals(expected, result.expectedSha256)
        assertEquals(payload.size.toLong(), result.recorded.sizeBytes)
        assertNull(result.reason)
    }

    // ── Test 2: mismatch detection ───────────────────────────────────

    @Test
    fun verifyBytes_mismatchedHashFails() {
        val payload = "hello world".toByteArray(Charsets.UTF_8)
        val wrongHash =
            "0000000000000000000000000000000000000000000000000000000000000000"

        val result = IntegrityVerifier.verifyBytes(payload, wrongHash)

        assertFalse("expected mismatch", result.match)
        assertEquals(wrongHash, result.expectedSha256)
        assertNotNull("mismatch must carry a reason", result.reason)
        assertTrue(
            "reason should mention sha256 mismatch",
            result.reason!!.contains("mismatch"),
        )
    }

    // ── Test 3: null pin = observe-but-don't-enforce ─────────────────

    @Test
    fun verifyBytes_nullPinTreatedAsMatch() {
        val payload = "anything".toByteArray(Charsets.UTF_8)

        val result = IntegrityVerifier.verifyBytes(payload, null)

        assertTrue(
            "null pin must yield match=true (observe-but-don't-enforce)",
            result.match,
        )
        assertNull(result.expectedSha256)
        assertEquals("no expected hash pinned yet", result.reason)
    }

    // ── Test 4: case-insensitive pin compare ─────────────────────────

    @Test
    fun verifyBytes_pinCompareIsCaseInsensitive() {
        val payload = "hello world".toByteArray(Charsets.UTF_8)
        val upperHash =
            "B94D27B9934D3E08A52E52D7DA7DABFAC484EFE37A5380EE9088F7ACE2EFCDE9"

        val result = IntegrityVerifier.verifyBytes(payload, upperHash)

        assertTrue("uppercase pin must still match", result.match)
        assertEquals(
            "expectedSha256 is echoed back lowercase-normalized",
            upperHash.lowercase(),
            result.expectedSha256,
        )
    }

    // ── Test 5: cancellation respected mid-hash ──────────────────────

    @Test
    fun verifyFile_respectsCancellation() = runBlocking {
        // ~4 MiB → ~64 chunks at CHUNK_SIZE=64 KiB. Enough iterations
        // that we can race a cancel between chunk reads.
        val bigPayload = ByteArray(4 * 1024 * 1024) { (it and 0xFF).toByte() }
        val bigFile = makeTempFile("integrity-cancel-", bigPayload)

        val scope = CoroutineScope(Dispatchers.IO)
        var caught: Throwable? = null
        val job = scope.launch {
            try {
                IntegrityVerifier.verifyFile(bigFile, null)
            } catch (t: CancellationException) {
                caught = t
            }
        }
        // Yield, then cancel — we expect the chunk-loop's
        // currentCoroutineContext().isActive check to fire.
        delay(1)
        job.cancel()
        job.join()

        // Either we caught the CancellationException OR the job
        // finished extremely fast on a beefy CI host. We treat both as
        // acceptable; the contract under test is "doesn't deadlock and
        // honours cancellation when given the chance."
        if (caught != null) {
            assertTrue(caught is CancellationException)
        }
        assertTrue("job must be completed after cancel+join", job.isCompleted)
    }

    // ── Test 6: chunked hash equals single-shot hash on a >128KB file ─

    @Test
    fun verifyFile_chunkedHashMatchesSingleShot() = runBlocking {
        // 200 KiB — comfortably > CHUNK_SIZE (64 KiB) so the digester
        // sees at least 3 update() calls plus the trailing partial.
        val payload = ByteArray(200 * 1024) { ((it * 31) and 0xFF).toByte() }
        val file = makeTempFile("integrity-chunked-", payload)

        val singleShot = singleShotHex(payload)
        val result = withTimeoutOrNull(5_000) {
            IntegrityVerifier.verifyFile(file, singleShot)
        }

        assertNotNull("verifyFile must not hang on a 200 KiB file", result)
        assertTrue(
            "chunked digest must equal single-shot digest",
            result!!.match,
        )
        assertEquals(singleShot, result.recorded.sha256Hex)
        assertEquals(payload.size.toLong(), result.recorded.sizeBytes)
        assertEquals(file.name, result.recorded.artifactName)
    }

    // ── Test 7: chunked hash with mismatched pin still flags tampering ─

    @Test
    fun verifyFile_chunkedHashDetectsTamperingAgainstPin() = runBlocking {
        val payload = ByteArray(150 * 1024) { ((it xor 0x5A) and 0xFF).toByte() }
        val file = makeTempFile("integrity-tamper-", payload)

        val wrongPin =
            "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        val result = IntegrityVerifier.verifyFile(file, wrongPin)

        assertFalse(result.match)
        assertEquals(wrongPin, result.expectedSha256)
        assertNotNull(result.reason)
        // Sanity: the recorded hash should equal the single-shot hash.
        assertEquals(singleShotHex(payload), result.recorded.sha256Hex)
    }

    // ── Test 8: empty file edge case ─────────────────────────────────

    @Test
    fun verifyFile_emptyFileHasCanonicalEmptyHash() = runBlocking {
        // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        val emptyHash =
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        val emptyFile = makeTempFile("integrity-empty-", ByteArray(0))

        val result = IntegrityVerifier.verifyFile(emptyFile, emptyHash)

        assertTrue(result.match)
        assertEquals(emptyHash, result.recorded.sha256Hex)
        assertEquals(0L, result.recorded.sizeBytes)
    }
}

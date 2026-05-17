package xyz.ghola.app.ai

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

/**
 * On-device model integrity verifier.
 *
 * Kotlin port of `computeLoadedWeightFingerprint` from the web bundle at
 * `apps/web/src/lib/webgpu-inference.ts` (see the function defined at the
 * bottom of that file and the pinned-SRI block
 * `DEFAULT_WEBGPU_MODEL_INTEGRITY` near the top).
 *
 * Web counterpart, recapped:
 *   - WebLLM stores model artifacts in three CacheStorage scopes and the
 *     web helper SHA-256s every entry, joins them as a sorted
 *     `"<url>\t<sha256>"` manifest, then SHA-256s the manifest to produce
 *     a single fingerprint string. The fingerprint is later compared
 *     against the on-chain `weights_hash` published by
 *     `ghola-model-registry`.
 *
 * Android counterpart (this file):
 *   - We don't have CacheStorage; instead the active model is a single
 *     `.gguf` / `.task` / `.litertlm` file produced by
 *     [xyz.ghola.app.ai.llama.ModelManager]. The artifact-on-disk model
 *     means we can collapse the multi-file manifest step — the
 *     fingerprint is just `sha256(file)` and the registry-side
 *     `weights_hash` for native artifacts must be computed the same way
 *     (a TODO in the registry tooling, tracked by Phase η of the plan).
 *
 * Threat model:
 *   - We assume the disk is trustworthy enough to read but not trustworthy
 *     enough to *be* the source of truth. A pinned hash (compiled into the
 *     APK, eventually anchored on Solana) is the source of truth; this
 *     class is the comparator.
 *   - A null pinned hash means "no expectation yet" — the result is
 *     match=true with a reason string so callers can ship today and start
 *     enforcing on the day the registry path lands without a behavior
 *     change in the comparator itself.
 *
 * No network calls. No on-chain lookup in this turn. No external
 * dependencies beyond `java.security.MessageDigest`, `java.io`, and
 * `kotlinx.coroutines` (already on the classpath via
 * `kotlinx-coroutines-android`).
 */
object IntegrityVerifier {

    /**
     * Chunk size for streaming the file into the SHA-256 digester. 64 KiB
     * is a deliberate compromise: large enough that the
     * [MessageDigest.update] call dominates per-iteration syscall
     * overhead on the multi-GB GGUF artifact, small enough that we never
     * allocate the whole 1.6 GB model in a single buffer (the Android
     * heap would not survive it).
     */
    internal const val CHUNK_SIZE: Int = 64 * 1024

    /**
     * The record of a single integrity check. Mirrors the per-file shape
     * inside `WeightFingerprint` in the web counterpart at
     * `apps/web/src/lib/webgpu-inference.ts` — there the `files` array
     * carries `{url, sha256, byteLength}` entries; here the artifact name
     * stands in for the URL since the file is local.
     *
     * @property artifactName human-readable artifact identifier (typically
     *   the file basename). Equivalent to the `url` field on the web.
     * @property sizeBytes file size in bytes at the moment the hash was
     *   computed. Equivalent to `byteLength` on the web.
     * @property sha256Hex lowercase hexadecimal SHA-256 digest, no `0x`
     *   prefix, 64 chars.
     * @property verifiedAt epoch millis at completion of the hash; useful
     *   when surfaced in audit logs.
     */
    data class IntegrityRecord(
        val artifactName: String,
        val sizeBytes: Long,
        val sha256Hex: String,
        val verifiedAt: Long,
    )

    /**
     * Outcome of a verification call. The [recorded] field is always
     * populated (the hash was computed regardless of whether a pin
     * exists); [match] reflects the comparison against [expectedSha256].
     *
     * When [expectedSha256] is `null`, the verifier is in
     * "observe-but-don't-enforce" mode: [match] is `true` and [reason]
     * explains why. This is intentional — see the class-level KDoc.
     *
     * @property match `true` if the on-disk hash matches the pin (or if
     *   no pin was supplied — see KDoc).
     * @property recorded the hash computed from the on-disk artifact.
     * @property expectedSha256 the pin that was supplied to the verifier
     *   (echoed back, lowercase-normalized when present).
     * @property reason human-readable diagnostic; non-null on no-pin and
     *   on mismatch, null on a clean pinned match.
     */
    data class IntegrityResult(
        val match: Boolean,
        val recorded: IntegrityRecord,
        val expectedSha256: String?,
        val reason: String?,
    )

    /**
     * Hash [file] in [CHUNK_SIZE]-byte chunks and compare to
     * [expectedSha256].
     *
     * Cooperates with structured concurrency: between chunks we check
     * `currentCoroutineContext().isActive` and abort with a
     * [kotlinx.coroutines.CancellationException] if the caller has
     * cancelled. (We don't throw [InterruptedException]; the coroutines
     * cancellation contract is the source of truth here.)
     *
     * @param expectedSha256 expected lowercase or uppercase hex SHA-256.
     *   Case-insensitive. Pass `null` to compute the hash without
     *   enforcing a comparison (returns [IntegrityResult.match] = true
     *   with a non-null [IntegrityResult.reason]).
     *
     * @throws java.io.IOException if the file cannot be read.
     * @throws kotlinx.coroutines.CancellationException if the calling
     *   coroutine is cancelled mid-hash.
     *
     * Web counterpart (for human reviewers, not a resolvable Kotlin link):
     *   `computeLoadedWeightFingerprint` in
     *   `apps/web/src/lib/webgpu-inference.ts`.
     */
    suspend fun verifyFile(file: File, expectedSha256: String?): IntegrityResult {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(CHUNK_SIZE)
        var totalRead = 0L

        FileInputStream(file).use { input ->
            while (true) {
                // Cooperate with coroutine cancellation between chunks.
                // We do NOT check inside the read() call itself because
                // FileInputStream.read is uninterruptible on most JVMs;
                // checking between chunks bounds the worst-case latency
                // to a single 64 KiB read.
                if (!currentCoroutineContext().isActive) {
                    throw kotlinx.coroutines.CancellationException(
                        "IntegrityVerifier.verifyFile cancelled after $totalRead bytes",
                    )
                }
                val read = input.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
                totalRead += read
            }
        }

        val hex = bytesToHex(digest.digest())
        val record = IntegrityRecord(
            artifactName = file.name,
            sizeBytes = totalRead,
            sha256Hex = hex,
            verifiedAt = System.currentTimeMillis(),
        )
        return compare(record, expectedSha256)
    }

    /**
     * In-memory variant of [verifyFile]. Convenient for tests and for
     * small artifacts (config JSON, tokenizer.json) where holding the
     * whole payload in a [ByteArray] is reasonable. For the multi-GB
     * model weight files, always use [verifyFile].
     *
     * Synchronous because the input is already resident — there's no
     * I/O to cancel.
     *
     * @param expectedSha256 see [verifyFile].
     */
    fun verifyBytes(bytes: ByteArray, expectedSha256: String?): IntegrityResult {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        val record = IntegrityRecord(
            artifactName = "<in-memory>",
            sizeBytes = bytes.size.toLong(),
            sha256Hex = bytesToHex(digest),
            verifiedAt = System.currentTimeMillis(),
        )
        return compare(record, expectedSha256)
    }

    /**
     * Shared comparator. Centralizes the case-insensitive hex
     * comparison + the null-pin escape hatch so [verifyFile] and
     * [verifyBytes] cannot drift.
     */
    private fun compare(
        record: IntegrityRecord,
        expectedSha256: String?,
    ): IntegrityResult {
        if (expectedSha256 == null) {
            return IntegrityResult(
                match = true,
                recorded = record,
                expectedSha256 = null,
                reason = "no expected hash pinned yet",
            )
        }
        val normalized = expectedSha256.trim().lowercase()
        val actual = record.sha256Hex // already lowercase per bytesToHex
        return if (normalized == actual) {
            IntegrityResult(
                match = true,
                recorded = record,
                expectedSha256 = normalized,
                reason = null,
            )
        } else {
            IntegrityResult(
                match = false,
                recorded = record,
                expectedSha256 = normalized,
                reason = "sha256 mismatch: expected=$normalized actual=$actual",
            )
        }
    }

    /**
     * Lowercase-hex encoder. Mirrors the `bytesToHex` helper at the
     * bottom of `apps/web/src/lib/webgpu-inference.ts` (same algorithm:
     * pad each byte to two hex chars, concatenate).
     */
    private fun bytesToHex(b: ByteArray): String {
        val sb = StringBuilder(b.size * 2)
        for (byte in b) {
            val v = byte.toInt() and 0xFF
            val hi = v ushr 4
            val lo = v and 0x0F
            sb.append(HEX[hi])
            sb.append(HEX[lo])
        }
        return sb.toString()
    }

    private val HEX = charArrayOf(
        '0', '1', '2', '3', '4', '5', '6', '7',
        '8', '9', 'a', 'b', 'c', 'd', 'e', 'f',
    )
}

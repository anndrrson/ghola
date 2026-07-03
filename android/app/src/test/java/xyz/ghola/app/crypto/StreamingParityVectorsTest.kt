package xyz.ghola.app.crypto

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

/**
 * Wire-format parity gate for the streaming envelope path against
 * `crates/said-envelope::streaming`.
 *
 * The committed `streaming_vectors.json` is regenerated on every CI run
 * by:
 *
 *   cargo run -p said-envelope --example gen_streaming_vectors -- \
 *     --out android/app/src/test/resources/streaming_vectors.json
 *
 * followed by `git diff --exit-code`. Drift in any of these surfaces
 * blocks the build:
 *
 *   - `derive_chunk_nonce` (HKDF salt/info, big-endian index packing)
 *   - `build_chunk_ad` (stream_id bytes || index BE || is_final byte)
 *   - `seal_chunk` / `open_chunk` (AES-256-GCM AAD wiring)
 *   - `TranscriptHasher` (len-prefixed framing of cipher chunks)
 *   - `EnvelopeReceipt::sign` (canonical domain-separated signing input)
 *
 * Beyond byte-exact match, this test also exercises three attack
 * sweeps the audit named specifically:
 *
 *   - **Tamper**: flip one bit in each ciphertext chunk → `openChunk` must throw.
 *   - **Reorder**: try to open chunk N's ciphertext at index N±1 → must throw.
 *   - **Replay**: replace chunk N with a copy of chunk N-1 → must throw.
 *
 * The replay sweep is what would catch an off-by-one in the Kotlin port's
 * chunk-index nonce derivation: if Kotlin computed `derive_chunk_nonce(dek,
 * index - 1)` instead of `index`, the same nonce would be reused across two
 * sealed chunks and `openChunk(index = 1, ct = ct_for_0)` would succeed.
 */
class StreamingParityVectorsTest {

    companion object {
        @JvmStatic
        @BeforeClass
        fun setUp() {
            CryptoProviders.installBouncyCastleOnce()
        }
    }

    @Test
    fun chunk_vectors_byte_exact_seal_and_open() {
        val doc = loadDoc()
        val arr = doc.getJSONArray("chunks")
        require(arr.length() > 0) { "no chunk vectors" }

        for (i in 0 until arr.length()) {
            val v = arr.getJSONObject(i)
            val name = v.getString("name")
            val dek = hex(v.getString("dek_hex"))
            val streamId = v.getString("stream_id")
            val expected = v.getJSONArray("chunks")

            // For each chunk: derive nonce, seal, and assert byte-exact
            // match against the Rust-produced fixture.
            val sealedCts = ArrayList<ByteArray>(expected.length())
            for (j in 0 until expected.length()) {
                val e = expected.getJSONObject(j)
                val index = e.getInt("index")
                val isFinal = e.getBoolean("is_final")
                val pt = hex(e.getString("plaintext_hex"))
                val expectedNonce = hex(e.getString("nonce_hex"))
                val expectedAd = hex(e.getString("associated_data_hex"))
                val expectedCt = hex(e.getString("ciphertext_hex"))

                val nonce = EnvelopeStreaming.deriveChunkNonce(dek, index)
                assertArrayEquals("[$name][$index] nonce", expectedNonce, nonce)

                // We rebuild the AD here purely to assert the wire format —
                // `sealChunk` constructs it internally with the same bytes.
                val ad = buildAd(streamId, index, isFinal)
                assertArrayEquals("[$name][$index] AD", expectedAd, ad)

                val ct = EnvelopeStreaming.sealChunk(dek, index, isFinal, streamId, pt)
                assertArrayEquals("[$name][$index] ciphertext", expectedCt, ct)
                sealedCts.add(ct)
            }

            // Transcript hash must match end-to-end.
            val hasher = EnvelopeStreaming.TranscriptHasher()
            for (ct in sealedCts) hasher.update(ct)
            assertArrayEquals(
                "[$name] transcript_sha256",
                hex(v.getString("transcript_sha256_hex")),
                hasher.finalize(),
            )

            // And openChunk on each must recover the original plaintext.
            for (j in 0 until expected.length()) {
                val e = expected.getJSONObject(j)
                val index = e.getInt("index")
                val isFinal = e.getBoolean("is_final")
                val expectedPt = hex(e.getString("plaintext_hex"))
                val ct = hex(e.getString("ciphertext_hex"))
                val pt = EnvelopeStreaming.openChunk(dek, index, isFinal, streamId, ct)
                assertArrayEquals("[$name][$index] open->plaintext", expectedPt, pt)
            }
        }
    }

    @Test
    fun chunk_vectors_tamper_sweep() {
        val doc = loadDoc()
        val arr = doc.getJSONArray("chunks")

        for (i in 0 until arr.length()) {
            val v = arr.getJSONObject(i)
            val name = v.getString("name")
            val dek = hex(v.getString("dek_hex"))
            val streamId = v.getString("stream_id")
            val expected = v.getJSONArray("chunks")

            for (j in 0 until expected.length()) {
                val e = expected.getJSONObject(j)
                val index = e.getInt("index")
                val isFinal = e.getBoolean("is_final")
                val ct = hex(e.getString("ciphertext_hex"))

                // Flip one bit in the first byte of the ciphertext.
                val tampered = ct.copyOf()
                tampered[0] = (tampered[0].toInt() xor 0x01).toByte()
                assertThrows(
                    "[$name][$index] tampered ct must fail",
                    Envelope.EnvelopeError.AeadFailed::class.java,
                ) {
                    EnvelopeStreaming.openChunk(dek, index, isFinal, streamId, tampered)
                }

                // Also flip a bit in the AEAD tag region (last byte).
                val tagTampered = ct.copyOf()
                tagTampered[tagTampered.size - 1] =
                    (tagTampered[tagTampered.size - 1].toInt() xor 0x01).toByte()
                assertThrows(
                    "[$name][$index] tampered tag must fail",
                    Envelope.EnvelopeError.AeadFailed::class.java,
                ) {
                    EnvelopeStreaming.openChunk(dek, index, isFinal, streamId, tagTampered)
                }
            }
        }
    }

    @Test
    fun chunk_vectors_reorder_sweep() {
        // Pick a multi-chunk vector and demonstrate that swapping chunks 1
        // and 2 (i.e. opening ct_for_1 at index 2 and vice-versa) fails.
        val v = findChunkCase("exact-multiple-3x16")
        val dek = hex(v.getString("dek_hex"))
        val streamId = v.getString("stream_id")
        val expected = v.getJSONArray("chunks")
        require(expected.length() >= 3) { "need >=3 chunks for reorder test" }

        val ct1 = hex(expected.getJSONObject(1).getString("ciphertext_hex"))
        val ct2 = hex(expected.getJSONObject(2).getString("ciphertext_hex"))
        val isFinal2 = expected.getJSONObject(2).getBoolean("is_final")
        val isFinal1 = expected.getJSONObject(1).getBoolean("is_final")

        // Open ct1 at index 2 (nonce + AD mismatch).
        assertThrows(
            "ct[1] opened at index 2 must fail",
            Envelope.EnvelopeError.AeadFailed::class.java,
        ) { EnvelopeStreaming.openChunk(dek, 2, isFinal2, streamId, ct1) }

        // Open ct2 at index 1 (nonce + AD mismatch; also is_final bit flips).
        assertThrows(
            "ct[2] opened at index 1 must fail",
            Envelope.EnvelopeError.AeadFailed::class.java,
        ) { EnvelopeStreaming.openChunk(dek, 1, isFinal1, streamId, ct2) }
    }

    @Test
    fun chunk_vectors_replay_sweep() {
        // The audit's named attack: replace chunk N with a copy of chunk
        // N-1 and try to open at index N. If the Kotlin port has an
        // off-by-one in `deriveChunkNonce` (e.g. used `index - 1`), the
        // ciphertext would round-trip and the replay would succeed.
        val v = findChunkCase("two-chunk-swap-fodder")
        val dek = hex(v.getString("dek_hex"))
        val streamId = v.getString("stream_id")
        val expected = v.getJSONArray("chunks")
        require(expected.length() == 2) { "two-chunk-swap-fodder must have 2 chunks" }

        val ct0 = hex(expected.getJSONObject(0).getString("ciphertext_hex"))
        val isFinal1 = expected.getJSONObject(1).getBoolean("is_final")

        // Replay ct0 as if it were the second chunk.
        assertThrows(
            "ct[0] replayed as ct[1] must fail",
            Envelope.EnvelopeError.AeadFailed::class.java,
        ) { EnvelopeStreaming.openChunk(dek, 1, isFinal1, streamId, ct0) }

        // Belt-and-braces: replay ct0 at every plausible "next" index.
        for (idx in intArrayOf(1, 2, 3, 100, 256, 1024)) {
            assertThrows(
                "ct[0] replayed at index $idx must fail",
                Envelope.EnvelopeError.AeadFailed::class.java,
            ) { EnvelopeStreaming.openChunk(dek, idx, false, streamId, ct0) }
        }
    }

    @Test
    fun receipt_vectors_verify_against_rust_signature() {
        val doc = loadDoc()
        val arr = doc.getJSONArray("receipts")
        require(arr.length() > 0) { "no receipt vectors" }

        for (i in 0 until arr.length()) {
            val v = arr.getJSONObject(i)
            val name = v.getString("name")
            val tx = hex(v.getString("transcript_sha256_hex"))

            // Reconstruct the receipt directly from the Rust-emitted
            // signature and verify it against the Kotlin Ed25519
            // verifier. A signature produced by Rust over the canonical
            // bytes must verify on Kotlin — that's the parity gate.
            val receipt = EnvelopeStreaming.EnvelopeReceipt(
                streamId = v.getString("stream_id"),
                model = v.getString("model"),
                inputTokens = v.getInt("input_tokens"),
                outputTokens = v.getInt("output_tokens"),
                completedAt = v.getLong("completed_at"),
                transcriptSha256Hex = v.getString("transcript_sha256_hex"),
                producerDid = v.getString("producer_did"),
                signatureHex = v.getString("expected_signature_hex"),
            )
            assertTrue(
                "[$name] Rust-signed receipt must verify on Kotlin",
                receipt.verify(tx),
            )

            // Tampering output_tokens after the fact must fail.
            val tampered = receipt.copy(outputTokens = receipt.outputTokens + 1)
            assertFalse(
                "[$name] tampered output_tokens must fail",
                tampered.verify(tx),
            )

            // Wrong transcript must fail.
            val wrong = tx.copyOf().also { it[0] = (it[0].toInt() xor 0x01).toByte() }
            assertFalse(
                "[$name] wrong transcript must fail",
                receipt.verify(wrong),
            )
        }
    }

    // ----- helpers --------------------------------------------------------

    private fun loadDoc(): JSONObject {
        val raw = javaClass.classLoader!!.getResourceAsStream("streaming_vectors.json")
            ?: error("streaming_vectors.json not found on classpath")
        return JSONObject(raw.bufferedReader(Charsets.UTF_8).readText())
    }

    private fun findChunkCase(name: String): JSONObject {
        val arr = loadDoc().getJSONArray("chunks")
        for (i in 0 until arr.length()) {
            val v = arr.getJSONObject(i)
            if (v.getString("name") == name) return v
        }
        error("missing chunk case: $name")
    }

    private fun buildAd(streamId: String, index: Int, isFinal: Boolean): ByteArray {
        val sid = streamId.toByteArray(Charsets.UTF_8)
        val out = java.io.ByteArrayOutputStream(sid.size + 5)
        out.write(sid)
        out.write((index ushr 24) and 0xFF)
        out.write((index ushr 16) and 0xFF)
        out.write((index ushr 8) and 0xFF)
        out.write(index and 0xFF)
        out.write(if (isFinal) 1 else 0)
        return out.toByteArray()
    }

    private fun hex(s: String): ByteArray {
        require(s.length % 2 == 0) { "odd hex length" }
        val out = ByteArray(s.length / 2)
        for (i in out.indices) {
            val hi = Character.digit(s[i * 2], 16)
            val lo = Character.digit(s[i * 2 + 1], 16)
            require(hi >= 0 && lo >= 0) { "bad hex char at index ${i * 2}" }
            out[i] = ((hi shl 4) or lo).toByte()
        }
        return out
    }
}

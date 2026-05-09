package xyz.ghola.app.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

/**
 * Ports the four tests in `crates/said-envelope/src/streaming.rs`:
 * chunk_nonce_unique_per_index, chunk_round_trip, chunk_reorder_fails,
 * receipt_round_trip_and_tamper, transcript_hasher_distinguishes_boundaries.
 */
class StreamingTest {

    companion object {
        @JvmStatic
        @BeforeClass
        fun setUp() {
            CryptoProviders.installBouncyCastleOnce()
        }
    }

    @Test
    fun chunk_nonce_unique_per_index() {
        val dek = TestKeys.random(32)
        val n0 = EnvelopeStreaming.deriveChunkNonce(dek, 0)
        val n1 = EnvelopeStreaming.deriveChunkNonce(dek, 1)
        val n42 = EnvelopeStreaming.deriveChunkNonce(dek, 42)
        assertFalse(n0.contentEquals(n1))
        assertFalse(n1.contentEquals(n42))
        // Last 4 bytes are the index, big-endian.
        assertArrayEquals(byteArrayOf(0, 0, 0, 42), n42.copyOfRange(8, 12))
    }

    @Test
    fun chunk_round_trip() {
        val dek = TestKeys.random(32)
        val streamId = "s-abc"
        val parts = listOf("hello ", "from ", "the ", "model")
        val hasher = EnvelopeStreaming.TranscriptHasher()
        val cts = parts.mapIndexed { i, c ->
            val isFinal = i == parts.size - 1
            val ct = EnvelopeStreaming.sealChunk(dek, i, isFinal, streamId, c.toByteArray())
            hasher.update(ct)
            ct
        }
        val out = StringBuilder()
        cts.forEachIndexed { i, ct ->
            val isFinal = i == cts.size - 1
            out.append(EnvelopeStreaming.openChunk(dek, i, isFinal, streamId, ct).toString(Charsets.UTF_8))
        }
        assertEquals("hello from the model", out.toString())
        // Finalize for parity with the Rust test (we don't compare here —
        // the receipt path does that).
        assertEquals(32, hasher.finalize().size)
    }

    @Test
    fun chunk_reorder_fails() {
        val dek = TestKeys.random(32)
        val streamId = "s-zzz"
        val ct0 = EnvelopeStreaming.sealChunk(dek, 0, false, streamId, "first".toByteArray())
        // Try opening chunk 0's ciphertext at index 1 (mismatched nonce + AD).
        assertThrows(Envelope.EnvelopeError.AeadFailed::class.java) {
            EnvelopeStreaming.openChunk(dek, 1, true, streamId, ct0)
        }
    }

    @Test
    fun receipt_round_trip_and_tamper() {
        val producer = TestKeys.freshIdentity()
        val hasher = EnvelopeStreaming.TranscriptHasher()
        hasher.update("chunk-1".toByteArray())
        hasher.update("chunk-2".toByteArray())
        val tx = hasher.finalize()

        val receipt = EnvelopeStreaming.EnvelopeReceipt.sign(
            signer = producer.signer,
            producerDid = producer.did,
            streamId = "s-1",
            model = "test/model",
            inputTokens = 10,
            outputTokens = 20,
            completedAt = 1700000000L,
            transcriptSha256 = tx,
        )

        // Verifying with the right transcript succeeds.
        assertTrue(receipt.verify(tx))

        // Verifying with a wrong transcript fails.
        val wrong = tx.copyOf().also { it[0] = (it[0].toInt() xor 0x01).toByte() }
        assertFalse(receipt.verify(wrong))

        // Tampering output_tokens after signing must fail verification.
        val tampered = receipt.copy(outputTokens = 999)
        assertFalse(tampered.verify(tx))
    }

    @Test
    fun transcript_hasher_distinguishes_boundaries() {
        val a = EnvelopeStreaming.TranscriptHasher().also {
            it.update("abc".toByteArray()); it.update("def".toByteArray())
        }.finalize()
        val b = EnvelopeStreaming.TranscriptHasher().also {
            it.update("abcdef".toByteArray())
        }.finalize()
        assertNotEquals(a.toList(), b.toList())
    }
}

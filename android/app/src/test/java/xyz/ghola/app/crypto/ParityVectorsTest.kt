package xyz.ghola.app.crypto

import org.json.JSONArray
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.BeforeClass
import org.junit.Test

/**
 * Wire-format parity gate against `crates/said-envelope`.
 *
 * The committed `envelope_vectors.json` is regenerated on every CI run by
 * `cargo run -p said-envelope --example gen_vectors -- --out
 * android/app/src/test/resources/envelope_vectors.json` followed by a
 * `git diff --exit-code` of the file. If the Rust crate's wire format
 * drifts (or the Android port mis-decodes), one of three things fails:
 *
 *   1. CI's diff step → bytes diverged.
 *   2. This test → Android cannot open the Rust-produced bytes.
 *   3. The Rust crate's `cargo test` → the Rust crate fails its own tests.
 *
 * Any of those blocks the build.
 */
class ParityVectorsTest {

    companion object {
        @JvmStatic
        @BeforeClass
        fun setUp() {
            CryptoProviders.installBouncyCastleOnce()
        }
    }

    @Test
    fun every_vector_decodes() {
        val rawStream = javaClass.classLoader!!.getResourceAsStream("envelope_vectors.json")
            ?: error("envelope_vectors.json not found on classpath")
        val raw = rawStream.bufferedReader(Charsets.UTF_8).readText()
        val arr = JSONArray(raw)
        require(arr.length() > 0) { "no vectors" }

        for (i in 0 until arr.length()) {
            val v = arr.getJSONObject(i)
            val name = v.getString("name")
            val recipientSecret = hex(v.getString("recipient_x25519_secret_hex"))
            val expectedAd = hex(v.getString("associated_data_hex"))
            val expectedPt = hex(v.getString("plaintext_hex"))
            val expectedSender = v.getString("expected_sender_did")
            val expectedRecipient = v.getString("recipient_id")
            val expectedKindByte = v.getInt("recipient_kind").toByte()
            val wire = hex(v.getString("wire_hex"))

            val opened = Envelope.open(wire, recipientSecret)
            assertEquals("[$name] sender_did", expectedSender, opened.senderDid)
            assertEquals("[$name] recipient_id", expectedRecipient, opened.recipientId)
            assertEquals("[$name] recipient_kind", expectedKindByte, opened.kind.byte)
            assertArrayEquals("[$name] associated_data", expectedAd, opened.associatedData)
            assertArrayEquals("[$name] plaintext", expectedPt, opened.plaintext)
        }
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

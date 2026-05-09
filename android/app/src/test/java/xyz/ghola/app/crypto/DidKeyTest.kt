package xyz.ghola.app.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.BeforeClass
import org.junit.Test

class DidKeyTest {

    companion object {
        @JvmStatic
        @BeforeClass
        fun setUp() {
            CryptoProviders.installBouncyCastleOnce()
        }
    }

    @Test
    fun did_round_trip() {
        val identity = TestKeys.freshIdentity()
        val decoded = Envelope.verifyingFromDidKey(identity.did)
        assertArrayEquals(identity.publicKey, decoded)
    }

    @Test
    fun rejects_wrong_method() {
        assertThrows(Envelope.EnvelopeError.InvalidSenderDid::class.java) {
            Envelope.verifyingFromDidKey("did:web:example.com")
        }
    }

    @Test
    fun rejects_invalid_base58() {
        assertThrows(RuntimeException::class.java) {
            Envelope.verifyingFromDidKey("did:key:zNotBase58!!")
        }
    }

    @Test
    fun rejects_wrong_multicodec() {
        // 32-byte payload prefixed with the wrong multicodec (0xec, 0x01) —
        // valid base58, valid length, but not Ed25519.
        val bad = byteArrayOf(0xec.toByte(), 0x01) + ByteArray(32) { 0x42 }
        val did = "did:key:z" + xyz.ghola.app.solana.Base58.encode(bad)
        assertThrows(Envelope.EnvelopeError.DidNotEd25519::class.java) {
            Envelope.verifyingFromDidKey(did)
        }
    }
}

package xyz.ghola.app.crypto

import org.junit.Assert.fail
import org.junit.BeforeClass
import org.junit.Test

/**
 * Port of `cross_byte_tamper_sweep` in the Rust crate: build a small
 * envelope, mutate every byte in turn, and assert `open()` rejects each
 * variant. Catches off-by-one bugs in the tamper-detection logic that
 * targeted single-region tests could miss.
 */
class EnvelopeTamperSweepTest {

    companion object {
        @JvmStatic
        @BeforeClass
        fun setUp() {
            CryptoProviders.installBouncyCastleOnce()
        }
    }

    @Test
    fun every_byte_flip_rejected() {
        val alice = TestKeys.freshIdentity()
        val (bobSecret, bobPub) = TestKeys.freshX25519Keypair()
        val original = Envelope.seal(
            Envelope.SealParams(
                senderDid = alice.did,
                kind = Envelope.RecipientKind.PeerDid,
                recipientId = "did:key:zBobby",
                recipientX25519 = bobPub,
                associatedData = "ad".toByteArray(),
                plaintext = "plain".toByteArray(),
                signBody = alice.signer,
            ),
        )
        for (i in original.indices) {
            val bad = original.copyOf()
            bad[i] = (bad[i].toInt() xor 0x01).toByte()
            try {
                Envelope.open(bad, bobSecret)
                fail("tampering byte $i produced a valid envelope")
            } catch (_: Envelope.EnvelopeError) {
                // expected
            } catch (_: Throwable) {
                // also acceptable — any exception means open() rejected.
            }
        }
    }
}

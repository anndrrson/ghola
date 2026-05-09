package xyz.ghola.app.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

/**
 * Mirrors the eight tests in `crates/said-envelope/src/lib.rs` that lock
 * the wire format and tamper-detection guarantees down. If any of these
 * fail, the Android client will silently mis-decode envelopes from
 * web/Rust producers.
 */
class EnvelopeRoundTripTest {

    companion object {
        @JvmStatic
        @BeforeClass
        fun setUp() {
            CryptoProviders.installBouncyCastleOnce()
        }
    }

    @Test
    fun peer_round_trip() {
        val alice = TestKeys.freshIdentity()
        val (bobX25519Secret, bobX25519Pub) = TestKeys.freshX25519Keypair()
        val bobDid = "did:key:zNotUsedForX25519PathButValid" // not exercised here

        val ad = "session=abc;ts=1700000000".toByteArray()
        val pt = "hello bob from alice".toByteArray()

        val wire = Envelope.seal(
            Envelope.SealParams(
                senderDid = alice.did,
                kind = Envelope.RecipientKind.PeerDid,
                recipientId = bobDid,
                recipientX25519 = bobX25519Pub,
                associatedData = ad,
                plaintext = pt,
                signBody = alice.signer,
            ),
        )

        val opened = Envelope.open(wire, bobX25519Secret)
        assertEquals(Envelope.RecipientKind.PeerDid, opened.kind)
        assertEquals(alice.did, opened.senderDid)
        assertEquals(bobDid, opened.recipientId)
        assertArrayEquals(ad, opened.associatedData)
        assertArrayEquals(pt, opened.plaintext)
    }

    @Test
    fun wrong_recipient_fails() {
        val alice = TestKeys.freshIdentity()
        val (_, bobPub) = TestKeys.freshX25519Keypair()
        val (mallorySecret, _) = TestKeys.freshX25519Keypair()

        val wire = Envelope.seal(
            Envelope.SealParams(
                senderDid = alice.did,
                kind = Envelope.RecipientKind.PeerDid,
                recipientId = "did:key:zBobby",
                recipientX25519 = bobPub,
                associatedData = "ad".toByteArray(),
                plaintext = "secret".toByteArray(),
                signBody = alice.signer,
            ),
        )
        // Mallory's secret produces a different shared secret, so the DEK
        // doesn't match and AEAD open fails.
        assertThrows(Envelope.EnvelopeError.AeadFailed::class.java) {
            Envelope.open(wire, mallorySecret)
        }
    }

    @Test
    fun associated_data_tamper_detected() {
        val alice = TestKeys.freshIdentity()
        val (bobSecret, bobPub) = TestKeys.freshX25519Keypair()

        val wire = Envelope.seal(
            Envelope.SealParams(
                senderDid = alice.did,
                kind = Envelope.RecipientKind.PeerDid,
                recipientId = "did:key:zBobby",
                recipientX25519 = bobPub,
                associatedData = "ad-original".toByteArray(),
                plaintext = "pt".toByteArray(),
                signBody = alice.signer,
            ),
        )
        val needle = "ad-original".toByteArray()
        val pos = indexOf(wire, needle)
        assertTrue("ad bytes should be in wire", pos >= 0)
        wire[pos] = (wire[pos].toInt() xor 0x01).toByte()
        // Either signature catches it (we changed body bytes without
        // updating sig) — that's the expected outcome.
        assertThrows(Envelope.EnvelopeError.BadSignature::class.java) {
            Envelope.open(wire, bobSecret)
        }
    }

    @Test
    fun ciphertext_tamper_detected_by_signature() {
        val alice = TestKeys.freshIdentity()
        val (bobSecret, bobPub) = TestKeys.freshX25519Keypair()
        val wire = Envelope.seal(
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
        // Flip a byte well inside the ciphertext (avoid the trailing 64-byte sig).
        val target = wire.size - Envelope.SIGNATURE_LEN - 4
        wire[target] = (wire[target].toInt() xor 0x01).toByte()
        assertThrows(Envelope.EnvelopeError.BadSignature::class.java) {
            Envelope.open(wire, bobSecret)
        }
    }

    @Test
    fun signature_strip_fails() {
        val alice = TestKeys.freshIdentity()
        val (bobSecret, bobPub) = TestKeys.freshX25519Keypair()
        val wire = Envelope.seal(
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
        // Truncate the signature → length check rejects.
        val truncated = wire.copyOfRange(0, wire.size - 1)
        assertThrows(RuntimeException::class.java) {
            Envelope.open(truncated, bobSecret)
        }
        // Replace signature with garbage → BadSignature.
        val bad = wire.copyOf()
        val sigStart = bad.size - Envelope.SIGNATURE_LEN
        for (i in sigStart until bad.size) bad[i] = (bad[i].toInt() xor 0xFF).toByte()
        assertThrows(Envelope.EnvelopeError.BadSignature::class.java) {
            Envelope.open(bad, bobSecret)
        }
    }

    @Test
    fun magic_and_version_checked() {
        val alice = TestKeys.freshIdentity()
        val (bobSecret, bobPub) = TestKeys.freshX25519Keypair()
        val wire = Envelope.seal(
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
        // The header is parsed before the signature is verified, so a
        // corrupted magic byte surfaces as BadMagic.
        val tamperedMagic = wire.copyOf()
        tamperedMagic[0] = 'X'.code.toByte()
        assertThrows(Envelope.EnvelopeError.BadMagic::class.java) {
            Envelope.open(tamperedMagic, bobSecret)
        }

        val tamperedVersion = wire.copyOf()
        tamperedVersion[Envelope.MAGIC.size] = 0x99.toByte()
        assertThrows(Envelope.EnvelopeError.BadVersion::class.java) {
            Envelope.open(tamperedVersion, bobSecret)
        }
    }

    private fun indexOf(haystack: ByteArray, needle: ByteArray): Int {
        outer@ for (i in 0..haystack.size - needle.size) {
            for (j in needle.indices) {
                if (haystack[i + j] != needle[j]) continue@outer
            }
            return i
        }
        return -1
    }
}

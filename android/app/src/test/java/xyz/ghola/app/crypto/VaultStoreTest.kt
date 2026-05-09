package xyz.ghola.app.crypto

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import java.security.SecureRandom

/**
 * Exercises the KEK wrap / unwrap, session DEK lifecycle, and the
 * unlock-failure matrix without needing AndroidKeystore (uses the
 * in-memory prefs shim).
 */
class VaultStoreTest {

    companion object {
        @JvmStatic
        @BeforeClass
        fun setUp() {
            CryptoProviders.installBouncyCastleOnce()
        }
    }

    private val rng = SecureRandom()

    /** A deterministic signer keyed on a fixed Ed25519 seed. Same seed →
     *  same signature for the same challenge (RFC 8032 §5.1.6). */
    private class FakeWalletSigner(private val seed: ByteArray) : VaultStore.SignMessage {
        private val priv = Ed25519PrivateKeyParameters(seed, 0)
        override fun sign(challenge: ByteArray): VaultStore.SignResult {
            val signer = Ed25519Signer().apply { init(true, priv) }
            signer.update(challenge, 0, challenge.size)
            return VaultStore.SignResult.Success(signer.generateSignature())
        }
    }

    private fun freshDid(): String {
        val seed = ByteArray(32).also { rng.nextBytes(it) }
        val pub = Ed25519PrivateKeyParameters(seed, 0).generatePublicKey().encoded
        return Envelope.didKeyFromVerifying(pub)
    }

    @Test
    fun first_unlock_creates_kek_and_persists() {
        val did = freshDid()
        val vault = VaultStore.createInMemoryForTests(did)
        val signer = FakeWalletSigner(ByteArray(32) { 0x42 })
        vault.unlock(signer)
        assertTrue(vault.isUnlocked())
        assertEquals(did, vault.userDid)
    }

    @Test
    fun second_unlock_recovers_kek() {
        val did = freshDid()
        val backing = HashMap<String, Any?>()
        val signer = FakeWalletSigner(ByteArray(32) { 0x42 })

        val a = VaultStore(InMemoryPrefs(backing), did)
        a.unlock(signer)
        val sessionId = "s-1"
        val dek1 = a.getOrCreateSessionDek(sessionId)
        a.lock()

        // Re-construct with the same backing → simulates app restart.
        val b = VaultStore(InMemoryPrefs(backing), did)
        b.unlock(signer)
        val dek2 = b.getOrCreateSessionDek(sessionId)
        assertArrayEquals(dek1, dek2)
    }

    @Test
    fun wrong_wallet_fails_unlock() {
        val did = freshDid()
        val backing = HashMap<String, Any?>()
        val a = VaultStore(InMemoryPrefs(backing), did)
        a.unlock(FakeWalletSigner(ByteArray(32) { 0x42 }))
        a.lock()

        val b = VaultStore(InMemoryPrefs(backing), did)
        // Different wallet seed → different signature → KEK unwrap fails.
        assertThrows(VaultStore.VaultLockedError::class.java) {
            b.unlock(FakeWalletSigner(ByteArray(32) { 0x99.toByte() }))
        }
    }

    @Test
    fun no_wallet_paired_throws() {
        val did = freshDid()
        val vault = VaultStore.createInMemoryForTests(did)
        val noWalletSigner = VaultStore.SignMessage { VaultStore.SignResult.NoWallet }
        assertThrows(VaultStore.VaultLockedError.NoWalletPaired::class.java) {
            vault.unlock(noWalletSigner)
        }
    }

    @Test
    fun wallet_declined_throws() {
        val did = freshDid()
        val vault = VaultStore.createInMemoryForTests(did)
        val declined = VaultStore.SignMessage { VaultStore.SignResult.Declined }
        assertThrows(VaultStore.VaultLockedError.WalletDeclined::class.java) {
            vault.unlock(declined)
        }
    }

    @Test
    fun wallet_cancelled_throws() {
        val did = freshDid()
        val vault = VaultStore.createInMemoryForTests(did)
        val cancelled = VaultStore.SignMessage { VaultStore.SignResult.Cancelled }
        assertThrows(VaultStore.VaultLockedError.WalletCancelled::class.java) {
            vault.unlock(cancelled)
        }
    }

    @Test
    fun non_deterministic_wallet_aborts_unlock() {
        // Wallet returns DIFFERENT signatures for the same challenge —
        // must be caught at unlock so we don't write a vault that nobody
        // can recover. We seed a vault with one valid signature, then
        // unlock with a signer whose second call returns a different
        // signature. The first signature unwraps the KEK fine; the
        // determinism guard catches the divergence on the second call.
        val did = freshDid()
        val backing = HashMap<String, Any?>()
        val seed = ByteArray(32) { 0x42 }
        val priv = Ed25519PrivateKeyParameters(seed, 0)

        // Seed the vault with the deterministic signature.
        VaultStore(InMemoryPrefs(backing), did)
            .also { it.unlock(FakeWalletSigner(seed)) }
            .lock()

        var calls = 0
        val flaky = VaultStore.SignMessage { challenge ->
            calls += 1
            val s = Ed25519Signer().apply { init(true, priv) }
            if (calls == 1) {
                // First call: real, deterministic signature → KEK unwraps.
                s.update(challenge, 0, challenge.size)
            } else {
                // Second call: simulate flakiness by signing a perturbed
                // message → signature bytes differ.
                val perturbed = challenge.copyOf().also { it[0] = (it[0].toInt() xor 1).toByte() }
                s.update(perturbed, 0, perturbed.size)
            }
            VaultStore.SignResult.Success(s.generateSignature())
        }
        assertThrows(VaultStore.VaultLockedError.DeterminismViolation::class.java) {
            VaultStore(InMemoryPrefs(backing), did).unlock(flaky, verifyDeterminism = true)
        }
    }

    @Test
    fun session_dek_lifecycle() {
        val did = freshDid()
        val vault = VaultStore.createInMemoryForTests(did)
        vault.unlock(FakeWalletSigner(ByteArray(32) { 0x33 }))

        val sessionId = "s-abc"
        val dek = vault.getOrCreateSessionDek(sessionId)
        assertEquals(32, dek.size)
        // Same call again returns the same DEK.
        val dek2 = vault.getOrCreateSessionDek(sessionId)
        assertArrayEquals(dek, dek2)

        // Distinct session → distinct DEK.
        val other = vault.getOrCreateSessionDek("s-xyz")
        assertNotEquals(dek.toList(), other.toList())

        // Listing returns both.
        val ids = vault.listSessions().map { it.sessionId }.toSet()
        assertTrue(sessionId in ids)
        assertTrue("s-xyz" in ids)

        // Delete drops it.
        vault.deleteSession(sessionId)
        val after = vault.listSessions().map { it.sessionId }.toSet()
        assertTrue(sessionId !in after)
        assertTrue("s-xyz" in after)
    }

    @Test
    fun wipe_recovers_to_fresh_state() {
        val did = freshDid()
        val backing = HashMap<String, Any?>()
        val signer = FakeWalletSigner(ByteArray(32) { 0x77 })
        val a = VaultStore(InMemoryPrefs(backing), did).also { it.unlock(signer) }
        a.getOrCreateSessionDek("s-1")
        a.wipe()
        assertTrue(!a.isUnlocked())

        // Re-unlock with the same wallet — this is a fresh setup, so we
        // get a NEW random KEK. The DEK derived from the old KEK is gone.
        val b = VaultStore(InMemoryPrefs(backing), did).also { it.unlock(signer) }
        assertTrue(b.listSessions().isEmpty())
    }

    @Test
    fun import_session_dek_overwrites() {
        val did = freshDid()
        val vault = VaultStore.createInMemoryForTests(did)
        vault.unlock(FakeWalletSigner(ByteArray(32) { 0x77 }))
        val original = vault.getOrCreateSessionDek("s-1")
        val imported = ByteArray(32) { 0xAB.toByte() }
        vault.importSessionDek("s-1", imported)
        val read = vault.getOrCreateSessionDek("s-1")
        assertArrayEquals(imported, read)
        assertNotEquals(original.toList(), read.toList())
    }
}

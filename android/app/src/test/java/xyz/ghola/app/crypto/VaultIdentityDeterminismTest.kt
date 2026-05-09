package xyz.ghola.app.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.BeforeClass
import org.junit.Test
import java.security.SecureRandom

/**
 * Determinism regression: the entire E2E story breaks if the vault ever
 * derives a different X25519 secret or chat-sign Ed25519 seed for the
 * same wallet on the same device. Web↔Android byte parity is intentionally
 * NOT checked (cross-platform Pair Device is out of scope for v0.3).
 */
class VaultIdentityDeterminismTest {

    companion object {
        @JvmStatic
        @BeforeClass
        fun setUp() {
            CryptoProviders.installBouncyCastleOnce()
        }
    }

    private val rng = SecureRandom()
    private fun rand(n: Int) = ByteArray(n).also { rng.nextBytes(it) }

    @Test
    fun same_inputs_yield_same_seeds() {
        val sig = rand(64)
        val salt = rand(16)
        val a = VaultIdentity.deriveVaultMaterial(sig, salt)
        val b = VaultIdentity.deriveVaultMaterial(sig.copyOf(), salt.copyOf())
        assertArrayEquals(a.x25519Secret, b.x25519Secret)
        assertArrayEquals(a.x25519Public, b.x25519Public)
        assertArrayEquals(a.chatSignSeed, b.chatSignSeed)
        assertArrayEquals(a.chatSignPublic, b.chatSignPublic)
        assertArrayEquals(a.kekWrapKey, b.kekWrapKey)
        assertEquals(a.chatSignDid, b.chatSignDid)
    }

    @Test
    fun different_signatures_yield_different_seeds() {
        val salt = rand(16)
        val a = VaultIdentity.deriveVaultMaterial(rand(64), salt)
        val b = VaultIdentity.deriveVaultMaterial(rand(64), salt)
        assertNotEquals(a.x25519Secret.toList(), b.x25519Secret.toList())
        assertNotEquals(a.chatSignSeed.toList(), b.chatSignSeed.toList())
        assertNotEquals(a.kekWrapKey.toList(), b.kekWrapKey.toList())
    }

    @Test
    fun different_salts_yield_different_seeds() {
        val sig = rand(64)
        val a = VaultIdentity.deriveVaultMaterial(sig, rand(16))
        val b = VaultIdentity.deriveVaultMaterial(sig, rand(16))
        assertNotEquals(a.x25519Secret.toList(), b.x25519Secret.toList())
        assertNotEquals(a.chatSignSeed.toList(), b.chatSignSeed.toList())
        assertNotEquals(a.kekWrapKey.toList(), b.kekWrapKey.toList())
    }

    @Test
    fun three_seeds_pairwise_distinct() {
        // Sanity check that the three info strings actually domain-separate.
        // If `INFO_X25519`, `INFO_CHAT_SIGN`, `INFO_KEK_WRAP` ever collided
        // we'd silently leak an envelope-signing seed via the X25519 secret.
        val mat = VaultIdentity.deriveVaultMaterial(rand(64), rand(16))
        assertNotEquals(mat.x25519Secret.toList(), mat.chatSignSeed.toList())
        assertNotEquals(mat.x25519Secret.toList(), mat.kekWrapKey.toList())
        assertNotEquals(mat.chatSignSeed.toList(), mat.kekWrapKey.toList())
    }

    @Test
    fun rejects_short_signatures() {
        try {
            VaultIdentity.deriveVaultMaterial(rand(32), rand(16))
            error("should have thrown")
        } catch (_: IllegalArgumentException) {
            // expected
        }
    }
}

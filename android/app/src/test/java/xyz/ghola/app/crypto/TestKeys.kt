package xyz.ghola.app.crypto

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import java.security.SecureRandom

/**
 * Helpers shared across the crypto unit tests.
 */
object TestKeys {

    private val rng = SecureRandom()

    init {
        CryptoProviders.installBouncyCastleOnce()
    }

    data class Identity(
        val seed: ByteArray,
        val publicKey: ByteArray,
        val did: String,
        val signer: Envelope.Ed25519BodySigner,
    )

    fun freshIdentity(): Identity {
        val seed = ByteArray(32).also { rng.nextBytes(it) }
        val priv = Ed25519PrivateKeyParameters(seed, 0)
        val pub = priv.generatePublicKey().encoded
        return Identity(
            seed = seed,
            publicKey = pub,
            did = Envelope.didKeyFromVerifying(pub),
            signer = Envelope.localEd25519Signer(seed),
        )
    }

    /**
     * Returns (X25519 secret, X25519 public) — used as the recipient
     * keypair for peer / self envelopes in tests. We do NOT exercise the
     * Ed→Mont path here (`Envelope.edwardsPubToX25519`); that path is
     * tested separately because BigInteger correctness is its own story.
     */
    fun freshX25519Keypair(): Pair<ByteArray, ByteArray> {
        val priv = X25519PrivateKeyParameters(rng)
        return priv.encoded to priv.generatePublicKey().encoded
    }

    fun random(n: Int): ByteArray = ByteArray(n).also { rng.nextBytes(it) }
}

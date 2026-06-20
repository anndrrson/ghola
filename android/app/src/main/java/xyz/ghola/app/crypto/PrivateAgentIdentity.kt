package xyz.ghola.app.crypto

import android.util.Base64
import org.json.JSONObject
import xyz.ghola.app.cloud.DeviceSignResult
import xyz.ghola.app.cloud.DeviceSigner
import xyz.ghola.app.solana.Base58
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Locally derives agent identity from a device-held signer.
 *
 * On Seeker this signer is the user's MWA wallet. The wallet key never leaves
 * the wallet app: Ghola asks the wallet to sign a domain-separated per-agent
 * challenge, derives a per-agent Ed25519 seed from that signature, and sends
 * only the public DID, Solana address, and a proof that the app holds the
 * matching agent secret.
 */
object PrivateAgentIdentity {
    private val ROOT_SALT = "ghola-agent-root-v1".toByteArray(Charsets.UTF_8)
    private val AGENT_SEED_PREFIX = "ghola-agent-seed-v1/".toByteArray(Charsets.UTF_8)
    private val CONFIG_KEY_PREFIX = "ghola-agent-config-v1/".toByteArray(Charsets.UTF_8)
    private val rng = SecureRandom()

    data class Derived(
        val publicKeyBase58: String,
        val did: String,
        val solanaAddress: String,
        val identityMessage: String,
        val identitySignatureBase64: String,
        val encryptedConfig: String,
    )

    suspend fun derive(
        signer: DeviceSigner,
        slug: String,
        displayName: String,
        bio: String?,
    ): Result<Derived> {
        val rootMessage = rootMessage(signer.identity.address, slug)
        val rootSignature = when (val signed = signer.sign(rootMessage)) {
            is DeviceSignResult.Success -> signed.signature
            DeviceSignResult.NoSigner -> return Result.failure(IllegalStateException("Wallet signer is unavailable"))
            DeviceSignResult.Declined -> return Result.failure(IllegalStateException("Wallet signing was declined"))
            DeviceSignResult.Cancelled -> return Result.failure(IllegalStateException("Wallet signing was cancelled"))
            is DeviceSignResult.Failure -> return Result.failure(signed.cause)
        }

        val agentSeed = Hkdf.extractAndExpand(
            salt = ROOT_SALT,
            ikm = rootSignature,
            info = AGENT_SEED_PREFIX + slug.toByteArray(Charsets.UTF_8),
            length = 32,
        )
        return runCatching {
            val publicKey = Envelope.ed25519PublicFromSeed(agentSeed)
            val publicKeyBase58 = Base58.encode(publicKey)
            val did = Envelope.didKeyFromVerifying(publicKey)
            val identityMessage = identityMessage(
                ownerWallet = signer.identity.address,
                slug = slug,
                displayName = displayName,
                bio = bio,
                did = did,
                solanaAddress = publicKeyBase58,
            )
            val identitySignature = Envelope.localEd25519Signer(agentSeed)
                .sign(identityMessage.toByteArray(Charsets.UTF_8))
            val encryptedConfig = encryptConfig(
                seed = agentSeed,
                slug = slug,
                displayName = displayName,
                bio = bio,
                did = did,
                solanaAddress = publicKeyBase58,
                ownerWallet = signer.identity.address,
            )
            Derived(
                publicKeyBase58 = publicKeyBase58,
                did = did,
                solanaAddress = publicKeyBase58,
                identityMessage = identityMessage,
                identitySignatureBase64 = Base64.encodeToString(identitySignature, Base64.NO_WRAP),
                encryptedConfig = encryptedConfig,
            )
        }.also {
            rootSignature.fill(0)
            agentSeed.fill(0)
        }
    }

    // Domain prefix sourced from the central [SigningDomains] registry, which
    // asserts at load time that it is disjoint and prefix-free vs the vault-
    // unlock, SIWS, and shielded-recipient wallet-signing challenges. The
    // signature over this message is HKDF'd into a per-agent seed (H1).
    private fun rootMessage(ownerWallet: String, slug: String): ByteArray =
        "${SigningDomains.AGENT_ROOT}owner_wallet:$ownerWallet\nagent_slug:$slug\npurpose:create-private-agent\n"
            .toByteArray(Charsets.UTF_8)

    private fun identityMessage(
        ownerWallet: String,
        slug: String,
        displayName: String,
        bio: String?,
        did: String,
        solanaAddress: String,
    ): String = JSONObject().apply {
        put("domain", "ghola-agent-create-v1")
        put("owner_wallet", ownerWallet)
        put("slug", slug)
        put("display_name", displayName)
        put("bio", bio ?: "")
        put("did", did)
        put("solana_address", solanaAddress)
    }.toString()

    private fun encryptConfig(
        seed: ByteArray,
        slug: String,
        displayName: String,
        bio: String?,
        did: String,
        solanaAddress: String,
        ownerWallet: String,
    ): String {
        val key = Hkdf.extractAndExpand(
            salt = ROOT_SALT,
            ikm = seed,
            info = CONFIG_KEY_PREFIX + slug.toByteArray(Charsets.UTF_8),
            length = 32,
        )
        val nonce = ByteArray(12).also { rng.nextBytes(it) }
        val plaintext = JSONObject().apply {
            put("v", 1)
            put("slug", slug)
            put("display_name", displayName)
            if (!bio.isNullOrBlank()) put("bio", bio)
            put("did", did)
            put("solana_address", solanaAddress)
            put("owner_wallet", ownerWallet)
            put("key_source", "mwa_wallet_signature_hkdf")
        }.toString().toByteArray(Charsets.UTF_8)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        val ciphertext = cipher.doFinal(plaintext)
        key.fill(0)

        return JSONObject().apply {
            put("v", 1)
            put("alg", "AES-256-GCM")
            put("kdf", "mwa-wallet-signature-hkdf-sha256")
            put("nonce", Base64.encodeToString(nonce, Base64.NO_WRAP))
            put("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
        }.toString()
    }
}

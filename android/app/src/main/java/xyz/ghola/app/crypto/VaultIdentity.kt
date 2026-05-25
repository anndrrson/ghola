package xyz.ghola.app.crypto

/**
 * Derives every wallet-bound secret the vault needs from a single MWA
 * `signMessage` call.
 *
 * ## Why one signature
 * MWA wallets prompt the user on every signMessage. Web has no such
 * latency tax (Turnkey signs server-side, silently), so the web vault
 * signs per chat-message envelope. On Android we cannot afford that, so
 * we sign once at unlock against a domain-separated challenge and HKDF
 * the result into the two seeds the vault needs:
 *
 *   - 32-byte X25519 secret (recipient/peer ECDH for sealed envelopes)
 *   - 32-byte Ed25519 seed (envelope body signing)
 *
 * Domain separation is enforced via the HKDF `info` strings; the wallet
 * signature is the IKM, the per-device salt is the Extract salt.
 *
 * ## Why intentionally diverge from web for X25519
 * Web's `vault-x25519.ts` uses `SHA-512(walletSig)[..32]` directly. The
 * v0.3 Android port intentionally takes a different derivation because
 * cross-platform Pair Device (web ↔ Android) is out of scope for v0.3
 * (different sender-DID conventions on each side). Once cross-platform
 * pairing returns we'll either align both to one derivation or extend
 * the receiver-side pin to accept multiple DIDs from the same wallet.
 */
object VaultIdentity {

    /** Bytes the wallet signs at unlock. Domain-separated so the same
     *  wallet can host other Ghola features without challenge collision. */
    const val UNLOCK_CHALLENGE_PREFIX = SigningDomains.VAULT_UNLOCK

    /** Domain-separated info strings — distinct per derived seed. */
    private val INFO_X25519 = "ghola/vault-x25519-derive-v1".toByteArray(Charsets.UTF_8)
    private val INFO_CHAT_SIGN = "ghola/chat-sign-ed25519-derive-v1".toByteArray(Charsets.UTF_8)
    private val INFO_KEK_WRAP = "ghola/vault-kek-wrap-v1".toByteArray(Charsets.UTF_8)

    data class VaultMaterial(
        /** 32-byte X25519 secret. */
        val x25519Secret: ByteArray,
        /** 32-byte X25519 public derived from the secret. */
        val x25519Public: ByteArray,
        /** 32-byte Ed25519 seed for envelope body signing. */
        val chatSignSeed: ByteArray,
        /** 32-byte Ed25519 public derived from the seed. */
        val chatSignPublic: ByteArray,
        /** 32-byte AES-256 key used to wrap the master KEK on disk. Held
         *  separately from the X25519 vault secret to keep responsibilities
         *  unambiguous (the X25519 secret is for envelope ECDH only). */
        val kekWrapKey: ByteArray,
        /** `did:key:zXXX` of the chat-signing public — the sender DID
         *  written into envelopes by this device. */
        val chatSignDid: String,
    ) {
        fun zeroize() {
            for (i in x25519Secret.indices) x25519Secret[i] = 0
            for (i in chatSignSeed.indices) chatSignSeed[i] = 0
            for (i in kekWrapKey.indices) kekWrapKey[i] = 0
        }
    }

    /**
     * Build the bytes the wallet signs to unlock the vault.
     *
     * Layout: `b"ghola/vault-unlock-v1 " || userDid || salt` — note the
     * prefix ends in a SPACE (0x20), not a NUL. This exact byte string is
     * load-bearing: it is what the wallet signs and what every existing
     * wrapped KEK was derived against, so it must NOT be "corrected" to `\0`
     * (doing so would brick every existing vault). The salt is per-device; the
     * prefix is fixed; the userDid binds the signature to a specific
     * Turnkey/Solana wallet so a stolen IndexedDB-equivalent dump can't be
     * replayed under a different identity.
     */
    fun unlockChallenge(userDid: String, salt: ByteArray): ByteArray {
        require(salt.isNotEmpty()) { "salt must be non-empty" }
        val prefix = UNLOCK_CHALLENGE_PREFIX.toByteArray(Charsets.UTF_8)
        val didBytes = userDid.toByteArray(Charsets.UTF_8)
        val out = ByteArray(prefix.size + didBytes.size + salt.size)
        System.arraycopy(prefix, 0, out, 0, prefix.size)
        System.arraycopy(didBytes, 0, out, prefix.size, didBytes.size)
        System.arraycopy(salt, 0, out, prefix.size + didBytes.size, salt.size)
        return out
    }

    /**
     * Derive both vault seeds from a single 64-byte Ed25519 wallet
     * signature on [unlockChallenge]. The returned [VaultMaterial] is
     * deterministic in `(walletSig, salt)` so any device with the same
     * wallet rederives the same material.
     */
    fun deriveVaultMaterial(walletSig: ByteArray, salt: ByteArray): VaultMaterial {
        require(walletSig.size == 64) { "wallet sig must be a 64-byte Ed25519 signature" }
        require(salt.isNotEmpty()) { "salt must be non-empty" }
        val prk = Hkdf.extract(salt = salt, ikm = walletSig)
        val x25519Secret = Hkdf.expand(prk, INFO_X25519, 32)
        val chatSignSeed = Hkdf.expand(prk, INFO_CHAT_SIGN, 32)
        val kekWrapKey = Hkdf.expand(prk, INFO_KEK_WRAP, 32)
        // PRK contains key material derived from the wallet sig — clear it
        // so it can't outlive the call frame.
        for (i in prk.indices) prk[i] = 0

        val x25519Public = Envelope.x25519PublicFromSecret(x25519Secret)
        val chatSignPublic = Envelope.ed25519PublicFromSeed(chatSignSeed)
        return VaultMaterial(
            x25519Secret = x25519Secret,
            x25519Public = x25519Public,
            chatSignSeed = chatSignSeed,
            chatSignPublic = chatSignPublic,
            kekWrapKey = kekWrapKey,
            chatSignDid = Envelope.didKeyFromVerifying(chatSignPublic),
        )
    }
}

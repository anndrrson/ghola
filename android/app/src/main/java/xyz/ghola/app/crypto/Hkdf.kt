package xyz.ghola.app.crypto

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * HKDF-SHA256 (RFC 5869), implemented with platform HMAC.
 *
 * Mirrors `hkdf::Hkdf::<Sha256>::new(salt, ikm).expand(info, &mut out)` from
 * the Rust crate at parity. The two-step extract → expand split lets the
 * vault unlock flow run a single Extract over the wallet signature, then
 * Expand twice with different info strings to derive the X25519 vault
 * secret and the Ed25519 chat-signing seed in one MWA prompt.
 */
internal object Hkdf {

    private const val HMAC = "HmacSHA256"
    private const val HASH_LEN = 32

    /** RFC 5869 §2.2 — Extract. Returns a 32-byte PRK. */
    fun extract(salt: ByteArray?, ikm: ByteArray): ByteArray {
        val key = if (salt == null || salt.isEmpty()) ByteArray(HASH_LEN) else salt
        val mac = Mac.getInstance(HMAC).apply { init(SecretKeySpec(key, HMAC)) }
        return mac.doFinal(ikm)
    }

    /** RFC 5869 §2.3 — Expand. `length` ≤ 255 × 32 = 8160 bytes. */
    fun expand(prk: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length > 0 && length <= 255 * HASH_LEN) { "HKDF length out of range" }
        val mac = Mac.getInstance(HMAC).apply { init(SecretKeySpec(prk, HMAC)) }
        val out = ByteArray(length)
        var t = ByteArray(0)
        var pos = 0
        var counter = 1
        while (pos < length) {
            mac.reset()
            mac.update(t)
            mac.update(info)
            mac.update(counter.toByte())
            t = mac.doFinal()
            val take = minOf(t.size, length - pos)
            System.arraycopy(t, 0, out, pos, take)
            pos += take
            counter++
        }
        return out
    }

    /** Convenience: extract + expand in one call. */
    fun extractAndExpand(
        salt: ByteArray?,
        ikm: ByteArray,
        info: ByteArray,
        length: Int,
    ): ByteArray = expand(extract(salt, ikm), info, length)
}

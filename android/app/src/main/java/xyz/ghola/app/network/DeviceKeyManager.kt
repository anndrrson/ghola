package xyz.ghola.app.network

import android.content.Context
import android.util.Log
import java.security.SecureRandom

/**
 * Stable per-device LABEL for the legacy thumper-relay handshake.
 *
 * IMPORTANT: this is NOT a cryptographic keypair. The legacy relay
 * authenticates with an EMPTY signature (see [RelayConnection.sendAuth]), so
 * this value is only a random, stable identifier the relay echoes back — it
 * proves nothing. The previous implementation base58-encoded the SAME 32 random
 * bytes as both a "device_secret_hex" and a "device_pubkey", i.e. the
 * "public key" was literally the secret, and the secret was stored in plain
 * MODE_PRIVATE prefs. Because nothing ever consumed the secret (it was dead
 * code) and the relay does no signature verification, that secret has been
 * removed entirely rather than left as a footgun.
 *
 * The relay path itself is hard-gated to debug builds (see
 * [xyz.ghola.app.service.ThumperAccessibilityService.connectToRelay]). If this
 * bridge is ever promoted to production it MUST be replaced with a real
 * Ed25519 device keypair (where the public key is derived from, and distinct
 * from, the secret), the secret moved into EncryptedSharedPreferences, and the
 * relay handshake changed to verify a per-nonce signature.
 */
class DeviceKeyManager(context: Context) {

    companion object {
        private const val TAG = "ThumperKey"
        private const val PREFS_NAME = "thumper"
        private const val KEY_DEVICE_PUBKEY = "device_pubkey"
        // Legacy row written by the pre-hardening implementation: the secret
        // was identical to the bytes behind device_pubkey. Removed on next
        // launch so it doesn't linger in plaintext prefs.
        private const val LEGACY_KEY_DEVICE_SECRET = "device_secret_hex"
    }

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    init {
        if (prefs.getString(KEY_DEVICE_PUBKEY, null) == null) {
            generateAndStore()
        } else if (prefs.contains(LEGACY_KEY_DEVICE_SECRET)) {
            // Scrub the legacy plaintext "secret" (== the device label bytes)
            // left by older installs.
            prefs.edit().remove(LEGACY_KEY_DEVICE_SECRET).apply()
        }
    }

    fun getDevicePubkey(): String {
        return prefs.getString(KEY_DEVICE_PUBKEY, "unknown")!!
    }

    private fun generateAndStore() {
        val random = SecureRandom()
        val labelBytes = ByteArray(32)
        random.nextBytes(labelBytes)

        // Non-cryptographic device label (base58 for legible config copy/paste).
        val deviceLabel = bs58Encode(labelBytes)

        prefs.edit().apply {
            putString(KEY_DEVICE_PUBKEY, deviceLabel)
            // Belt-and-braces: ensure no legacy secret row survives a re-gen.
            remove(LEGACY_KEY_DEVICE_SECRET)
            apply()
        }

        Log.i(TAG, "Generated device relay label: $deviceLabel")
    }

    /**
     * Base58 encode (Bitcoin/Solana alphabet).
     */
    private fun bs58Encode(bytes: ByteArray): String {
        val alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

        if (bytes.isEmpty()) return ""

        // Count leading zeros
        var leadingZeros = 0
        for (b in bytes) {
            if (b.toInt() == 0) leadingZeros++ else break
        }

        // Convert to base58
        val digits = mutableListOf<Int>()
        for (b in bytes) {
            var carry = b.toInt() and 0xFF
            for (i in digits.indices) {
                val value = digits[i] * 256 + carry
                digits[i] = value % 58
                carry = value / 58
            }
            while (carry > 0) {
                digits.add(carry % 58)
                carry /= 58
            }
        }

        val sb = StringBuilder()
        repeat(leadingZeros) { sb.append(alphabet[0]) }
        for (i in digits.indices.reversed()) {
            sb.append(alphabet[digits[i]])
        }

        return sb.toString()
    }
}

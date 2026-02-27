package xyz.orni.thumper.network

import android.content.Context
import android.util.Log
import java.security.SecureRandom

/**
 * Manages the device's persistent identity keypair.
 *
 * Generates a stable 32-byte device key on first launch, stored in SharedPreferences.
 * The pubkey is encoded as base58 (Solana-style) for use in the auth handshake
 * and for the user to register in their thumper config on desktop.
 */
class DeviceKeyManager(context: Context) {

    companion object {
        private const val TAG = "ThumperKey"
        private const val PREFS_NAME = "thumper"
        private const val KEY_DEVICE_SECRET = "device_secret_hex"
        private const val KEY_DEVICE_PUBKEY = "device_pubkey"
    }

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    init {
        if (prefs.getString(KEY_DEVICE_PUBKEY, null) == null) {
            generateAndStore()
        }
    }

    fun getDevicePubkey(): String {
        return prefs.getString(KEY_DEVICE_PUBKEY, "unknown")!!
    }

    fun getDeviceSecretHex(): String {
        return prefs.getString(KEY_DEVICE_SECRET, "")!!
    }

    private fun generateAndStore() {
        val random = SecureRandom()
        val keyBytes = ByteArray(32)
        random.nextBytes(keyBytes)

        val secretHex = keyBytes.joinToString("") { "%02x".format(it) }
        val pubkey = bs58Encode(keyBytes)

        prefs.edit().apply {
            putString(KEY_DEVICE_SECRET, secretHex)
            putString(KEY_DEVICE_PUBKEY, pubkey)
            apply()
        }

        Log.i(TAG, "Generated new device identity: $pubkey")
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

package xyz.ghola.app.solana

import android.content.Context
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.EdECPrivateKey
import java.security.interfaces.EdECPublicKey

/**
 * # SoftwareKeyStore
 *
 * Software-keyed fallback for non-Seeker devices. On a Pixel, an emulator,
 * or any Android device without Solana Mobile's Seed Vault, this class
 * generates a real ed25519 keypair via `java.security.KeyPairGenerator`
 * and signs with it — enough to participate in the challenge-response
 * agent-creation flow against said-cloud's `/v1/agents` endpoint.
 *
 * The private key lives in normal process memory for the lifetime of
 * the generation call, then is persisted to `EncryptedSharedPreferences`
 * via the caller. That's **software**-backed, not hardware-backed. Agents
 * created via this path get a `SOFTWARE-KEYED` badge in the UI so the
 * user is never confused about which trust level applies.
 *
 * ## Why not AndroidKeyStore (hardware-backed keys via TEE)?
 *
 * AndroidKeyStore supports Ed25519 only on API 33+ and even there, the
 * OEM-provided HSM rarely exposes Ed25519 as a hardware-backed algorithm.
 * On most devices, AndroidKeyStore Ed25519 degrades to software keys
 * stored in a system-managed keystore — which is fine, but not an
 * actual upgrade over what we're doing here. Real hardware agent keys
 * live in Seed Vault on the Seeker; everything else is "software" in
 * the honest sense. We don't pretend otherwise.
 *
 * ## API availability
 *
 * Java's built-in Ed25519 support arrived in API 33 via the
 * `java.security.spec.NamedParameterSpec` route with `"Ed25519"` as the
 * curve name, and the `java.security.interfaces.EdECPrivateKey` /
 * `EdECPublicKey` reflection surface. On API 28-32 we report unsupported
 * and the caller shows an error message. That's acceptable because the
 * majority of devices that matter (Seeker, modern Pixel, Samsung S24+)
 * all run API 33 or higher.
 *
 * ## Threading
 *
 * All methods are synchronous and safe to call from any thread. The
 * underlying Java crypto is thread-safe; no Activity context is needed
 * because nothing launches an Intent.
 */
object SoftwareKeyStore {

    private const val TAG = "SoftwareKeyStore"

    /**
     * True if this device can generate Ed25519 keypairs via the standard
     * JDK API. Short-circuits to false on API < 33 because the
     * `NamedParameterSpec("Ed25519")` call throws on older Android.
     */
    fun isSupported(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false
        // Probe: try creating the generator. If the security provider
        // does not register EdDSA, we bail gracefully.
        return try {
            KeyPairGenerator.getInstance("Ed25519")
            true
        } catch (e: Throwable) {
            Log.d(TAG, "Ed25519 KeyPairGenerator unavailable: ${e.message}")
            false
        }
    }

    /**
     * Generate a fresh Ed25519 keypair. Returns `Pair<publicKeyBytes, privateKeyBytes>`
     * both as raw 32-byte arrays. The caller is responsible for persisting
     * the private key to `SecureStorage` — we do NOT stash it here so the
     * caller can decide the key naming scheme (per-agent, per-user, etc).
     *
     * Throws [UnsupportedOperationException] on API < 33.
     */
    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    fun generateKeypair(): Pair<ByteArray, ByteArray> {
        if (!Build.VERSION.SDK_INT.supportsEd25519()) {
            throw UnsupportedOperationException(
                "Ed25519 requires API 33+, got ${Build.VERSION.SDK_INT}"
            )
        }
        // Do NOT call `gen.initialize(NamedParameterSpec("Ed25519"))`.
        // When the generator was already obtained via
        // `getInstance("Ed25519")`, the Conscrypt provider on Seeker
        // throws `InvalidAlgorithmParameterException: no
        // AlgorithmParameterSpec classes are supported` because the
        // curve is already bound and passing a spec is redundant. On
        // Ed25519 the params are fixed, so generation without
        // initialize() is the portable path.
        val gen = KeyPairGenerator.getInstance("Ed25519")
        val keypair: KeyPair = gen.generateKeyPair()

        val privateKey = keypair.private as EdECPrivateKey
        val publicKey = keypair.public as EdECPublicKey

        // Extract the raw 32-byte public key.
        // EdECPublicKey.point.getY() returns a BigInteger in the
        // Edwards-form y-coordinate; combined with the x-sign in the
        // high bit of byte 31. But the X.509-encoded public key also
        // contains the canonical 32-byte seed at the end of the DER
        // structure — specifically the last 32 bytes of getEncoded().
        val publicRaw = extractRawPublicKey(publicKey)

        // Private key raw bytes: the 32-byte seed sits in the
        // PKCS#8-encoded DER structure. EdECPrivateKey provides
        // getBytes() which returns the seed directly on API 33+.
        val privateRaw = privateKey.bytes.orElseThrow {
            IllegalStateException("EdECPrivateKey has no raw bytes")
        }

        return Pair(publicRaw, privateRaw)
    }

    /**
     * Sign [message] with a previously-generated Ed25519 private key seed.
     * [privateKeySeed] must be exactly 32 bytes (the raw ed25519 seed).
     * Returns the 64-byte signature.
     */
    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    fun sign(privateKeySeed: ByteArray, message: ByteArray): ByteArray {
        if (privateKeySeed.size != 32) {
            throw IllegalArgumentException(
                "Ed25519 private key seed must be 32 bytes, got ${privateKeySeed.size}"
            )
        }
        if (!Build.VERSION.SDK_INT.supportsEd25519()) {
            throw UnsupportedOperationException(
                "Ed25519 requires API 33+, got ${Build.VERSION.SDK_INT}"
            )
        }

        // Reconstruct the EdECPrivateKey from the raw seed.
        // Encode as PKCS#8 DER: the ASN.1 wrapper is fixed for Ed25519
        // — we prepend the 16-byte PrivateKeyInfo header to the 32-byte
        // seed. This is the only form some Conscrypt builds accept
        // (EdECPrivateKeySpec was flaky on the Seeker in testing).
        val pkcs8Header = byteArrayOf(
            0x30, 0x2e,                   // SEQUENCE (46 bytes)
            0x02, 0x01, 0x00,             // INTEGER version 0
            0x30, 0x05,                   // SEQUENCE (5 bytes)
            0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112 (Ed25519)
            0x04, 0x22,                   // OCTET STRING (34 bytes)
            0x04, 0x20,                   // inner OCTET STRING (32 bytes)
        )
        val pkcs8 = pkcs8Header + privateKeySeed
        val keyFactory = java.security.KeyFactory.getInstance("Ed25519")
        val privateKey = keyFactory.generatePrivate(
            java.security.spec.PKCS8EncodedKeySpec(pkcs8)
        )

        val signature = Signature.getInstance("Ed25519")
        signature.initSign(privateKey)
        signature.update(message)
        val sig = signature.sign()
        if (sig.size != 64) {
            throw IllegalStateException("Ed25519 signature should be 64 bytes, got ${sig.size}")
        }
        return sig
    }

    /**
     * Pull the raw 32-byte ed25519 public key out of an [EdECPublicKey].
     * The JDK exposes the point via `getPoint()` which returns an
     * [java.security.spec.EdECPoint] — but we need the canonical wire
     * format (32 bytes little-endian y with the sign bit of x in bit 255
     * of the last byte). Compose it manually.
     */
    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    private fun extractRawPublicKey(publicKey: EdECPublicKey): ByteArray {
        val point = publicKey.point
        val y = point.y.toByteArray() // big-endian unsigned
        // Convert to little-endian, zero-pad to 32 bytes
        val yLe = ByteArray(32)
        val len = minOf(y.size, 32)
        for (i in 0 until len) {
            yLe[i] = y[y.size - 1 - i]
        }
        // Set the high bit of byte 31 if x is odd (sign of x)
        if (point.isXOdd) {
            yLe[31] = (yLe[31].toInt() or 0x80).toByte()
        }
        return yLe
    }

    private fun Int.supportsEd25519(): Boolean = this >= Build.VERSION_CODES.TIRAMISU
}

package xyz.ghola.app.crypto

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.bouncycastle.math.ec.rfc7748.X25519
import org.bouncycastle.math.ec.rfc8032.Ed25519
import xyz.ghola.app.solana.Base58
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * # Sealed Envelope v1 — Kotlin port
 *
 * Byte-for-byte port of `crates/said-envelope/src/lib.rs` (Rust) and
 * `apps/web/src/lib/envelope.ts` (Web Crypto / `@noble/curves`). A frame
 * sealed by any one of the three implementations decodes cleanly in any
 * other; the `ParityVectorsTest` proves that with vectors generated from
 * the Rust crate.
 *
 * ## Wire format (must not drift)
 *
 * ```
 * magic               4  bytes  = b"SEv1"
 * version             1  byte   = 0x01
 * recipient_kind      1  byte   = 0x00 self | 0x01 peer-DID | 0x02 model-bridge
 * sender_did_len      2  bytes  big-endian
 * sender_did          var       UTF-8 did:key string
 * recipient_id_len    2  bytes  big-endian
 * recipient_id        var       UTF-8 did:key OR opaque model-id
 * ephem_pub          32  bytes  X25519 ephemeral public key
 * nonce              12  bytes  AES-GCM nonce
 * ad_len              2  bytes  big-endian length of associated data
 * ad                  var       associated data
 * ct_len              4  bytes  big-endian length of (ciphertext || tag)
 * ciphertext + tag    var       AES-256-GCM output (includes the 16-byte tag)
 * sig                64  bytes  Ed25519 signature over SHA-256 of every byte
 *                                preceding `sig`, by the sender's identity key
 * ```
 *
 * ## Threat model
 *
 * The cloud sees: header bytes, ephemeral public key, opaque ciphertext,
 * signature. It can route by `sender_did` / `recipient_id` and verify the
 * signature, but cannot recover plaintext because the DEK derives from
 * `X25519(ephem_priv, recipient_pub)` and only the recipient holds the
 * matching X25519 secret. The signature prevents a malicious cloud from
 * swapping ciphertexts between users.
 */
object Envelope {

    val MAGIC: ByteArray = byteArrayOf(0x53, 0x45, 0x76, 0x31) // "SEv1"
    const val VERSION: Byte = 0x01
    const val NONCE_LEN = 12
    const val TAG_LEN = 16
    const val EPHEM_PUB_LEN = 32
    const val SIGNATURE_LEN = 64
    private val HKDF_INFO_PREFIX = "said-envelope-v1/".toByteArray(Charsets.UTF_8)
    private val HKDF_SALT: ByteArray = MAGIC + byteArrayOf(VERSION)

    private val ED25519_MULTICODEC = byteArrayOf(0xed.toByte(), 0x01)

    private val rng = SecureRandom()

    enum class RecipientKind(val byte: Byte) {
        SelfRecipient(0x00),
        PeerDid(0x01),
        ModelBridge(0x02);

        companion object {
            fun fromByte(b: Byte): RecipientKind = when (b) {
                0x00.toByte() -> SelfRecipient
                0x01.toByte() -> PeerDid
                0x02.toByte() -> ModelBridge
                else -> throw EnvelopeError.InvalidRecipientKind(b)
            }
        }
    }

    sealed class EnvelopeError(message: String) : RuntimeException(message) {
        object Truncated : EnvelopeError("envelope is too short")
        object BadMagic : EnvelopeError("magic mismatch — expected SEv1")
        class BadVersion(version: Byte) : EnvelopeError("unsupported envelope version: $version")
        class InvalidRecipientKind(b: Byte) :
            EnvelopeError("invalid recipient kind byte: 0x${"%02x".format(b)}")
        class InvalidSenderDid(detail: String) : EnvelopeError("invalid sender did: $detail")
        object DidNotEd25519 : EnvelopeError("did:key did not encode an Ed25519 key")
        object InvalidEphemPub : EnvelopeError("invalid ephemeral public key")
        object AeadFailed : EnvelopeError("AEAD open failed (likely tamper or wrong recipient)")
        object BadSignature : EnvelopeError("signature verification failed")
        class LengthOverflow(field: String) : EnvelopeError("field length overflow: $field")
    }

    /** Sign 32 bytes with an Ed25519 secret seed. */
    fun interface Ed25519BodySigner {
        /** Returns a 64-byte detached signature over `bytes`. */
        fun sign(bytes: ByteArray): ByteArray
    }

    data class SealParams(
        val senderDid: String,
        val kind: RecipientKind,
        val recipientId: String,
        val recipientX25519: ByteArray,
        val associatedData: ByteArray,
        val plaintext: ByteArray,
        val signBody: Ed25519BodySigner,
    )

    data class Opened(
        val kind: RecipientKind,
        val senderDid: String,
        val recipientId: String,
        val associatedData: ByteArray,
        val plaintext: ByteArray,
    )

    // ── did:key helpers (Ed25519 multicodec) ────────────────────────────

    /** Encode a 32-byte Ed25519 verifying key as a `did:key:zXXX` string. */
    fun didKeyFromVerifying(pub: ByteArray): String {
        require(pub.size == 32) { "Ed25519 pub must be 32 bytes" }
        val multi = ED25519_MULTICODEC + pub
        return "did:key:z" + Base58.encode(multi)
    }

    /** Decode a `did:key:zXXX` string into the Ed25519 verifying key bytes. */
    fun verifyingFromDidKey(did: String): ByteArray {
        val rest = did.removePrefix("did:key:z")
        if (rest === did) {
            throw EnvelopeError.InvalidSenderDid("not a did:key: $did")
        }
        val bytes = try {
            Bs58.decode(rest)
        } catch (e: IllegalArgumentException) {
            throw EnvelopeError.InvalidSenderDid("invalid base58 in did:key")
        }
        if (bytes.size != 2 + 32) throw EnvelopeError.DidNotEd25519
        if (bytes[0] != ED25519_MULTICODEC[0] || bytes[1] != ED25519_MULTICODEC[1]) {
            throw EnvelopeError.DidNotEd25519
        }
        return bytes.copyOfRange(2, bytes.size)
    }

    // ── Edwards → Montgomery (Ed25519 → X25519 public) ──────────────────

    /**
     * Map an Ed25519 verifying key to its X25519 (Montgomery) form. Mirrors
     * `ed25519_verifying_to_x25519` in Rust: decompress the Edwards point
     * and emit the Montgomery u-coordinate.
     */
    fun edwardsPubToX25519(edPub: ByteArray): ByteArray {
        require(edPub.size == 32) { "Ed25519 pub must be 32 bytes" }
        // BouncyCastle's RFC 8032 helper provides the decompression; we use
        // the algebraic identity u = (1 + y) / (1 - y) on the recovered y.
        // Rather than re-derive that, lean on BC's `Ed25519.precompute()` +
        // point-decoding via Ed25519.Public conversion. As of bcprov 1.78
        // there is no direct "Ed→Mont" helper, so we re-implement the
        // standard identity below.
        val y = ByteArray(32)
        // Ed25519 encodes y little-endian with the sign of x in bit 255.
        for (i in 0 until 32) y[i] = edPub[i]
        y[31] = (y[31].toInt() and 0x7F).toBe()

        // Compute u = (1 + y) / (1 - y) mod p, p = 2^255 - 19. All math is
        // little-endian fe25519. We use BigInteger for clarity — performance
        // is irrelevant here (called at most once per envelope).
        val p = java.math.BigInteger.ONE.shiftLeft(255).subtract(java.math.BigInteger.valueOf(19))
        val yInt = leToBigInt(y)
        val onePlusY = java.math.BigInteger.ONE.add(yInt).mod(p)
        val oneMinusY = java.math.BigInteger.ONE.subtract(yInt).mod(p)
        val u = onePlusY.multiply(oneMinusY.modInverse(p)).mod(p)
        return bigIntToLe(u, 32)
    }

    private fun Int.toBe(): Byte = this.toByte()

    private fun leToBigInt(le: ByteArray): java.math.BigInteger {
        val be = ByteArray(le.size + 1) // leading 0 to keep positive
        for (i in le.indices) be[le.size - i] = le[i]
        return java.math.BigInteger(be)
    }

    private fun bigIntToLe(n: java.math.BigInteger, length: Int): ByteArray {
        val be = n.toByteArray()
        val le = ByteArray(length)
        // be is big-endian, possibly with a leading sign byte; copy LSB-first.
        var src = be.size - 1
        var dst = 0
        while (dst < length && src >= 0) {
            le[dst] = be[src]
            dst++; src--
        }
        return le
    }

    // ── DEK derivation ──────────────────────────────────────────────────

    private fun deriveDek(sharedSecret: ByteArray, recipientId: String): ByteArray {
        val info = HKDF_INFO_PREFIX + recipientId.toByteArray(Charsets.UTF_8)
        return Hkdf.extractAndExpand(salt = HKDF_SALT, ikm = sharedSecret, info = info, length = 32)
    }

    // ── Wire encoding helpers ───────────────────────────────────────────

    private class BodyBuilder {
        val out = java.io.ByteArrayOutputStream()
        fun bytes(b: ByteArray) { out.write(b) }
        fun byte(b: Byte) { out.write(b.toInt()) }
        fun u16(n: Int, field: String) {
            if (n < 0 || n > 0xFFFF) throw EnvelopeError.LengthOverflow(field)
            out.write((n ushr 8) and 0xFF)
            out.write(n and 0xFF)
        }
        fun u32(n: Int, field: String) {
            if (n < 0) throw EnvelopeError.LengthOverflow(field)
            out.write((n ushr 24) and 0xFF)
            out.write((n ushr 16) and 0xFF)
            out.write((n ushr 8) and 0xFF)
            out.write(n and 0xFF)
        }
        fun toByteArray(): ByteArray = out.toByteArray()
    }

    private class Cursor(val buf: ByteArray) {
        var pos = 0
        fun take(n: Int): ByteArray {
            if (n < 0 || pos + n > buf.size) throw EnvelopeError.Truncated
            val slice = buf.copyOfRange(pos, pos + n)
            pos += n
            return slice
        }
        fun takeU8(): Int = take(1)[0].toInt() and 0xFF
        fun takeU16(): Int {
            val b = take(2)
            return ((b[0].toInt() and 0xFF) shl 8) or (b[1].toInt() and 0xFF)
        }
        fun takeU32(): Int {
            val b = take(4)
            // Treat the high bit as a hard cap — payloads larger than 2 GiB
            // are not a real shape for envelope frames.
            val v = ((b[0].toInt() and 0xFF) shl 24) or
                ((b[1].toInt() and 0xFF) shl 16) or
                ((b[2].toInt() and 0xFF) shl 8) or
                (b[3].toInt() and 0xFF)
            if (v < 0) throw EnvelopeError.LengthOverflow("ct_len")
            return v
        }
    }

    // ── seal ────────────────────────────────────────────────────────────

    /**
     * Encrypt + sign a single envelope frame; return the wire bytes.
     *
     * The signing step is delegated to `params.signBody` so production
     * callers can route through the cached chat-sign Ed25519 seed (or a
     * wallet, in the Pair Device flow) while tests pass a local signer.
     */
    fun seal(params: SealParams): ByteArray {
        if (params.recipientX25519.size != EPHEM_PUB_LEN) {
            throw IllegalArgumentException("recipient X25519 pub must be 32 bytes")
        }
        // Per-envelope ephemeral X25519 keypair.
        val ephem = X25519PrivateKeyParameters(rng)
        val ephemPub = ephem.generatePublicKey().encoded
        val shared = ByteArray(EPHEM_PUB_LEN)
        ephem.generateSecret(X25519PublicKeyParameters(params.recipientX25519, 0), shared, 0)

        val dek = deriveDek(shared, params.recipientId)
        val nonceBytes = ByteArray(NONCE_LEN).also { rng.nextBytes(it) }
        val ciphertext = aesGcmEncrypt(dek, nonceBytes, params.associatedData, params.plaintext)
        zero(dek)

        val senderDidBytes = params.senderDid.toByteArray(Charsets.UTF_8)
        val recipientIdBytes = params.recipientId.toByteArray(Charsets.UTF_8)

        val body = BodyBuilder().apply {
            bytes(MAGIC)
            byte(VERSION)
            byte(params.kind.byte)
            u16(senderDidBytes.size, "sender_did")
            bytes(senderDidBytes)
            u16(recipientIdBytes.size, "recipient_id")
            bytes(recipientIdBytes)
            bytes(ephemPub)
            bytes(nonceBytes)
            u16(params.associatedData.size, "associated_data")
            bytes(params.associatedData)
            u32(ciphertext.size, "ciphertext")
            bytes(ciphertext)
        }.toByteArray()

        val digest = MessageDigest.getInstance("SHA-256").digest(body)
        val sig = params.signBody.sign(digest)
        if (sig.size != SIGNATURE_LEN) {
            throw IllegalStateException("signBody returned ${sig.size} bytes; expected $SIGNATURE_LEN")
        }
        return body + sig
    }

    // ── open ────────────────────────────────────────────────────────────

    /**
     * Verify the signature, derive the DEK, and decrypt.
     *
     * `recipientX25519Secret` is the 32-byte X25519 secret of whoever owns
     * `recipient_id`. For peer/self envelopes it's the vault's derived
     * X25519 secret; for model-bridge it's the cloud's per-session bridge
     * secret (not used in v0.3 Android).
     */
    fun open(wire: ByteArray, recipientX25519Secret: ByteArray): Opened {
        require(recipientX25519Secret.size == EPHEM_PUB_LEN) {
            "recipient X25519 secret must be 32 bytes"
        }
        if (wire.size < SIGNATURE_LEN + MAGIC.size + 2) throw EnvelopeError.Truncated

        val bodyEnd = wire.size - SIGNATURE_LEN
        val body = wire.copyOfRange(0, bodyEnd)
        val sigBytes = wire.copyOfRange(bodyEnd, wire.size)

        val cur = Cursor(body)

        val magic = cur.take(MAGIC.size)
        if (!magic.contentEquals(MAGIC)) throw EnvelopeError.BadMagic
        val version = cur.take(1)[0]
        if (version != VERSION) throw EnvelopeError.BadVersion(version)
        val kind = RecipientKind.fromByte(cur.take(1)[0])

        val senderDidLen = cur.takeU16()
        val senderDidBytes = cur.take(senderDidLen)
        val senderDid = try {
            String(senderDidBytes, Charsets.UTF_8)
        } catch (_: Exception) {
            throw EnvelopeError.InvalidSenderDid("non-utf8 sender_did")
        }

        val recipientIdLen = cur.takeU16()
        val recipientIdBytes = cur.take(recipientIdLen)
        val recipientId = try {
            String(recipientIdBytes, Charsets.UTF_8)
        } catch (_: Exception) {
            throw EnvelopeError.InvalidSenderDid("non-utf8 recipient_id")
        }

        val ephemPub = cur.take(EPHEM_PUB_LEN)
        val nonceBytes = cur.take(NONCE_LEN)

        val adLen = cur.takeU16()
        val associatedData = cur.take(adLen)

        val ctLen = cur.takeU32()
        val ciphertext = cur.take(ctLen)

        if (cur.pos != body.size) throw EnvelopeError.Truncated

        // Verify Ed25519 signature first — cheaper to bail than to attempt AEAD.
        val senderPub = verifyingFromDidKey(senderDid)
        val digest = MessageDigest.getInstance("SHA-256").digest(body)
        val sigOk = ed25519Verify(senderPub, digest, sigBytes)
        if (!sigOk) throw EnvelopeError.BadSignature

        // Derive DEK and decrypt.
        val shared = ByteArray(EPHEM_PUB_LEN)
        X25519.scalarMult(recipientX25519Secret, 0, ephemPub, 0, shared, 0)
        val dek = deriveDek(shared, recipientId)
        val plaintext = try {
            aesGcmDecrypt(dek, nonceBytes, associatedData, ciphertext)
        } catch (_: Exception) {
            zero(dek)
            throw EnvelopeError.AeadFailed
        }
        zero(dek)

        return Opened(
            kind = kind,
            senderDid = senderDid,
            recipientId = recipientId,
            associatedData = associatedData,
            plaintext = plaintext,
        )
    }

    // ── X25519 utilities (used by VaultIdentity, Pair Device) ───────────

    fun x25519PublicFromSecret(secret: ByteArray): ByteArray {
        require(secret.size == 32) { "X25519 secret must be 32 bytes" }
        val out = ByteArray(32)
        X25519.scalarMultBase(secret, 0, out, 0)
        return out
    }

    fun x25519DiffieHellman(secret: ByteArray, peerPub: ByteArray): ByteArray {
        require(secret.size == 32 && peerPub.size == 32)
        val out = ByteArray(32)
        X25519.scalarMult(secret, 0, peerPub, 0, out, 0)
        return out
    }

    // ── Ed25519 helpers ─────────────────────────────────────────────────

    /** Build a body-signer from a 32-byte Ed25519 seed. */
    fun localEd25519Signer(seed: ByteArray): Ed25519BodySigner {
        require(seed.size == 32) { "Ed25519 seed must be 32 bytes" }
        val priv = Ed25519PrivateKeyParameters(seed, 0)
        return Ed25519BodySigner { msg ->
            val signer = Ed25519Signer().apply { init(true, priv) }
            signer.update(msg, 0, msg.size)
            signer.generateSignature()
        }
    }

    /** Public key (verifying key) for a 32-byte Ed25519 seed. */
    fun ed25519PublicFromSeed(seed: ByteArray): ByteArray {
        require(seed.size == 32) { "Ed25519 seed must be 32 bytes" }
        return Ed25519PrivateKeyParameters(seed, 0).generatePublicKey().encoded
    }

    private fun ed25519Verify(pub: ByteArray, msg: ByteArray, sig: ByteArray): Boolean {
        if (sig.size != SIGNATURE_LEN) return false
        if (pub.size != 32) return false
        return try {
            Ed25519.verify(sig, 0, pub, 0, msg, 0, msg.size)
        } catch (_: Exception) {
            false
        }
    }

    // ── AES-256-GCM ─────────────────────────────────────────────────────

    private fun aesGcmEncrypt(
        key: ByteArray, nonce: ByteArray, ad: ByteArray, plaintext: ByteArray,
    ): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(TAG_LEN * 8, nonce),
        )
        if (ad.isNotEmpty()) cipher.updateAAD(ad)
        return cipher.doFinal(plaintext)
    }

    private fun aesGcmDecrypt(
        key: ByteArray, nonce: ByteArray, ad: ByteArray, ciphertext: ByteArray,
    ): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(TAG_LEN * 8, nonce),
        )
        if (ad.isNotEmpty()) cipher.updateAAD(ad)
        return cipher.doFinal(ciphertext)
    }

    private fun zero(b: ByteArray) {
        for (i in b.indices) b[i] = 0
    }
}

/** Internal base58 (Bitcoin alphabet) decode, paired with `Base58.encode`. */
internal object Bs58 {
    private const val ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    private val INDEXES = IntArray(128) { -1 }.also {
        for (i in ALPHABET.indices) it[ALPHABET[i].code] = i
    }

    fun decode(input: String): ByteArray {
        if (input.isEmpty()) return ByteArray(0)
        val input58 = IntArray(input.length)
        for (i in input.indices) {
            val c = input[i]
            val digit = if (c.code < 128) INDEXES[c.code] else -1
            require(digit >= 0) { "invalid base58 char at $i" }
            input58[i] = digit
        }
        var zeros = 0
        while (zeros < input58.size && input58[zeros] == 0) zeros++
        val decoded = ByteArray(input.length)
        var outputStart = decoded.size
        var startAt = zeros
        while (startAt < input58.size) {
            val mod = divmod(input58, startAt, 58, 256)
            if (input58[startAt] == 0) startAt++
            decoded[--outputStart] = mod.toByte()
        }
        while (outputStart < decoded.size && decoded[outputStart].toInt() == 0) outputStart++
        return ByteArray(zeros) + decoded.copyOfRange(outputStart, decoded.size)
    }

    private fun divmod(number: IntArray, firstDigit: Int, base: Int, divisor: Int): Int {
        var remainder = 0
        for (i in firstDigit until number.size) {
            val digit = number[i]
            val temp = remainder * base + digit
            number[i] = temp / divisor
            remainder = temp % divisor
        }
        return remainder
    }
}

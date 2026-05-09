package xyz.ghola.app.crypto

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.security.SecureRandom
import java.util.concurrent.TimeUnit

/**
 * Pair Device — wallet-to-wallet transfer of session DEKs over an
 * untrusted cloud mailbox. Mirror of `apps/web/src/lib/pair-device.ts`.
 *
 * Same-platform only (Android↔Android in v0.3) — see plan, Out of scope §1.
 * Web↔Android pairing requires aligning sender-DID conventions; tracked
 * for a follow-up.
 */
object PairDevice {

    private const val HANDSHAKE_ID_BYTES = 24
    private const val POLL_INTERVAL_MS = 1_000L
    private const val POLL_TIMEOUT_MS = 110_000L
    private val HANDSHAKE_AD = "ghola/pair-device-v1".toByteArray(Charsets.UTF_8)
    private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    private val rng = SecureRandom()

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    /** What the receiver renders into a QR code for the sender to scan. */
    data class HandshakeDescriptor(
        val v: Int,
        val id: String,
        val ephemPubB64: String,
        val expectedSenderDid: String,
    ) {
        fun toJson(): String = JSONObject().apply {
            put("v", v)
            put("id", id)
            put("ephemPubB64", ephemPubB64)
            put("expectedSenderDid", expectedSenderDid)
        }.toString()

        companion object {
            fun fromJson(s: String): HandshakeDescriptor {
                val o = JSONObject(s)
                return HandshakeDescriptor(
                    v = o.getInt("v"),
                    id = o.getString("id"),
                    ephemPubB64 = o.getString("ephemPubB64"),
                    expectedSenderDid = o.getString("expectedSenderDid"),
                )
            }
        }
    }

    /** Held by the receiving device until the sender's envelope arrives. */
    data class ReceiverHandshake(
        val descriptor: HandshakeDescriptor,
        /** 32-byte ephemeral X25519 secret. In-memory only. */
        val ephemSecret: ByteArray,
    ) {
        fun zeroize() { for (i in ephemSecret.indices) ephemSecret[i] = 0 }
    }

    data class AwaitResult(val imported: Int, val senderDid: String)

    // ── Receiver ────────────────────────────────────────────────────────

    /**
     * Generate a fresh receiver handshake. `expectedSenderDid` MUST be
     * the user's own wallet DID — it's the only trust anchor we have
     * against a malicious cloud substituting an envelope from someone
     * else.
     */
    fun createReceiverHandshake(expectedSenderDid: String): ReceiverHandshake {
        val idBytes = ByteArray(HANDSHAKE_ID_BYTES).also { rng.nextBytes(it) }
        val id = b64urlEncode(idBytes)

        val ephemPriv = X25519PrivateKeyParameters(rng)
        val ephemPub = ephemPriv.generatePublicKey().encoded

        return ReceiverHandshake(
            descriptor = HandshakeDescriptor(
                v = 1,
                id = id,
                ephemPubB64 = b64urlEncode(ephemPub),
                expectedSenderDid = expectedSenderDid,
            ),
            ephemSecret = ephemPriv.encoded,
        )
    }

    /**
     * Poll the cloud mailbox until the sender's envelope arrives, then
     * verify, decrypt, and import each DEK into [vault]. Throws if the
     * sender DID doesn't match the receiver's pinned expected DID — a
     * malicious cloud cannot bypass that.
     *
     * Blocks the calling thread; run from a coroutine scope on
     * Dispatchers.IO.
     */
    @Throws(IOException::class)
    fun awaitHandshake(
        baseUrl: String,
        receiver: ReceiverHandshake,
        vault: VaultStore,
    ): AwaitResult {
        val deadline = System.currentTimeMillis() + POLL_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            val wire = pollOnce(baseUrl, receiver.descriptor.id)
            if (wire != null) {
                return importEnvelope(wire, receiver, vault)
            }
            Thread.sleep(POLL_INTERVAL_MS)
        }
        throw IOException("pair-device handshake timed out after ${POLL_TIMEOUT_MS / 1000}s")
    }

    private fun importEnvelope(
        wire: ByteArray,
        receiver: ReceiverHandshake,
        vault: VaultStore,
    ): AwaitResult {
        val opened = Envelope.open(wire, receiver.ephemSecret)
        if (opened.senderDid != receiver.descriptor.expectedSenderDid) {
            throw IOException(
                "unexpected sender DID: got ${opened.senderDid}, " +
                    "expected ${receiver.descriptor.expectedSenderDid}"
            )
        }
        val payloadStr = String(opened.plaintext, Charsets.UTF_8)
        val payload = JSONObject(payloadStr)
        if (payload.optInt("v", 0) != 1) {
            throw IOException("invalid Pair-Device payload version")
        }
        val sessions = payload.optJSONArray("sessions") ?: JSONArray()
        var imported = 0
        for (i in 0 until sessions.length()) {
            val s = sessions.optJSONObject(i) ?: continue
            val sessionId = s.optString("sessionId").takeIf { it.isNotEmpty() } ?: continue
            val dekB64 = s.optString("dekB64").takeIf { it.isNotEmpty() } ?: continue
            val dek = b64urlDecode(dekB64)
            if (dek.size != 32) throw IOException("invalid DEK length for $sessionId")
            val kindByte = (s.optInt("recipientKind", 0) and 0xFF).toByte()
            val kind = try {
                Envelope.RecipientKind.fromByte(kindByte)
            } catch (_: Exception) {
                Envelope.RecipientKind.SelfRecipient
            }
            vault.importSessionDek(sessionId, dek, kind)
            imported++
        }
        return AwaitResult(imported = imported, senderDid = opened.senderDid)
    }

    private fun pollOnce(baseUrl: String, id: String): ByteArray? {
        val req = Request.Builder()
            .url("$baseUrl/api/devices/handshake/$id")
            .get()
            .build()
        return httpClient.newCall(req).execute().use { resp ->
            when (resp.code) {
                404 -> null
                in 200..299 -> {
                    val body = resp.body?.string() ?: return@use null
                    val obj = JSONObject(body)
                    b64urlDecode(obj.getString("envelope_b64"))
                }
                else -> {
                    val msg = resp.body?.string() ?: ""
                    throw IOException("handshake poll failed (${resp.code}): $msg")
                }
            }
        }
    }

    // ── Sender ──────────────────────────────────────────────────────────

    /**
     * Build a sealed handshake envelope from the sender's session DEKs
     * and POST it to the cloud mailbox.
     *
     * The body is signed with the sender's wallet via [walletSigner] —
     * one MWA popup is acceptable in this rare flow because the receiver
     * pins `expectedSenderDid` to the wallet DID and accepts only that
     * identity. (Chat-message envelopes use the cached chat-sign seed
     * instead; that asymmetry is the source of the "no cross-platform
     * v0.3" constraint, see the approved plan.)
     */
    @Throws(IOException::class)
    fun sendHandshake(
        baseUrl: String,
        descriptor: HandshakeDescriptor,
        vault: VaultStore,
        senderWalletDid: String,
        walletSigner: Envelope.Ed25519BodySigner,
        sessionIds: List<String>? = null,
    ): Int {
        require(descriptor.v == 1) { "unsupported handshake descriptor version: ${descriptor.v}" }
        val ephemPub = b64urlDecode(descriptor.ephemPubB64)
        require(ephemPub.size == 32) { "descriptor ephemPub must be 32 bytes" }

        val all = vault.listSessions()
        val wanted = if (sessionIds == null) all
        else all.filter { it.sessionId in sessionIds }

        val sessionsJson = JSONArray()
        for (s in wanted) {
            val dek = try {
                vault.getOrCreateSessionDek(s.sessionId, s.recipientKind)
            } catch (_: Exception) {
                continue // raced with deletion or vault locked — skip
            }
            sessionsJson.put(JSONObject().apply {
                put("sessionId", s.sessionId)
                put("dekB64", b64urlEncode(dek))
                put("recipientKind", s.recipientKind.byte.toInt() and 0xFF)
                put("createdAt", System.currentTimeMillis())
            })
        }
        val payload = JSONObject().apply {
            put("v", 1)
            put("sessions", sessionsJson)
        }
        val plaintext = payload.toString().toByteArray(Charsets.UTF_8)

        // recipientId is "ephem-x25519:<base64>" — used only as the HKDF
        // info string at DEK derivation, NOT as the X25519 ECDH input
        // (that's the raw pub bytes). Same convention as web.
        val recipientId = "ephem-x25519:${descriptor.ephemPubB64}"

        val wire = Envelope.seal(
            Envelope.SealParams(
                senderDid = senderWalletDid,
                kind = Envelope.RecipientKind.PeerDid,
                recipientId = recipientId,
                recipientX25519 = ephemPub,
                associatedData = HANDSHAKE_AD,
                plaintext = plaintext,
                signBody = walletSigner,
            ),
        )

        val body = JSONObject().apply {
            put("id", descriptor.id)
            put("envelope_b64", b64urlEncode(wire))
        }.toString().toRequestBody(JSON_MEDIA)
        val req = Request.Builder()
            .url("$baseUrl/api/devices/handshake")
            .post(body)
            .build()
        httpClient.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                val msg = resp.body?.string() ?: ""
                throw IOException("handshake POST failed (${resp.code}): $msg")
            }
        }
        return sessionsJson.length()
    }

    // ── b64url helpers (no-pad, matches the web client) ─────────────────

    private val b64UrlEncoder = java.util.Base64.getUrlEncoder().withoutPadding()
    private val b64UrlDecoder = java.util.Base64.getUrlDecoder()

    private fun b64urlEncode(bytes: ByteArray): String = b64UrlEncoder.encodeToString(bytes)
    private fun b64urlDecode(s: String): ByteArray = b64UrlDecoder.decode(s)
}

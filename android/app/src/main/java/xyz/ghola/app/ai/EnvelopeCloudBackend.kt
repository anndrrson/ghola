package xyz.ghola.app.ai

import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSource
import org.json.JSONArray
import org.json.JSONObject
import xyz.ghola.app.crypto.Envelope
import xyz.ghola.app.crypto.VaultStore
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * E2E-encrypted cloud backend.
 *
 * Talks to thumper-cloud's `POST /api/chat`, passing the user's outbound
 * message as a sealed-envelope-v1 ciphertext. The cloud persists the
 * ciphertext verbatim and never sees plaintext for that row (see
 * `crates/thumper-cloud/src/routes/chat.rs:64-97`). The SSE response is
 * plaintext today (the cloud doesn't yet send streaming envelopes back),
 * so we accumulate `text_delta` events into a single `ApiResponse`.
 *
 * The vault must be unlocked before construction; ChatActivity is
 * responsible for that. Tool-use is not supported in v0.3 — agentic flows
 * (wallet calls, etc.) still go through the legacy direct-to-LLM path.
 */
class EnvelopeCloudBackend(
    private val baseUrl: String,
    private val authToken: String,
    private val vault: VaultStore,
    private val sessionId: UUID = UUID.randomUUID(),
) : LlmBackend {

    companion object {
        private const val TAG = "E2EChatBackend"
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }

    override val displayName: String = "End-to-end encrypted (Ghola)"
    override val requiresInternet: Boolean = true

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        // SSE — disable read timeout so a slow LLM doesn't get killed.
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val cancelled = AtomicBoolean(false)

    override fun generate(
        messages: JSONArray,
        tools: JSONArray,
        system: String,
        forceToolUse: Boolean,
    ): ApiResponse {
        cancelled.set(false)
        val userText = lastUserMessageText(messages)
            ?: throw IOException("EnvelopeCloudBackend: no user message in history")

        val envelopeB64 = sealUserMessage(userText)

        val requestBody = JSONObject().apply {
            put("session_id", sessionId.toString())
            put("message", userText) // The cloud route still requires the
            // field for backwards compatibility, but it stores ciphertext
            // when envelope_blob_b64 is present (see chat.rs).
            put("envelope_blob_b64", envelopeB64)
        }

        val request = Request.Builder()
            .url("$baseUrl/api/chat")
            .header("Authorization", "Bearer $authToken")
            .header("Accept", "text/event-stream")
            .post(requestBody.toString().toRequestBody(JSON_MEDIA))
            .build()

        val response = client.newCall(request).execute()
        return response.use { resp ->
            if (!resp.isSuccessful) {
                val body = try { resp.body?.string() } catch (_: Exception) { null }
                throw IOException("/api/chat failed (${resp.code}): ${body ?: ""}")
            }
            val source = resp.body?.source()
                ?: throw IOException("/api/chat: empty response body")
            consumeSseToApiResponse(source)
        }
    }

    override fun cancel() {
        cancelled.set(true)
    }

    override fun shutdown() {
        cancelled.set(true)
    }

    /** Seal a single user message under the vault's self-recipient key. */
    private fun sealUserMessage(text: String): String {
        val mat = vault.material()
        val ad = "session=$sessionId;role=user".toByteArray(Charsets.UTF_8)
        val payload = JSONObject().apply {
            put("v", 1)
            put("session_id", sessionId.toString())
            put("role", "user")
            put("content", text)
        }
        val plaintext = payload.toString().toByteArray(Charsets.UTF_8)
        val wire = Envelope.seal(
            Envelope.SealParams(
                senderDid = mat.chatSignDid,
                kind = Envelope.RecipientKind.SelfRecipient,
                recipientId = vault.userDid,
                recipientX25519 = mat.x25519Public,
                associatedData = ad,
                plaintext = plaintext,
                signBody = vault.chatSigner(),
            ),
        )
        // The cloud decodes envelope_blob_b64 with STANDARD base64 (see
        // chat.rs:57). Use the same here.
        return java.util.Base64.getEncoder().encodeToString(wire)
    }

    /** Pull the most recent `role:"user"` text out of the message history. */
    private fun lastUserMessageText(messages: JSONArray): String? {
        for (i in messages.length() - 1 downTo 0) {
            val msg = messages.optJSONObject(i) ?: continue
            if (msg.optString("role") != "user") continue
            // Two shapes possible:
            //   { role: "user", content: "..." }
            //   { role: "user", content: [{ type: "text", text: "..." }, ...] }
            val raw = msg.opt("content") ?: continue
            when (raw) {
                is String -> return raw
                is JSONArray -> {
                    val sb = StringBuilder()
                    for (j in 0 until raw.length()) {
                        val block = raw.optJSONObject(j) ?: continue
                        if (block.optString("type") == "text") {
                            sb.append(block.optString("text"))
                        }
                    }
                    if (sb.isNotEmpty()) return sb.toString()
                }
            }
        }
        return null
    }

    /**
     * Consume the SSE stream, returning the accumulated assistant text +
     * a stop reason. We surface `error` events as IOException so
     * AgentController's catch block reports them like any other backend
     * failure.
     */
    private fun consumeSseToApiResponse(source: BufferedSource): ApiResponse {
        val text = StringBuilder()
        var event = ""
        var dataBuffer = StringBuilder()
        var error: String? = null

        fun dispatch() {
            if (event.isEmpty() && dataBuffer.isEmpty()) return
            val data = dataBuffer.toString()
            try {
                when (event) {
                    "session" -> {
                        // Cloud may rewrite our session id; ignored here
                        // because we already pinned ours into the envelope AD.
                    }
                    "text_delta" -> {
                        val obj = JSONObject(data)
                        text.append(obj.optString("text"))
                    }
                    "error" -> {
                        val obj = JSONObject(data)
                        error = obj.optString("error", data)
                    }
                    "done" -> { /* terminal */ }
                    "tool_use", "tool_result", "provider" -> {
                        // Server-side tool calls aren't routed through the E2E
                        // backend in v0.3; user-paired wallets stay on the
                        // direct-LLM path.
                    }
                    else -> Log.d(TAG, "ignoring unknown SSE event: $event")
                }
            } catch (e: Exception) {
                Log.w(TAG, "failed to parse SSE event '$event': $data", e)
            }
            event = ""
            dataBuffer = StringBuilder()
        }

        while (!cancelled.get() && !source.exhausted()) {
            val line = source.readUtf8Line() ?: break
            when {
                line.isEmpty() -> dispatch()
                line.startsWith(":") -> { /* comment */ }
                line.startsWith("event:") -> event = line.substring(6).trim()
                line.startsWith("data:") -> {
                    if (dataBuffer.isNotEmpty()) dataBuffer.append('\n')
                    dataBuffer.append(line.substring(5).trim())
                }
                else -> Log.d(TAG, "ignored SSE line: $line")
            }
        }
        dispatch()

        if (error != null) throw IOException("/api/chat error: $error")

        val blocks = listOf<ContentBlock>(ContentBlock.Text(text.toString()))
        return ApiResponse(blocks, "end_turn", null)
    }
}

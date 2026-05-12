package xyz.ghola.app.ai

import android.content.Context
import android.util.Log
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import xyz.ghola.app.email.LocalLlm
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Chat backend that runs entirely on-device.
 *
 * Replaces [EnvelopeCloudBackend] when the v0.5 local LLM is available — the
 * user's chat input never leaves the Seeker. The MediaPipe `LlmInference`
 * session ([LocalLlm]) is the same one the email path uses, so the model is
 * downloaded exactly once and shared across both surfaces.
 *
 * Tradeoffs vs the cloud backend:
 *   +  Privacy: no `/api/chat` round-trip, no upstream provider, no rate
 *      limits, no "Community free cascade hit Groq's per-minute cap" errors.
 *   +  Offline: works without network once the model file is on disk.
 *   −  Capability: a 4B-class on-device model isn't a frontier LLM. Long
 *      reasoning chains and tool use are weaker than Claude/GPT.
 *   −  Latency: ~5-15s on the Seeker Dimensity 9300 NPU vs <2s cloud.
 *
 * The user-facing message at the top of the chat ("Off the record. Even we
 * can't read it.") is honest in this path — there's no decryption key on a
 * cloud server because there's no cloud server in the loop.
 */
class LocalChatBackend(
    private val context: Context,
) : LlmBackend {

    companion object {
        private const val TAG = "LocalChatBackend"

        /**
         * Per-response token cap. Generous enough for multi-paragraph
         * answers; bounded so a runaway generation doesn't tie up the NPU
         * for minutes.
         */
        private const val MAX_RESPONSE_TOKENS = 512
    }

    override val displayName: String = "On-device (Qwen 2.5 1.5B)"
    override val requiresInternet: Boolean = false

    private val cancelled = AtomicBoolean(false)

    override fun generate(
        messages: JSONArray,
        tools: JSONArray,
        system: String,
        forceToolUse: Boolean,
    ): ApiResponse {
        cancelled.set(false)
        // Tool use is a no-op on the local backend for now — Phi-3 Mini
        // doesn't have a reliable function-calling format and we don't want
        // to ship hallucinated tool calls. Future: re-enable when we adopt
        // a model with native tools (Llama 3.1 8B / Mistral 7B with the
        // function-calling fine-tune).
        if (tools.length() > 0) {
            Log.d(TAG, "tool-use requested but local backend ignores tools (v0.5)")
        }

        val prompt = buildPrompt(messages = messages, system = system)
        val llm = runBlocking { LocalLlm.get(context) }
            ?: throw java.io.IOException(
                "Local model not ready — open Settings, switch to E2E once the model finishes downloading."
            )

        val text = llm.generateOnce(prompt)
            ?: throw java.io.IOException("On-device generation failed")

        if (cancelled.get()) {
            throw java.io.IOException("Generation cancelled")
        }

        // Trim leftover special tokens / stop-sequences the model sometimes
        // emits. Qwen 2.5 uses ChatML-style tags; Phi-3-style fallback tokens
        // are also stripped so the same code works if we ever switch models.
        val cleaned = text
            .substringBefore("<|im_end|>")
            .substringBefore("<|im_start|>")
            .substringBefore("<|end|>")
            .substringBefore("<|user|>")
            .substringBefore("<|endoftext|>")
            .trimEnd()

        return ApiResponse(
            contentBlocks = listOf(ContentBlock.Text(cleaned)),
            stopReason = "end_turn",
            usage = null,
        )
    }

    override fun cancel() {
        cancelled.set(true)
    }

    override fun shutdown() {
        cancelled.set(true)
        // Don't close LocalLlm here — it's a process-wide singleton shared
        // with the email path. LocalLlm.close() should be called from the
        // Application onTerminate (which Android rarely fires) or via an
        // explicit user "Free model memory" action in Settings.
    }

    /**
     * Render the chat history + system prompt into Qwen 2.5's ChatML format:
     *
     *   <|im_start|>system\n{system}<|im_end|>\n
     *   <|im_start|>user\n{user_msg_1}<|im_end|>\n
     *   <|im_start|>assistant\n{asst_msg_1}<|im_end|>\n
     *   …
     *   <|im_start|>user\n{user_msg_N}<|im_end|>\n
     *   <|im_start|>assistant\n
     *
     * Model continues from the final unclosed `assistant` tag; the
     * post-process in [generate] strips any echoed control tokens.
     */
    private fun buildPrompt(messages: JSONArray, system: String): String = buildString {
        if (system.isNotBlank()) {
            append("<|im_start|>system\n")
            append(system.trim())
            append("<|im_end|>\n")
        }
        for (i in 0 until messages.length()) {
            val msg = messages.optJSONObject(i) ?: continue
            val role = msg.optString("role").takeIf { it.isNotBlank() } ?: continue
            val content = extractText(msg.opt("content"))
            if (content.isBlank()) continue
            when (role) {
                "user" -> {
                    append("<|im_start|>user\n")
                    append(content)
                    append("<|im_end|>\n")
                }
                "assistant" -> {
                    append("<|im_start|>assistant\n")
                    append(content)
                    append("<|im_end|>\n")
                }
                "system" -> {
                    append("<|im_start|>system\n")
                    append(content)
                    append("<|im_end|>\n")
                }
            }
        }
        append("<|im_start|>assistant\n")
    }

    /**
     * Pull plain text out of the two shapes the codebase uses:
     *   { role:"user", content: "raw string" }
     *   { role:"user", content: [{type:"text", text:"..."}, ...] }
     */
    private fun extractText(raw: Any?): String = when (raw) {
        is String -> raw
        is JSONArray -> buildString {
            for (i in 0 until raw.length()) {
                val block = raw.optJSONObject(i) ?: continue
                if (block.optString("type") == "text") {
                    if (isNotEmpty()) append('\n')
                    append(block.optString("text"))
                }
            }
        }
        is JSONObject -> raw.optString("text", "")
        else -> ""
    }
}

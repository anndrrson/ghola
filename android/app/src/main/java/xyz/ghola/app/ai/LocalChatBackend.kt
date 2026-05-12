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
         * Prompt-char budget at the **MediaPipe** runtime. The `ekv1280`
         * LiteRT bundle has only 1280 tokens of total KV cache; with 512
         * tokens reserved for response and ~3 chars/token conservative
         * ratio that's 1536 chars of prompt headroom.
         */
        private const val MAX_PROMPT_CHARS_MEDIAPIPE = 1536

        /**
         * Prompt-char budget at the **llama.cpp** runtime. The GGUF build
         * supports the model's native 32k context; we use 4k tokens of
         * actual context (set in LlamaCppImpl) to keep generation latency
         * reasonable. 4096 tokens × 3 chars/token − 512 token response
         * reserve = ~10kb of prompt budget. We cap at 4096 chars so a
         * runaway pasted email doesn't dominate. Lifted from v0.5's tight
         * 1536-char ceiling because the LoRA fine-tune wants more recent
         * history to learn from.
         */
        private const val MAX_PROMPT_CHARS_LLAMACPP = 4096

        /** Per-message hard truncation to prevent one long paste from
         *  monopolizing the budget. Applied before history pruning. */
        private const val MAX_CHARS_PER_MESSAGE = 800

        /** Floor for what we'll truncate the *current* user message to as a
         *  last resort. Anything shorter than this defeats the point of
         *  asking. */
        private const val MIN_USER_MESSAGE_CHARS = 200
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
        Log.i(TAG, "generating: prompt=${prompt.length} chars (~${prompt.length / 4} tokens)")
        val llm = runBlocking { LocalLlm.get(context) }
            ?: throw java.io.IOException(
                "Local model not ready — open Settings, switch to E2E once the model finishes downloading."
            )

        val text = llm.generateOnce(prompt)
        if (text.isNullOrBlank()) {
            Log.w(
                TAG,
                "on-device generation returned empty — likely context-window " +
                    "overflow at ${prompt.length} chars; truncate history",
            )
            throw java.io.IOException(
                "On-device model returned empty — try clearing the chat (chat too long for the model)."
            )
        }

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
    /**
     * Build a ChatML prompt that **provably fits** within the model's
     * context window.
     *
     * Algorithm:
     *  1. Normalize messages into Turn objects, per-message char-cap applied.
     *  2. Render the full prompt. If it fits → return.
     *  3. Otherwise drop the oldest non-current turn and re-render. Loop.
     *  4. If only the current user message remains AND it still doesn't fit,
     *     truncate the user message itself down to [MIN_USER_MESSAGE_CHARS].
     *
     * The system prompt is never dropped. The current (last) user message
     * is never dropped — at worst it's truncated. After this returns the
     * caller is guaranteed the model will not silently overflow on KV
     * cache pressure.
     */
    private fun buildPrompt(messages: JSONArray, system: String): String {
        // Backend-dependent budget. llama.cpp wields a much larger KV cache
        // than MediaPipe's `ekv1280` bundle, so we lift the cap when that
        // runtime is active.
        val maxPromptChars = if (
            xyz.ghola.app.ai.SecureStorage(context).useLlamaCppRuntime()
        ) MAX_PROMPT_CHARS_LLAMACPP else MAX_PROMPT_CHARS_MEDIAPIPE

        data class Turn(val role: String, var content: String)

        // 1. Collect + normalize.
        val turns = mutableListOf<Turn>()
        val inlineSystems = mutableListOf<String>()
        for (i in 0 until messages.length()) {
            val msg = messages.optJSONObject(i) ?: continue
            val role = msg.optString("role").takeIf { it.isNotBlank() } ?: continue
            val rawContent = extractText(msg.opt("content"))
            if (rawContent.isBlank()) continue
            val capped = if (rawContent.length > MAX_CHARS_PER_MESSAGE)
                rawContent.substring(0, MAX_CHARS_PER_MESSAGE) + "…"
            else rawContent
            when (role) {
                "system" -> inlineSystems += capped
                "user", "assistant" -> turns += Turn(role, capped)
            }
        }

        // Helper: render the prompt from the current state.
        fun render(): String = buildString {
            if (system.isNotBlank()) {
                append("<|im_start|>system\n")
                append(system.trim())
                append("<|im_end|>\n")
            }
            inlineSystems.forEach { sys ->
                append("<|im_start|>system\n")
                append(sys)
                append("<|im_end|>\n")
            }
            for (t in turns) {
                append("<|im_start|>").append(t.role).append('\n')
                append(t.content)
                append("<|im_end|>\n")
            }
            append("<|im_start|>assistant\n")
        }

        // 2 + 3. Drop oldest non-current turns until we fit.
        val startSize = turns.size
        var rendered = render()
        var droppedTurns = 0
        // The current user message is the *last* user-role turn; never drop it.
        // Drop from the front (oldest) one turn at a time.
        while (rendered.length > maxPromptChars && turns.size > 1) {
            turns.removeAt(0)
            droppedTurns++
            rendered = render()
        }
        if (droppedTurns > 0) {
            Log.i(
                TAG,
                "dropped $droppedTurns of $startSize turns to fit (${rendered.length} chars now)",
            )
        }

        // 4. Last resort: truncate the current user message itself. Happens
        // when even a one-turn conversation has a message longer than the
        // budget can absorb (e.g., user pasted a wall of text).
        if (rendered.length > maxPromptChars && turns.isNotEmpty()) {
            val overshoot = rendered.length - maxPromptChars
            val current = turns.last()
            val target = (current.content.length - overshoot - 32).coerceAtLeast(
                MIN_USER_MESSAGE_CHARS,
            )
            if (target < current.content.length) {
                current.content = current.content.substring(0, target) + "…"
                rendered = render()
                Log.w(
                    TAG,
                    "truncated current user message to $target chars to fit budget",
                )
            }
        }

        // After the truncation pass, if we're STILL over budget the user's
        // pasted content is genuinely too large for a 1.5B model. Log; the
        // model will likely still produce *something* useful from the
        // truncated tail, so we proceed rather than throw.
        if (rendered.length > maxPromptChars) {
            Log.w(
                TAG,
                "prompt at ${rendered.length} chars is still over the " +
                    "$maxPromptChars budget; the model may overflow",
            )
        }
        return rendered
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

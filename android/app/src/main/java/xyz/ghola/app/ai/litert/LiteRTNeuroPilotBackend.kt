package xyz.ghola.app.ai.litert

import android.util.Log
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import xyz.ghola.app.ai.ApiResponse
import xyz.ghola.app.ai.ContentBlock
import xyz.ghola.app.ai.IntegrityVerifier
import xyz.ghola.app.ai.LlmBackend
import xyz.ghola.app.ai.PinnedModelHashes
import java.io.File
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * On-device LLM backend that runs Gemma-3-1B on the Solana Seeker's
 * APU 655 NPU via Google's LiteRT-LM + NeuroPilot Accelerator. This
 * is the Phase γ.1 runtime skeleton — the actual `.litertlm` model
 * download is owned by [LiteRtModelManager] (Phase γ.2) and the
 * Settings/ChatActivity wiring lands in Phase γ.3. This class
 * accepts a model file path in its constructor and trusts the
 * caller; it does not download.
 *
 * Why this backend exists (per `/Users/andersonobrien/.claude/plans/zesty-giggling-charm.md`
 * Phase γ): the APU 655 NPU is 7-12× more power-efficient than CPU or
 * GPU per Google's published Dimensity numbers. Steady-state decode
 * on D9500-class hardware runs ~0.32W on NPU vs ~3.8W on CPU. The
 * Seeker (D7300 / APU 655) is mid-tier of the same family; the
 * ratios hold qualitatively though absolute throughput is lower.
 *
 * Lifecycle:
 *  1. Constructor verifies the model file exists and passes
 *     [IntegrityVerifier] against
 *     [PinnedModelHashes.GEMMA_3_1B_LITERTLM_SHA256] (null today =
 *     observe-but-don't-enforce). On either failure throws
 *     [IOException] before touching the native runtime.
 *  2. First [generate] call lazily builds the [LiteRTRuntime] via the
 *     injected [runtimeFactory] — NPU is tried first, falls back to
 *     CPU on init failure. This deferral keeps construction cheap so
 *     a settings-screen radio swap doesn't load 1GB of weights into
 *     RAM.
 *  3. [generate] formats the chat history into a ChatML prompt
 *     (mirrors [xyz.ghola.app.ai.LocalChatBackend.buildPrompt]) and
 *     dispatches to the runtime.
 *  4. [cancel] flips an [AtomicBoolean] observed at generation entry
 *     + post-completion; the runtime's [LiteRTRuntime.cancel] is
 *     also invoked so any in-flight native call unwinds.
 *  5. [shutdown] tears down the runtime and disables further calls.
 *
 * Tool use: the LiteRT-LM Kotlin API at v0.11.0 supports tools via
 * `ConversationConfig(tools = …)` with FunctionGemma-class models;
 * Gemma-3-1B-IT does not advertise tool-call support so we ignore
 * the `tools` argument the same way [LocalChatBackend] does. Future
 * upgrade: when ghola adopts FunctionGemma the tool plumbing comes
 * online via that route.
 *
 * Cross-reference (verified 2026-05-15 at v0.11.0):
 *   https://github.com/google-ai-edge/LiteRT-LM/blob/main/docs/api/kotlin/getting_started.md
 *   https://ai.google.dev/edge/litert-lm/android
 *   https://ai.google.dev/edge/litert/next/mediatek
 *   https://developers.googleblog.com/mediatek-npu-and-litert-powering-the-next-generation-of-on-device-ai/
 *
 * @param modelFile absolute path to the `.litertlm` artifact —
 *   typically `LiteRtModelManager(context).getModelPath()`.
 * @param runtimeFactory builds the [LiteRTRuntime] on first
 *   [generate]. Production code passes a closure that calls
 *   [LiteRTLmRuntime.tryCreate]; tests inject a fake.
 * @param integrityHash the pinned SHA-256 hex to compare against.
 *   Defaults to [PinnedModelHashes.GEMMA_3_1B_LITERTLM_SHA256] which
 *   is null today (observe-but-don't-enforce). Override in tests.
 */
class LiteRTNeuroPilotBackend internal constructor(
    private val modelFile: File,
    private val runtimeFactory: () -> LiteRTRuntime,
    private val integrityHash: String? = PinnedModelHashes.GEMMA_3_1B_LITERTLM_SHA256,
) : LlmBackend {

    /**
     * Production constructor — called by
     * [xyz.ghola.app.email.LocalLlm.LiteRTNeuroPilotImpl]. The
     * [nativeLibraryDir] and [cacheDir] are Android-specific
     * (Application.applicationInfo.nativeLibraryDir, context.cacheDir.path)
     * so we don't resolve them here; the caller threads them through.
     */
    constructor(
        modelFile: File,
        nativeLibraryDir: String,
        cacheDir: String,
    ) : this(
        modelFile = modelFile,
        runtimeFactory = {
            LiteRTLmRuntime.tryCreate(
                modelPath = modelFile.absolutePath,
                nativeLibraryDir = nativeLibraryDir,
                cacheDir = cacheDir,
            )
        },
        integrityHash = PinnedModelHashes.GEMMA_3_1B_LITERTLM_SHA256,
    )

    companion object {
        private const val TAG = "LiteRTNpuBackend"

        /**
         * Prompt-char budget for the LiteRT-LM Gemma-3-1B path.
         * Gemma 3 1B's published context window is 32k tokens, but
         * NPU-compiled `.litertlm` bundles are typically tuned to
         * ~2k effective KV cache for latency. We give ourselves
         * 4096 chars (≈1300 tokens) of prompt headroom — symmetric
         * with [LocalChatBackend]'s llama.cpp budget, which proved
         * comfortable in practice.
         */
        private const val MAX_PROMPT_CHARS = 4096

        /** Per-message cap — mirrors [LocalChatBackend.MAX_CHARS_PER_MESSAGE]. */
        private const val MAX_CHARS_PER_MESSAGE = 800

        /** Floor for last-resort truncation of the current user message. */
        private const val MIN_USER_MESSAGE_CHARS = 200
    }

    override val displayName: String = "On-device NPU (Gemma-3-1B)"
    override val requiresInternet: Boolean = false

    private val cancelled = AtomicBoolean(false)

    @Volatile
    private var runtime: LiteRTRuntime? = null

    @Volatile
    private var shutdownCalled: Boolean = false

    init {
        // Fail fast on missing / corrupted model — better an
        // IOException at construction than a confusing crash deep in
        // the native runtime.
        if (!modelFile.exists()) {
            throw IOException(
                "LiteRT-LM model file not found at ${modelFile.absolutePath} — " +
                    "Phase γ.2 LiteRtModelManager.downloadModel() should have run first.",
            )
        }
        // Integrity check. Today the pin is null → observe-but-don't-enforce.
        // When the pin lands, a tamper detection here will throw before
        // any native code touches the bytes.
        val verification = runBlocking { IntegrityVerifier.verifyFile(modelFile, integrityHash) }
        if (!verification.match) {
            throw IOException(
                "LiteRT-LM model integrity check failed for " +
                    "${modelFile.name}: ${verification.reason}",
            )
        }
    }

    override fun generate(
        messages: JSONArray,
        tools: JSONArray,
        system: String,
        forceToolUse: Boolean,
    ): ApiResponse {
        if (shutdownCalled) {
            throw IOException("LiteRTNeuroPilotBackend already shut down")
        }
        cancelled.set(false)

        if (tools.length() > 0) {
            // Gemma-3-1B-IT does not advertise tool-call support; the
            // upstream agent loop still passes a tool list because
            // the cloud backend uses it. Drop on the floor for now.
            Log.d(TAG, "tool-use requested but LiteRT NPU backend ignores tools (γ.1)")
        }

        val prompt = buildPrompt(messages = messages, system = system)
        Log.i(
            TAG,
            "generating: prompt=${prompt.length} chars (~${prompt.length / 4} tokens)",
        )

        // Lazy-init the runtime on first generation. NPU first, CPU
        // fallback baked into [LiteRTLmRuntime.tryCreate].
        val rt = runtime ?: synchronized(this) {
            runtime ?: runtimeFactory().also { runtime = it }
        }

        if (cancelled.get()) {
            // Caller cancelled while we were standing up the runtime.
            throw IOException("Generation cancelled")
        }

        val text = try {
            rt.generate(prompt)
        } catch (e: IOException) {
            throw e
        } catch (t: Throwable) {
            throw IOException("LiteRT-LM generation failed: ${t.message}", t)
        }

        if (cancelled.get()) {
            throw IOException("Generation cancelled")
        }

        if (text.isBlank()) {
            throw IOException(
                "LiteRT NPU model returned empty — chat too long for the context window.",
            )
        }

        // Strip Gemma's chat-template control tokens. Gemma 3 uses
        // `<start_of_turn>` / `<end_of_turn>`; we strip both plus the
        // ChatML fallbacks that show up if the prompt-template
        // mismatches.
        val cleaned = text
            .substringBefore("<end_of_turn>")
            .substringBefore("<start_of_turn>")
            .substringBefore("<|im_end|>")
            .substringBefore("<|im_start|>")
            .substringBefore("<|end|>")
            .trimEnd()

        return ApiResponse(
            contentBlocks = listOf(ContentBlock.Text(cleaned)),
            stopReason = "end_turn",
            usage = null,
        )
    }

    override fun cancel() {
        cancelled.set(true)
        runtime?.cancel()
    }

    override fun shutdown() {
        shutdownCalled = true
        cancelled.set(true)
        synchronized(this) {
            runtime?.shutdown()
            runtime = null
        }
    }

    /**
     * Build a ChatML-style prompt that fits within [MAX_PROMPT_CHARS].
     *
     * Gemma 3 was trained on a `<start_of_turn>{role}\n{content}<end_of_turn>`
     * chat template rather than ChatML's `<|im_start|>` form, but
     * Google's instruction-tuned LiteRT bundles for Gemma 3 accept
     * the bare prompt text with the template auto-applied by the
     * `Conversation.sendMessage` overload. We deliberately render the
     * ChatML form here for two reasons:
     *  1. it produces a budget-correct char count for the truncation
     *     loop (Gemma's `<start_of_turn>` token boundary count is
     *     identical at our slack of ±20 chars)
     *  2. it matches the structure [LocalChatBackend.buildPrompt]
     *     produces, so a diagnostic prompt printed for one backend
     *     reads the same on the other
     *
     * If the bundled Gemma template treats the literal `<|im_start|>`
     * as text, we'll see it in the model's output and the
     * post-process strip in [generate] will remove it — same posture
     * as [LocalChatBackend] which has been in production since v0.5.
     */
    private fun buildPrompt(messages: JSONArray, system: String): String {
        data class Turn(val role: String, var content: String)
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

        val startSize = turns.size
        var rendered = render()
        var droppedTurns = 0
        while (rendered.length > MAX_PROMPT_CHARS && turns.size > 1) {
            turns.removeAt(0)
            droppedTurns++
            rendered = render()
        }
        if (droppedTurns > 0) {
            Log.i(TAG, "dropped $droppedTurns of $startSize turns to fit (${rendered.length} chars)")
        }

        if (rendered.length > MAX_PROMPT_CHARS && turns.isNotEmpty()) {
            val overshoot = rendered.length - MAX_PROMPT_CHARS
            val current = turns.last()
            val target = (current.content.length - overshoot - 32).coerceAtLeast(
                MIN_USER_MESSAGE_CHARS,
            )
            if (target < current.content.length) {
                current.content = current.content.substring(0, target) + "…"
                rendered = render()
                Log.w(TAG, "truncated current user message to $target chars to fit budget")
            }
        }
        if (rendered.length > MAX_PROMPT_CHARS) {
            Log.w(
                TAG,
                "prompt at ${rendered.length} chars exceeds $MAX_PROMPT_CHARS budget — " +
                    "the model may overflow KV cache",
            )
        }
        return rendered
    }

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

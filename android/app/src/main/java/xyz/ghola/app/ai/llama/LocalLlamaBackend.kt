package xyz.ghola.app.ai.llama

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import xyz.ghola.app.ai.ApiResponse
import xyz.ghola.app.ai.ContentBlock
import xyz.ghola.app.ai.LlmBackend
import xyz.ghola.app.ai.Usage
import java.util.UUID
import java.util.regex.Pattern

class LocalLlamaBackend : LlmBackend {

    companion object {
        private const val TAG = "LocalLlama"
        private const val MAX_TOKENS = 4096
        private const val CONTEXT_SIZE = 4096
        // Dimensity 9300 (Seeker): 1 prime + 3 perf + 4 efficiency cores.
        // 6 threads use prime+perf+2 efficiency, leaving 2 efficiency for
        // UI thread + system services. ~30% lower decode latency vs 4.
        private const val NUM_THREADS = 6
        private const val TEMPERATURE = 0.6f
        private const val TOP_P = 0.9f

        private val TOOL_CALL_PATTERN: Pattern = Pattern.compile(
            "<tool_call>\\s*(\\{.*?\\})\\s*</tool_call>",
            Pattern.DOTALL
        )
    }

    private val llama = LlamaCpp()
    private var isLoaded = false

    override val displayName: String = "Qwen3-4B (On-Device)"
    override val requiresInternet: Boolean = false

    fun loadModel(path: String): Boolean {
        Log.i(TAG, "Loading model from $path")
        isLoaded = llama.loadModel(path, CONTEXT_SIZE, NUM_THREADS, TEMPERATURE, TOP_P)
        if (isLoaded) {
            Log.i(TAG, "Model loaded successfully")
        } else {
            Log.e(TAG, "Failed to load model")
        }
        return isLoaded
    }

    fun isModelLoaded(): Boolean = isLoaded

    override fun generate(messages: JSONArray, tools: JSONArray, system: String, forceToolUse: Boolean): ApiResponse {
        if (!isLoaded) {
            throw IllegalStateException("Model not loaded")
        }

        val prompt = Qwen3PromptFormatter.format(messages, tools, system)
        Log.d(TAG, "Prompt token count: ${llama.tokenCount(prompt)}")

        val output = llama.generate(prompt, MAX_TOKENS)
        Log.d(TAG, "Raw output (${output.length} chars): ${output.take(200)}")

        return parseOutput(output)
    }

    override fun cancel() {
        llama.cancel()
    }

    override fun shutdown() {
        llama.release()
        isLoaded = false
    }

    private fun parseOutput(text: String): ApiResponse {
        val contentBlocks = mutableListOf<ContentBlock>()
        val matcher = TOOL_CALL_PATTERN.matcher(text)

        var lastEnd = 0
        var hasToolCalls = false

        while (matcher.find()) {
            hasToolCalls = true

            // Add any text before this tool call
            val textBefore = text.substring(lastEnd, matcher.start()).trim()
            if (textBefore.isNotEmpty()) {
                contentBlocks.add(ContentBlock.Text(textBefore))
            }

            // Parse the tool call JSON
            val jsonStr = matcher.group(1) ?: continue
            try {
                val toolJson = JSONObject(jsonStr)
                val name = toolJson.getString("name")
                val arguments = toolJson.optJSONObject("arguments") ?: JSONObject()
                val id = "toolu_local_${UUID.randomUUID().toString().take(8)}"

                contentBlocks.add(ContentBlock.ToolUse(id, name, arguments))
            } catch (e: Exception) {
                Log.w(TAG, "Failed to parse tool call: $jsonStr", e)
                contentBlocks.add(ContentBlock.Text(matcher.group(0) ?: ""))
            }

            lastEnd = matcher.end()
        }

        // Add any remaining text after last tool call
        val remaining = text.substring(lastEnd).trim()
        if (remaining.isNotEmpty()) {
            contentBlocks.add(ContentBlock.Text(remaining))
        }

        // If no content at all, add empty text
        if (contentBlocks.isEmpty()) {
            contentBlocks.add(ContentBlock.Text(""))
        }

        val stopReason = if (hasToolCalls) "tool_use" else "end_turn"

        return ApiResponse(
            contentBlocks = contentBlocks,
            stopReason = stopReason,
            usage = null
        )
    }
}

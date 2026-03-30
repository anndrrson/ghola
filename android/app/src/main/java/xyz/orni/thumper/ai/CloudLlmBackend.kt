package xyz.orni.thumper.ai

import org.json.JSONArray

class CloudLlmBackend(
    private val apiClient: CloudApiClient,
    override val displayName: String = "Claude (Cloud)"
) : LlmBackend {
    override val requiresInternet: Boolean = true

    override fun generate(messages: JSONArray, tools: JSONArray, system: String, forceToolUse: Boolean): ApiResponse {
        return apiClient.sendMessage(messages, tools, system, forceToolUse)
    }

    override fun cancel() {
        // OkHttp calls are blocking; cancellation is handled by AgentController's isCancelled flag
    }

    override fun shutdown() {
        // No persistent resources to clean up
    }
}

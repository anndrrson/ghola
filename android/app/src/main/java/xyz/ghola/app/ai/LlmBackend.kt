package xyz.ghola.app.ai

import org.json.JSONArray

interface LlmBackend {
    val displayName: String
    val requiresInternet: Boolean

    fun generate(messages: JSONArray, tools: JSONArray, system: String, forceToolUse: Boolean = false): ApiResponse
    fun cancel()
    fun shutdown()
}

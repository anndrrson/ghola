package xyz.orni.thumper.ai

import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class OpenAIApiClient(
    private val apiKey: String,
    private val model: String,
    private val baseUrl: String = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
) : CloudApiClient {

    companion object {
        private const val TAG = "OpenAIApi"
        private const val MAX_TOKENS = 4096
        private val JSON_MEDIA_TYPE = "application/json".toMediaType()
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    override fun sendMessage(messages: JSONArray, tools: JSONArray, system: String, forceToolUse: Boolean): ApiResponse {
        val openAIMessages = convertMessages(messages, system)
        val openAITools = convertTools(tools)
        val body = buildRequestBody(openAIMessages, openAITools, forceToolUse)

        Log.d(TAG, "Request: model=$model, messages=${openAIMessages.length()}, tools=${openAITools.length()}")

        val request = Request.Builder()
            .url("$baseUrl/chat/completions")
            .header("Authorization", "Bearer $apiKey")
            .header("Content-Type", "application/json")
            .post(body.toRequestBody(JSON_MEDIA_TYPE))
            .build()

        val response = client.newCall(request).execute()
        return response.use { resp ->
            if (!resp.isSuccessful) {
                val errorBody = resp.body?.string() ?: "unknown error"
                Log.e(TAG, "API error (${resp.code}): $errorBody")
                throw IOException("API request failed (${resp.code}): $errorBody")
            }
            val json = JSONObject(resp.body!!.string())
            Log.d(TAG, "Response: ${json.optJSONObject("usage")}")
            parseResponse(json)
        }
    }

    /**
     * Converts Claude-format messages to OpenAI-format messages.
     *
     * Claude format:
     * - {role: "user", content: [{type: "text", text: "..."}, {type: "tool_result", tool_use_id: "...", content: "..."}]}
     * - {role: "assistant", content: [{type: "text", text: "..."}, {type: "tool_use", id: "...", name: "...", input: {...}}]}
     *
     * OpenAI format:
     * - {role: "system", content: "..."}
     * - {role: "user", content: "..."}
     * - {role: "assistant", content: "...", tool_calls: [{id: "...", type: "function", function: {name: "...", arguments: "..."}}]}
     * - {role: "tool", tool_call_id: "...", content: "..."}
     */
    private fun convertMessages(claudeMessages: JSONArray, system: String): JSONArray {
        val result = JSONArray()

        // System prompt as first message
        if (system.isNotEmpty()) {
            result.put(JSONObject().apply {
                put("role", "system")
                put("content", system)
            })
        }

        for (i in 0 until claudeMessages.length()) {
            val msg = claudeMessages.getJSONObject(i)
            val role = msg.getString("role")

            when (role) {
                "user" -> convertUserMessage(msg, result)
                "assistant" -> convertAssistantMessage(msg, result)
            }
        }

        return result
    }

    private fun convertUserMessage(msg: JSONObject, result: JSONArray) {
        val content = msg.get("content")

        if (content is String) {
            result.put(JSONObject().apply {
                put("role", "user")
                put("content", content)
            })
            return
        }

        val contentArray = content as JSONArray
        val textParts = StringBuilder()
        val toolResults = mutableListOf<JSONObject>()

        for (j in 0 until contentArray.length()) {
            val block = contentArray.getJSONObject(j)
            when (block.optString("type")) {
                "text" -> textParts.append(block.getString("text"))
                "tool_result" -> {
                    val toolContent = block.opt("content")
                    val contentStr = when (toolContent) {
                        is String -> toolContent
                        is JSONArray -> {
                            // Extract text from content blocks
                            val sb = StringBuilder()
                            for (k in 0 until toolContent.length()) {
                                val sub = toolContent.getJSONObject(k)
                                if (sub.optString("type") == "text") {
                                    sb.append(sub.getString("text"))
                                }
                            }
                            sb.toString()
                        }
                        else -> toolContent?.toString() ?: ""
                    }
                    toolResults.add(JSONObject().apply {
                        put("role", "tool")
                        put("tool_call_id", block.getString("tool_use_id"))
                        put("content", contentStr)
                    })
                }
                "image" -> {
                    // Skip images — OpenAI vision requires different format
                    textParts.append("[image]")
                }
            }
        }

        // Emit tool results first (OpenAI requires them immediately after assistant tool_calls)
        for (tr in toolResults) {
            result.put(tr)
        }

        // Emit text if any
        if (textParts.isNotEmpty()) {
            result.put(JSONObject().apply {
                put("role", "user")
                put("content", textParts.toString())
            })
        }
    }

    private fun convertAssistantMessage(msg: JSONObject, result: JSONArray) {
        val content = msg.get("content")

        if (content is String) {
            result.put(JSONObject().apply {
                put("role", "assistant")
                put("content", content)
            })
            return
        }

        val contentArray = content as JSONArray
        var textContent = ""
        val toolCalls = JSONArray()

        for (j in 0 until contentArray.length()) {
            val block = contentArray.getJSONObject(j)
            when (block.optString("type")) {
                "text" -> textContent = block.getString("text")
                "tool_use" -> {
                    toolCalls.put(JSONObject().apply {
                        put("id", block.getString("id"))
                        put("type", "function")
                        put("function", JSONObject().apply {
                            put("name", block.getString("name"))
                            put("arguments", block.getJSONObject("input").toString())
                        })
                    })
                }
            }
        }

        val assistantMsg = JSONObject().apply {
            put("role", "assistant")
            if (textContent.isNotEmpty()) {
                put("content", textContent)
            } else {
                put("content", JSONObject.NULL)
            }
            if (toolCalls.length() > 0) {
                put("tool_calls", toolCalls)
            }
        }
        result.put(assistantMsg)
    }

    /**
     * Converts Claude-format tools to OpenAI-format tools.
     *
     * Claude: {name: "...", description: "...", input_schema: {...}}
     * OpenAI: {type: "function", function: {name: "...", description: "...", parameters: {...}}}
     */
    private fun convertTools(claudeTools: JSONArray): JSONArray {
        val result = JSONArray()
        for (i in 0 until claudeTools.length()) {
            val tool = claudeTools.getJSONObject(i)
            result.put(JSONObject().apply {
                put("type", "function")
                put("function", JSONObject().apply {
                    put("name", tool.getString("name"))
                    put("description", tool.optString("description", ""))
                    put("parameters", tool.optJSONObject("input_schema") ?: JSONObject())
                })
            })
        }
        return result
    }

    private fun buildRequestBody(messages: JSONArray, tools: JSONArray, forceToolUse: Boolean): String {
        val body = JSONObject().apply {
            put("model", model)
            put("max_tokens", MAX_TOKENS)
            put("messages", messages)
            if (tools.length() > 0) {
                put("tools", tools)
                if (forceToolUse) {
                    put("tool_choice", "required")
                }
            }
        }
        return body.toString()
    }

    /**
     * Parses OpenAI-format response into ApiResponse.
     *
     * OpenAI response:
     * {choices: [{message: {role: "assistant", content: "...", tool_calls: [...]}, finish_reason: "stop"|"tool_calls"}], usage: {...}}
     */
    private fun parseResponse(json: JSONObject): ApiResponse {
        val choices = json.getJSONArray("choices")
        val choice = choices.getJSONObject(0)
        val message = choice.getJSONObject("message")
        val finishReason = choice.optString("finish_reason", "stop")

        val blocks = mutableListOf<ContentBlock>()

        // Text content
        val content = message.optString("content", "")
        if (content.isNotEmpty() && content != "null") {
            blocks.add(ContentBlock.Text(content))
        }

        // Tool calls
        val toolCalls = message.optJSONArray("tool_calls")
        if (toolCalls != null) {
            for (i in 0 until toolCalls.length()) {
                val tc = toolCalls.getJSONObject(i)
                val function = tc.getJSONObject("function")
                val arguments = try {
                    JSONObject(function.getString("arguments"))
                } catch (e: Exception) {
                    JSONObject()
                }
                blocks.add(ContentBlock.ToolUse(
                    id = tc.getString("id"),
                    name = function.getString("name"),
                    input = arguments
                ))
            }
        }

        val stopReason = when (finishReason) {
            "tool_calls" -> "tool_use"
            "stop" -> "end_turn"
            "length" -> "max_tokens"
            else -> finishReason
        }

        val usageObj = json.optJSONObject("usage")
        val usage = usageObj?.let {
            Usage(
                it.optInt("prompt_tokens", 0),
                it.optInt("completion_tokens", 0)
            )
        }

        return ApiResponse(blocks, stopReason, usage)
    }
}

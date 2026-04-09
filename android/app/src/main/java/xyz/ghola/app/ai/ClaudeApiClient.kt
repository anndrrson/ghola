package xyz.ghola.app.ai

import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

sealed class ContentBlock {
    data class Text(val text: String) : ContentBlock()
    data class ToolUse(val id: String, val name: String, val input: JSONObject) : ContentBlock()
    data class Image(val mediaType: String, val base64Data: String) : ContentBlock()
}

data class Usage(val inputTokens: Int, val outputTokens: Int)

data class ApiResponse(
    val contentBlocks: List<ContentBlock>,
    val stopReason: String,
    val usage: Usage?
)

interface StreamListener {
    fun onTextDelta(text: String)
    fun onContentBlockComplete(block: ContentBlock)
    fun onMessageComplete(response: ApiResponse)
    fun onError(error: Throwable)
}

interface CloudApiClient {
    fun sendMessage(messages: JSONArray, tools: JSONArray, system: String, forceToolUse: Boolean = false): ApiResponse
}

class ClaudeApiClient(
    private val apiKey: String,
    private val model: String
) : CloudApiClient {

    companion object {
        private const val TAG = "ClaudeApi"
        private const val API_URL = "https://api.anthropic.com/v1/messages"
        private const val ANTHROPIC_VERSION = "2023-06-01"
        private const val MAX_TOKENS = 4096
        private val JSON_MEDIA_TYPE = "application/json".toMediaType()
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val streamingClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // infinite for SSE
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    override fun sendMessage(messages: JSONArray, tools: JSONArray, system: String, forceToolUse: Boolean): ApiResponse {
        val body = buildRequestBody(messages, tools, system, stream = false, forceToolUse = forceToolUse)
        val request = buildRequest(body)

        val response = client.newCall(request).execute()
        return response.use { resp ->
            if (!resp.isSuccessful) {
                val errorBody = resp.body?.string() ?: "unknown error"
                throw IOException("API request failed (${resp.code}): $errorBody")
            }
            parseResponse(JSONObject(resp.body!!.string()))
        }
    }

    fun sendMessageStreaming(
        messages: JSONArray,
        tools: JSONArray,
        system: String,
        listener: StreamListener
    ): EventSource {
        val body = buildRequestBody(messages, tools, system, stream = true)
        val request = buildRequest(body)

        val factory = EventSources.createFactory(streamingClient)

        val sseListener = object : EventSourceListener() {
            private val contentBlocks = mutableListOf<ContentBlock>()
            private var currentToolId = ""
            private var currentToolName = ""
            private var currentToolInput = StringBuilder()
            private var stopReason = ""
            private var usage: Usage? = null

            override fun onEvent(
                eventSource: EventSource,
                id: String?,
                type: String?,
                data: String
            ) {
                try {
                    val json = JSONObject(data)
                    when (type) {
                        "content_block_start" -> {
                            val block = json.getJSONObject("content_block")
                            when (block.getString("type")) {
                                "tool_use" -> {
                                    currentToolId = block.getString("id")
                                    currentToolName = block.getString("name")
                                    currentToolInput = StringBuilder()
                                }
                            }
                        }
                        "content_block_delta" -> {
                            val delta = json.getJSONObject("delta")
                            when (delta.getString("type")) {
                                "text_delta" -> {
                                    val text = delta.getString("text")
                                    listener.onTextDelta(text)
                                }
                                "input_json_delta" -> {
                                    currentToolInput.append(delta.getString("partial_json"))
                                }
                            }
                        }
                        "content_block_stop" -> {
                            val index = json.getInt("index")
                            // Determine which block completed
                            if (currentToolName.isNotEmpty()) {
                                val inputJson = if (currentToolInput.isNotEmpty()) {
                                    JSONObject(currentToolInput.toString())
                                } else {
                                    JSONObject()
                                }
                                val block = ContentBlock.ToolUse(
                                    currentToolId, currentToolName, inputJson
                                )
                                contentBlocks.add(block)
                                listener.onContentBlockComplete(block)
                                currentToolId = ""
                                currentToolName = ""
                                currentToolInput = StringBuilder()
                            } else if (index < contentBlocks.size) {
                                listener.onContentBlockComplete(contentBlocks[index])
                            }
                        }
                        "message_delta" -> {
                            val delta = json.getJSONObject("delta")
                            stopReason = delta.optString("stop_reason", "")
                            val usageObj = json.optJSONObject("usage")
                            if (usageObj != null) {
                                usage = Usage(
                                    usageObj.optInt("input_tokens", 0),
                                    usageObj.optInt("output_tokens", 0)
                                )
                            }
                        }
                        "message_stop" -> {
                            listener.onMessageComplete(
                                ApiResponse(contentBlocks.toList(), stopReason, usage)
                            )
                        }
                        "error" -> {
                            val error = json.optJSONObject("error")
                            val message = error?.optString("message") ?: "Unknown streaming error"
                            listener.onError(IOException(message))
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error processing SSE event: $type", e)
                    listener.onError(e)
                }
            }

            override fun onFailure(
                eventSource: EventSource,
                t: Throwable?,
                response: Response?
            ) {
                val error = t ?: IOException(
                    "Stream failed: ${response?.code} ${response?.body?.string() ?: ""}"
                )
                Log.e(TAG, "SSE stream failure", error)
                listener.onError(error)
            }
        }

        return factory.newEventSource(request, sseListener)
    }

    private fun buildRequestBody(
        messages: JSONArray,
        tools: JSONArray,
        system: String,
        stream: Boolean,
        forceToolUse: Boolean = false
    ): String {
        val body = JSONObject().apply {
            put("model", model)
            put("max_tokens", MAX_TOKENS)
            put("system", system)
            put("messages", messages)
            if (tools.length() > 0) {
                put("tools", tools)
                if (forceToolUse) {
                    put("tool_choice", JSONObject().put("type", "any"))
                }
            }
            if (stream) {
                put("stream", true)
            }
        }
        return body.toString()
    }

    private fun buildRequest(body: String): Request {
        return Request.Builder()
            .url(API_URL)
            .header("x-api-key", apiKey)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .post(body.toRequestBody(JSON_MEDIA_TYPE))
            .build()
    }

    private fun parseResponse(json: JSONObject): ApiResponse {
        val contentArray = json.getJSONArray("content")
        val blocks = mutableListOf<ContentBlock>()

        for (i in 0 until contentArray.length()) {
            val block = contentArray.getJSONObject(i)
            when (block.getString("type")) {
                "text" -> {
                    blocks.add(ContentBlock.Text(block.getString("text")))
                }
                "tool_use" -> {
                    blocks.add(
                        ContentBlock.ToolUse(
                            id = block.getString("id"),
                            name = block.getString("name"),
                            input = block.getJSONObject("input")
                        )
                    )
                }
                "image" -> {
                    val source = block.getJSONObject("source")
                    blocks.add(
                        ContentBlock.Image(
                            mediaType = source.getString("media_type"),
                            base64Data = source.getString("data")
                        )
                    )
                }
            }
        }

        val stopReason = json.optString("stop_reason", "end_turn")
        val usageObj = json.optJSONObject("usage")
        val usage = usageObj?.let {
            Usage(it.optInt("input_tokens", 0), it.optInt("output_tokens", 0))
        }

        return ApiResponse(blocks, stopReason, usage)
    }
}

package xyz.ghola.app.ai

import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

interface AgentListener {
    fun onAssistantText(text: String, isFinal: Boolean)
    fun onToolCallStart(name: String, input: JSONObject)
    fun onToolCallComplete(name: String, summary: String)
    fun onScreenshot(base64: String)
    fun onError(message: String)
    fun onConversationComplete()
    fun onThinking()
}

class AgentController(
    private val backend: LlmBackend,
    private val toolExecutor: LocalToolExecutor,
    private val listener: AgentListener,
    private val walletPackage: String? = null,
    private val isSeeker: Boolean = false,
    private val hasCloudAuth: Boolean = false,
    /**
     * Phase M7: the cryptographically-owned agent the user is currently
     * operating as. When set, the system prompt tells the LLM it's acting
     * as this agent, and downstream task creation can stamp the agent_id
     * so thumper-cloud attributes work to the agent's history.
     * Null = legacy user-only mode (no owned agent selected).
     */
    private val agentId: String? = null,
    private val agentDisplayName: String? = null,
    private val agentDid: String? = null
) {

    companion object {
        private const val TAG = "AgentCtrl"
        private const val MAX_HISTORY = 40
        private const val KEEP_RECENT = 30
        private const val MAX_TOOL_LOOPS = 20
    }

    private val conversationHistory = mutableListOf<JSONObject>()
    private val recentToolCalls = mutableListOf<Pair<String, String>>() // (toolName, inputStr)
    private var consecutiveErrors = 0
    private val isProcessing = AtomicBoolean(false)
    private val isCancelled = AtomicBoolean(false)
    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    fun sendMessage(userText: String) {
        if (!isProcessing.compareAndSet(false, true)) {
            mainHandler.post { listener.onError("Already processing a message") }
            return
        }
        isCancelled.set(false)
        recentToolCalls.clear()
        consecutiveErrors = 0

        // Fast-path: intercept obvious commands before hitting the LLM
        val fastMatch = FastPathMatcher.match(userText, walletPackage)
        if (fastMatch != null) {
            conversationHistory.add(JSONObject().apply {
                put("role", "user")
                put("content", userText)
            })
            executor.submit {
                try {
                    executeFastPath(fastMatch)
                } catch (e: Exception) {
                    Log.e(TAG, "Fast-path error", e)
                    mainHandler.post { listener.onError(e.message ?: "Error") }
                } finally {
                    isProcessing.set(false)
                    mainHandler.post { listener.onConversationComplete() }
                }
            }
            return
        }

        // Normal LLM path
        val userMessage = JSONObject().apply {
            put("role", "user")
            put("content", userText)
        }
        conversationHistory.add(userMessage)

        executor.submit {
            try {
                runConversationLoop()
            } catch (e: Exception) {
                Log.e(TAG, "Conversation loop error", e)
                mainHandler.post { listener.onError(e.message ?: "Unknown error") }
            } finally {
                isProcessing.set(false)
                mainHandler.post { listener.onConversationComplete() }
            }
        }
    }

    fun matchFastPath(text: String): FastMatch? = FastPathMatcher.match(text, walletPackage)

    fun clearHistory() {
        conversationHistory.clear()
    }

    fun cancel() {
        isCancelled.set(true)
        backend.cancel()
    }

    fun shutdown() {
        isCancelled.set(true)
        backend.shutdown()
        executor.shutdownNow()
    }

    private fun executeFastPath(match: FastMatch) {
        mainHandler.post { listener.onToolCallStart(match.toolName, match.input) }

        val result = toolExecutor.execute(match.toolName, match.input)

        val summary = if (result.success) "${match.toolName} done" else "failed"
        mainHandler.post { listener.onToolCallComplete(match.toolName, summary) }

        // launch_app failure: fall through to LLM so it can call list_apps
        if (!result.success && match.toolName == "launch_app") {
            mainHandler.post { listener.onToolCallComplete(match.toolName, "not found, searching...") }
            // Add failed attempt to history so LLM has context
            val toolId = "fast_${System.currentTimeMillis()}"
            conversationHistory.add(JSONObject().apply {
                put("role", "assistant")
                put("content", JSONArray().put(JSONObject().apply {
                    put("type", "tool_use")
                    put("id", toolId)
                    put("name", match.toolName)
                    put("input", match.input)
                }))
            })
            val failText = result.content.filterIsInstance<ContentBlock.Text>()
                .firstOrNull()?.text ?: "failed"
            val directive = "FAILED: $failText\n\n" +
                "Your NEXT tool call MUST be list_apps. Do NOT call read_screen. " +
                "Do NOT tap anything on the current screen. " +
                "Call list_apps, find a package matching the user's request, then call launch_app with it."
            conversationHistory.add(JSONObject().apply {
                put("role", "user")
                put("content", JSONArray().put(JSONObject().apply {
                    put("type", "tool_result")
                    put("tool_use_id", toolId)
                    put("is_error", true)
                    put("content", directive)
                }))
            })
            // Fall through to LLM
            mainHandler.post { listener.onThinking() }
            runConversationLoop()
            return
        }

        // Show screenshots inline
        for (block in result.content) {
            if (block is ContentBlock.Image) {
                mainHandler.post { listener.onScreenshot(block.base64Data) }
            }
        }

        // Show feedback to the user
        val textContent = result.content.filterIsInstance<ContentBlock.Text>()
            .firstOrNull()?.text
        if (match.toolName in listOf("read_screen", "smart_read")) {
            if (textContent != null) {
                mainHandler.post { listener.onAssistantText(textContent, true) }
            }
        } else {
            // Action tools: show short human-readable confirmation
            val confirmation = when {
                !result.success -> textContent?.take(100) ?: "Action failed."
                match.toolName == "launch_app" -> {
                    val appLabel = match.description.removePrefix("Opening ").removeSuffix("...")
                    "Opened $appLabel."
                }
                match.toolName == "press_back" -> "Done."
                match.toolName == "scroll" -> "Scrolled ${match.input.optString("direction", "")}."
                match.toolName == "swipe" -> "Swiped ${match.input.optString("direction", "")}."
                match.toolName == "tap" -> "Tapped."
                else -> "Done."
            }
            mainHandler.post { listener.onAssistantText(confirmation, true) }
        }

        // Add synthetic assistant→tool_use + user→tool_result to history
        // so the LLM has context if the user follows up
        val toolId = "fast_${System.currentTimeMillis()}"
        conversationHistory.add(JSONObject().apply {
            put("role", "assistant")
            put("content", JSONArray().put(JSONObject().apply {
                put("type", "tool_use")
                put("id", toolId)
                put("name", match.toolName)
                put("input", match.input)
            }))
        })
        conversationHistory.add(JSONObject().apply {
            put("role", "user")
            put("content", JSONArray().put(JSONObject().apply {
                put("type", "tool_result")
                put("tool_use_id", toolId)
                put("content", textContent ?: "done")
            }))
        })
    }

    private fun runConversationLoop() {
        var loopCount = 0

        while (!isCancelled.get() && loopCount < MAX_TOOL_LOOPS) {
            loopCount++
            pruneHistory()

            val messages = JSONArray(conversationHistory.map { it.toString() }.map { JSONObject(it) })

            mainHandler.post { listener.onThinking() }

            // Use non-streaming for simplicity in the agentic loop
            // Streaming is used only for the final text response
            val response: ApiResponse

            try {
                response = backend.generate(
                    messages,
                    ToolDefinitions.getTools(),
                    SystemPrompt.get(walletPackage, isSeeker, hasCloudAuth, agentDisplayName, agentDid),
                    false
                )
            } catch (e: Exception) {
                Log.e(TAG, "API call failed", e)
                mainHandler.post { listener.onError("API error: ${e.message}") }
                return
            }

            if (isCancelled.get()) return

            // Build assistant message for history
            val assistantContent = JSONArray()
            val textParts = StringBuilder()

            for (block in response.contentBlocks) {
                when (block) {
                    is ContentBlock.Text -> {
                        textParts.append(block.text)
                        assistantContent.put(JSONObject().apply {
                            put("type", "text")
                            put("text", block.text)
                        })
                    }
                    is ContentBlock.ToolUse -> {
                        assistantContent.put(JSONObject().apply {
                            put("type", "tool_use")
                            put("id", block.id)
                            put("name", block.name)
                            put("input", block.input)
                        })
                    }
                    is ContentBlock.Image -> {
                        // Images from assistant are unusual but handle gracefully
                        assistantContent.put(JSONObject().apply {
                            put("type", "text")
                            put("text", "[image]")
                        })
                    }
                }
            }

            // Add assistant message to history
            conversationHistory.add(JSONObject().apply {
                put("role", "assistant")
                put("content", assistantContent)
            })

            // Emit any text to the UI (strip <think> tags from reasoning models)
            if (textParts.isNotEmpty()) {
                val text = stripThinkTags(textParts.toString())
                if (text.isNotEmpty()) {
                    mainHandler.post { listener.onAssistantText(text, response.stopReason == "end_turn") }
                }
            }

            // Check stop reason
            if (response.stopReason == "end_turn") {
                return
            }

            if (response.stopReason == "tool_use") {
                // Execute each tool_use block
                val toolResults = JSONArray()

                for (block in response.contentBlocks) {
                    if (block is ContentBlock.ToolUse) {
                        if (isCancelled.get()) return

                        // Repeat-detection guardrail
                        val callKey = Pair(block.name, block.input.toString())
                        val repeatCount = recentToolCalls.count { it == callKey }
                        recentToolCalls.add(callKey)
                        if (recentToolCalls.size > 10) recentToolCalls.removeAt(0)

                        val maxRepeats = if (block.name == "launch_app") 1 else 2
                        if (repeatCount >= maxRepeats) {
                            Log.w(TAG, "Repeat detected: ${block.name} called ${repeatCount + 1} times with same params")
                            mainHandler.post { listener.onToolCallStart(block.name, block.input) }
                            mainHandler.post { listener.onToolCallComplete(block.name, "blocked: repeated") }
                            toolResults.put(JSONObject().apply {
                                put("type", "tool_result")
                                put("tool_use_id", block.id)
                                put("content", "ERROR: You already called ${block.name} with these parameters. The action already succeeded. STOP calling tools and respond with a text summary.")
                            })
                            continue
                        }

                        mainHandler.post { listener.onToolCallStart(block.name, block.input) }

                        val result = toolExecutor.execute(block.name, block.input)

                        // Track consecutive errors for circuit breaker
                        if (result.success) {
                            consecutiveErrors = 0
                        } else {
                            consecutiveErrors++
                        }

                        // Soft circuit breaker: override response to tell LLM to stop
                        if (consecutiveErrors >= 3) {
                            val errorText = result.content
                                .filterIsInstance<ContentBlock.Text>()
                                .firstOrNull()?.text?.take(120) ?: "failed"
                            mainHandler.post { listener.onToolCallComplete(block.name, "circuit breaker") }
                            toolResults.put(JSONObject().apply {
                                put("type", "tool_result")
                                put("tool_use_id", block.id)
                                put("is_error", true)
                                put("content", "CIRCUIT BREAKER: $consecutiveErrors consecutive tool calls have FAILED. " +
                                    "Last error: $errorText. " +
                                    "STOP calling tools immediately. Respond with text explaining what went wrong.")
                            })
                            continue
                        }

                        val summary = if (result.success) {
                            "${block.name} done"
                        } else {
                            val errorText = result.content
                                .filterIsInstance<ContentBlock.Text>()
                                .firstOrNull()?.text?.take(80) ?: "failed"
                            "${block.name}: $errorText"
                        }
                        mainHandler.post { listener.onToolCallComplete(block.name, summary) }

                        // Check for screenshots to show inline
                        for (content in result.content) {
                            if (content is ContentBlock.Image) {
                                mainHandler.post { listener.onScreenshot(content.base64Data) }
                            }
                        }

                        // Build tool_result content
                        val resultContent = buildToolResultContent(result)

                        toolResults.put(JSONObject().apply {
                            put("type", "tool_result")
                            put("tool_use_id", block.id)
                            put("content", resultContent)
                        })
                    }
                }

                // Add tool results as user message
                conversationHistory.add(JSONObject().apply {
                    put("role", "user")
                    put("content", toolResults)
                })

                // Early exit: if the LLM made exactly 1 tool call, it was a
                // terminal action, and it succeeded → skip the next API round-trip.
                val toolUseBlocks = response.contentBlocks.filterIsInstance<ContentBlock.ToolUse>()
                if (toolUseBlocks.size == 1 && consecutiveErrors == 0) {
                    val block = toolUseBlocks[0]
                    val earlyResponse = generateEarlyExitResponse(block.name, block.input)
                    if (earlyResponse != null) {
                        Log.d(TAG, "Early exit for ${block.name}: $earlyResponse")
                        mainHandler.post { listener.onAssistantText(earlyResponse, true) }
                        // Add synthetic assistant text to history
                        conversationHistory.add(JSONObject().apply {
                            put("role", "assistant")
                            put("content", earlyResponse)
                        })
                        return
                    }
                }

                // Hard circuit breaker: abort loop entirely
                if (consecutiveErrors >= 5) {
                    mainHandler.post { listener.onError("Stopped after $consecutiveErrors consecutive tool errors.") }
                    return
                }
            } else {
                // Unknown stop reason, treat as done
                return
            }
        }

        if (loopCount >= MAX_TOOL_LOOPS) {
            mainHandler.post { listener.onError("Reached maximum tool execution limit ($MAX_TOOL_LOOPS loops)") }
        }
    }

    private val TERMINAL_ACTIONS = setOf(
        "launch_app", "press_back", "tap", "type_text", "swipe",
        "scroll", "long_press", "global_action", "clipboard_set",
        "dismiss_notification"
    )

    private fun generateEarlyExitResponse(toolName: String, input: JSONObject): String? {
        if (toolName !in TERMINAL_ACTIONS) return null
        return when (toolName) {
            "launch_app" -> {
                val pkg = input.optString("package", "")
                "Opened $pkg."
            }
            "tap" -> "Tapped."
            "type_text" -> "Typed."
            "press_back", "global_action", "scroll", "swipe" -> "Done."
            "long_press" -> "Done."
            "clipboard_set" -> "Copied."
            "dismiss_notification" -> "Dismissed."
            else -> null
        }
    }

    private fun buildToolResultContent(result: ToolResult): Any {
        // If there's only text content, return as string
        if (result.content.size == 1 && result.content[0] is ContentBlock.Text) {
            return (result.content[0] as ContentBlock.Text).text
        }

        // For mixed content (text + images), return as array
        val contentArray = JSONArray()
        for (block in result.content) {
            when (block) {
                is ContentBlock.Text -> {
                    contentArray.put(JSONObject().apply {
                        put("type", "text")
                        put("text", block.text)
                    })
                }
                is ContentBlock.Image -> {
                    contentArray.put(JSONObject().apply {
                        put("type", "image")
                        put("source", JSONObject().apply {
                            put("type", "base64")
                            put("media_type", block.mediaType)
                            put("data", block.base64Data)
                        })
                    })
                }
                is ContentBlock.ToolUse -> {
                    // Shouldn't happen in tool results
                    contentArray.put(JSONObject().apply {
                        put("type", "text")
                        put("text", block.name)
                    })
                }
            }
        }
        return contentArray
    }

    private fun stripThinkTags(text: String): String {
        return text.replace(Regex("<think>[\\s\\S]*?</think>", RegexOption.IGNORE_CASE), "").trim()
    }

    private fun pruneHistory() {
        if (conversationHistory.size > MAX_HISTORY) {
            val keep = conversationHistory.takeLast(KEEP_RECENT)
            conversationHistory.clear()
            conversationHistory.addAll(keep)
        }
    }
}

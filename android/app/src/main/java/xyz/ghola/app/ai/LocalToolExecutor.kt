package xyz.ghola.app.ai

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import xyz.ghola.app.network.CommandHandler
import xyz.ghola.app.service.ThumperAccessibilityService
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

data class ToolResult(
    val success: Boolean,
    val content: List<ContentBlock>
)

data class ActionRecord(
    val timestamp: Long,
    val toolName: String,
    val input: JSONObject,
    val success: Boolean,
    val durationMs: Long,
    val summary: String
)

/**
 * Bridges Claude's tool_use blocks to CommandHandler, converting tool names
 * and parameter formats between the Claude API and the relay protocol.
 */
class LocalToolExecutor(
    private val commandHandler: CommandHandler,
    private val hostPackage: String? = null
) {

    companion object {
        private const val TAG = "LocalToolExec"
        private const val MAX_HISTORY = 100
        private const val COMMAND_TIMEOUT_SECONDS = 30L
        private const val DEFAULT_SCREEN_WIDTH = 1080
        private const val DEFAULT_SCREEN_HEIGHT = 2400
    }

    private val history = mutableListOf<ActionRecord>()

    private val toolToMessageType = mapOf(
        "read_screen" to "ReadScreen",
        "tap" to "Tap",
        "type_text" to "TypeText",
        "launch_app" to "LaunchApp",
        "press_back" to "PressBack",
        "swipe" to "Swipe",
        "screenshot" to "TakeScreenshot",
        "long_press" to "LongPress",
        "scroll" to "Scroll",
        "global_action" to "GlobalAction",
        "clipboard_set" to "SetClipboard",
        "clipboard_get" to "GetClipboard",
        "device_info" to "GetDeviceInfo",
        "list_apps" to "ListInstalledApps",
        "wait_for" to "WaitFor",
        "execute_flow" to "ExecuteFlow",
        "read_notifications" to "ReadNotifications",
        "dismiss_notification" to "DismissNotification"
    )

    fun execute(toolName: String, input: JSONObject): ToolResult {
        // Self-launch guard: prevent the AI from launching its own host app
        if (toolName == "launch_app" && hostPackage != null) {
            val pkg = input.optString("package", "")
            if (pkg.isNotEmpty() && pkg == hostPackage) {
                return ToolResult(false, listOf(ContentBlock.Text(
                    "ERROR: You are already running inside $pkg. You cannot launch your own app. " +
                    "Use read_screen to see the current screen, or launch a DIFFERENT app."
                )))
            }
        }

        val startTime = System.currentTimeMillis()
        val result = try {
            when (toolName) {
                "history" -> executeHistory(input)
                "list_flows" -> executeListFlows()
                "smart_read" -> executeSmartRead(input)
                "swipe" -> executeSwipe(input)
                else -> executeViaCommandHandler(toolName, input)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Tool execution failed: $toolName", e)
            ToolResult(false, listOf(ContentBlock.Text("Error: ${e.message}")))
        }
        val durationMs = System.currentTimeMillis() - startTime

        val summary = if (result.success) "ok" else {
            result.content.filterIsInstance<ContentBlock.Text>()
                .firstOrNull()?.text?.take(80) ?: "failed"
        }
        recordAction(toolName, input, result.success, durationMs, summary)

        return result
    }

    private fun validToolNames(): List<String> {
        return toolToMessageType.keys.toList() + listOf("history", "list_flows", "smart_read")
    }

    private fun validateRequiredParams(toolName: String, input: JSONObject) {
        val missing = when (toolName) {
            "launch_app" -> if (!input.has("package")) "package" else null
            "type_text" -> if (!input.has("text")) "text" else null
            "scroll" -> if (!input.has("direction")) "direction" else null
            "global_action" -> if (!input.has("action")) "action" else null
            "clipboard_set" -> if (!input.has("text")) "text" else null
            else -> null
        }
        if (missing != null) {
            throw IllegalArgumentException(
                "Missing required parameter '$missing' for '$toolName'. " +
                if (toolName == "launch_app") "Call list_apps first to find the package name."
                else "Check the tool definition for required parameters."
            )
        }
    }

    private fun executeViaCommandHandler(toolName: String, input: JSONObject): ToolResult {
        val messageType = toolToMessageType[toolName]
            ?: return ToolResult(false, listOf(ContentBlock.Text(
                "Unknown tool: '$toolName'. This tool does not exist. " +
                "Available tools: ${validToolNames().joinToString(", ")}. " +
                "Do NOT invent tool names."
            )))

        val data = buildCommandData(toolName, input)
        val envelope = buildEnvelope(messageType, data)

        val responseJson = sendCommand(envelope.toString())
        val message = JSONObject(responseJson).getJSONObject("message")
        val type = message.getString("type")

        if (type == "Error") {
            val errorData = message.getJSONObject("data")
            return ToolResult(
                false,
                listOf(ContentBlock.Text(errorData.optString("message", "Unknown error")))
            )
        }

        // Screenshot returns image content
        if (toolName == "screenshot" && type == "ScreenshotResult") {
            val ssData = message.getJSONObject("data")
            val blocks = mutableListOf<ContentBlock>()
            blocks.add(ContentBlock.Image(
                ssData.getString("mime_type"),
                ssData.getString("image_base64")
            ))
            return ToolResult(true, blocks)
        }

        // All other results return as text JSON
        val resultData = message.optJSONObject("data") ?: message

        // launch_app: verify the requested package actually came to foreground
        if (toolName == "launch_app") {
            val pkg = input.optString("package", "")
            val screenAfter = resultData.optJSONObject("screen_after")
            val focusedPkg = screenAfter?.optString("package", "") ?: ""
            if (pkg.isNotEmpty() && focusedPkg.isNotEmpty() && focusedPkg != pkg) {
                return ToolResult(false, listOf(ContentBlock.Text(summarizeResult(toolName, input, resultData))))
            }
        }

        return ToolResult(true, listOf(ContentBlock.Text(summarizeResult(toolName, input, resultData))))
    }

    private fun buildCommandData(toolName: String, input: JSONObject): JSONObject? {
        validateRequiredParams(toolName, input)
        return when (toolName) {
            "read_screen", "press_back", "clipboard_get",
            "device_info", "list_apps" -> null

            "tap" -> input // selector fields are top-level

            "type_text" -> JSONObject().apply {
                put("selector", input.getJSONObject("selector"))
                put("text", input.getString("text"))
            }

            "launch_app" -> JSONObject().apply {
                put("package", input.getString("package"))
            }

            "screenshot" -> JSONObject().apply {
                if (input.has("scale")) put("scale", input.getDouble("scale"))
                if (input.has("quality")) put("quality", input.getInt("quality"))
            }

            "long_press" -> JSONObject().apply {
                put("selector", input.getJSONObject("selector"))
                if (input.has("duration_ms")) put("duration_ms", input.getLong("duration_ms"))
            }

            "scroll" -> JSONObject().apply {
                put("direction", input.getString("direction"))
                if (input.has("selector")) put("selector", input.getJSONObject("selector"))
            }

            "global_action" -> JSONObject().apply {
                put("action", input.getString("action"))
            }

            "clipboard_set" -> JSONObject().apply {
                put("text", input.getString("text"))
            }

            "wait_for" -> JSONObject().apply {
                put("selector", input.getJSONObject("selector"))
                if (input.has("timeout_ms")) put("timeout_ms", input.getLong("timeout_ms"))
            }

            "execute_flow" -> JSONObject().apply {
                put("flow", input.getJSONObject("flow"))
                if (input.has("params")) put("params", input.getJSONObject("params"))
            }

            "read_notifications" -> if (input.has("limit")) {
                JSONObject().put("limit", input.getInt("limit"))
            } else null

            "dismiss_notification" -> JSONObject().apply {
                put("key", input.getString("key"))
            }

            else -> input
        }
    }

    private fun executeSwipe(input: JSONObject): ToolResult {
        val direction = input.getString("direction")
        val distanceStr = input.optString("distance", "medium")

        val (screenW, screenH) = getScreenSize()
        val cx = screenW / 2
        val cy = screenH / 2

        val distancePx = when (distanceStr) {
            "small" -> (screenH * 0.15).toInt()
            "large" -> (screenH * 0.5).toInt()
            else -> (screenH * 0.3).toInt() // medium
        }
        val half = distancePx / 2

        val (fromX, fromY, toX, toY) = when (direction) {
            "up" -> listOf(cx, cy + half, cx, cy - half)
            "down" -> listOf(cx, cy - half, cx, cy + half)
            "left" -> listOf(cx + half, cy, cx - half, cy)
            "right" -> listOf(cx - half, cy, cx + half, cy)
            else -> return ToolResult(
                false,
                listOf(ContentBlock.Text("Invalid swipe direction: $direction"))
            )
        }

        val data = JSONObject().apply {
            put("from", JSONArray().put(fromX).put(fromY))
            put("to", JSONArray().put(toX).put(toY))
            put("duration_ms", 300)
        }

        val envelope = buildEnvelope("Swipe", data)
        val responseJson = sendCommand(envelope.toString())
        val message = JSONObject(responseJson).getJSONObject("message")
        val resultData = message.optJSONObject("data") ?: message
        val success = resultData.optBoolean("success", true)
        return ToolResult(success, listOf(ContentBlock.Text(summarizeResult("swipe", input, resultData))))
    }

    private fun executeSmartRead(input: JSONObject): ToolResult {
        // First, read the screen
        val readEnvelope = buildEnvelope("ReadScreen", null)
        val readResponseJson = sendCommand(readEnvelope.toString())
        val readMessage = JSONObject(readResponseJson).getJSONObject("message")
        val screenData = readMessage.optJSONObject("data") ?: readMessage

        val nodes = screenData.optJSONArray("nodes")
        val nodeCount = nodes?.length() ?: 0

        val blocks = mutableListOf<ContentBlock>()
        blocks.add(ContentBlock.Text(screenData.toString(2)))

        // If fewer than 5 nodes, also take a screenshot
        if (nodeCount < 5) {
            val ssData = JSONObject().apply {
                put("scale", 0.75)
                put("quality", 70)
            }
            val ssEnvelope = buildEnvelope("TakeScreenshot", ssData)
            val ssResponseJson = sendCommand(ssEnvelope.toString())
            val ssMessage = JSONObject(ssResponseJson).getJSONObject("message")

            if (ssMessage.getString("type") == "ScreenshotResult") {
                val ssResult = ssMessage.getJSONObject("data")
                blocks.add(ContentBlock.Image(
                    ssResult.getString("mime_type"),
                    ssResult.getString("image_base64")
                ))
            }
        }

        return ToolResult(true, blocks)
    }

    private fun executeHistory(input: JSONObject): ToolResult {
        val limit = input.optInt("limit", 20).coerceIn(1, MAX_HISTORY)
        val recent = synchronized(history) {
            history.takeLast(limit)
        }

        val arr = JSONArray()
        for (record in recent) {
            arr.put(JSONObject().apply {
                put("timestamp", record.timestamp)
                put("tool", record.toolName)
                put("input", record.input)
                put("success", record.success)
                put("duration_ms", record.durationMs)
                put("summary", record.summary)
            })
        }

        return ToolResult(true, listOf(ContentBlock.Text(arr.toString(2))))
    }

    private fun executeListFlows(): ToolResult {
        // No server-side flows in standalone mode
        return ToolResult(true, listOf(ContentBlock.Text("[]")))
    }

    private val SKIP_WAIT_TYPES = setOf(
        "Tap", "TypeText", "PressBack", "Swipe", "LongPress",
        "Scroll", "GlobalAction", "SetClipboard"
    )

    private fun buildEnvelope(messageType: String, data: JSONObject?): JSONObject {
        val message = JSONObject().apply {
            put("type", messageType)
            if (data != null) put("data", data)
            if (messageType in SKIP_WAIT_TYPES) put("skip_wait", true)
        }
        return JSONObject().apply {
            put("id", "local-${UUID.randomUUID()}")
            put("timestamp", System.currentTimeMillis())
            put("message", message)
        }
    }

    private fun sendCommand(envelopeJson: String): String {
        val latch = CountDownLatch(1)
        var response = ""

        commandHandler.handleCommand(envelopeJson) { result ->
            response = result
            latch.countDown()
        }

        if (!latch.await(COMMAND_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            throw RuntimeException("Command timed out after ${COMMAND_TIMEOUT_SECONDS}s")
        }

        return response
    }

    private fun getScreenSize(): Pair<Int, Int> {
        return ThumperAccessibilityService.instance?.getScreenSize()
            ?: Pair(DEFAULT_SCREEN_WIDTH, DEFAULT_SCREEN_HEIGHT)
    }

    private fun summarizeResult(toolName: String, input: JSONObject, data: JSONObject): String {
        val screenAfter = data.optJSONObject("screen_after")
        val hasScreen = screenAfter != null

        return when (toolName) {
            "launch_app" -> {
                val pkg = input.optString("package", "unknown")
                val focusedPkg = screenAfter?.optString("package", "") ?: ""
                if (focusedPkg == pkg) {
                    "OK. $pkg is now in the foreground."
                } else if (focusedPkg.isNotEmpty()) {
                    "FAILED to launch $pkg — package not found or not installed. " +
                    "Device is still showing $focusedPkg. " +
                    "Call list_apps to search for the correct package name."
                } else {
                    "FAILED to launch $pkg. Call list_apps to find the correct package name."
                }
            }
            "tap" -> {
                val success = data.optBoolean("success", false)
                val target = input.optString("text",
                    input.optString("text_contains",
                        input.optString("desc", "element")))
                if (!success) "FAILED. Could not find \"$target\"." + if (hasScreen) " Screen:\n${compactScreen(data)}" else ""
                else "OK. Tapped \"$target\"." + if (hasScreen) " Screen now:\n${compactScreen(data)}" else ""
            }
            "type_text" -> {
                val success = data.optBoolean("success", false)
                if (!success) "FAILED to type text." + if (hasScreen) " Screen:\n${compactScreen(data)}" else ""
                else "OK. Text entered."
            }
            "scroll" -> {
                val dir = input.optString("direction", "down")
                "OK. Scrolled $dir." + if (hasScreen) " Screen now:\n${compactScreen(data)}" else ""
            }
            "swipe" -> {
                val dir = input.optString("direction", "")
                "OK. Swiped $dir."
            }
            "press_back" -> "OK. Pressed back."
            "long_press" -> {
                val selector = input.optJSONObject("selector")
                val target = selector?.let {
                    it.optString("text", "").ifEmpty {
                        it.optString("text_contains", "").ifEmpty {
                            it.optString("desc", "element")
                        }
                    }
                } ?: "element"
                "OK. Long pressed \"$target\"."
            }
            "global_action" -> {
                val action = input.optString("action", "")
                "OK. Performed $action."
            }
            "clipboard_set" -> "OK. Clipboard set."
            "dismiss_notification" -> "OK. Notification dismissed."
            // Info/read tools — return full data as before
            else -> data.toString(2)
        }
    }

    private fun compactScreen(data: JSONObject): String {
        val screenAfter = data.optJSONObject("screen_after") ?: data
        val nodes = screenAfter.optJSONArray("nodes") ?: return "(no screen data)"
        val sb = StringBuilder()
        for (i in 0 until nodes.length()) {
            val node = nodes.optJSONObject(i) ?: continue
            val text = node.optString("text", "").trim()
            val desc = node.optString("desc", "").trim()
            val clickable = node.optBoolean("clickable", false)
            val label = text.ifEmpty { desc }
            if (label.isNotEmpty()) {
                val marker = if (clickable) " [*]" else ""
                sb.appendLine("- $label$marker")
            }
        }
        if (sb.isEmpty()) return "(screen has no text elements)"
        return sb.toString().trim()
    }

    private fun recordAction(
        toolName: String,
        input: JSONObject,
        success: Boolean,
        durationMs: Long,
        summary: String
    ) {
        synchronized(history) {
            history.add(ActionRecord(
                timestamp = System.currentTimeMillis(),
                toolName = toolName,
                input = input,
                success = success,
                durationMs = durationMs,
                summary = summary
            ))
            if (history.size > MAX_HISTORY) {
                history.removeAt(0)
            }
        }
    }
}

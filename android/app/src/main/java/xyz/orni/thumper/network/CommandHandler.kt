package xyz.orni.thumper.network

import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import xyz.orni.thumper.flow.FlowEngine
import xyz.orni.thumper.service.ActionExecutor
import xyz.orni.thumper.service.DeviceInfoProvider
import xyz.orni.thumper.service.NodeSelector
import xyz.orni.thumper.service.ThumperAccessibilityService

/**
 * Processes incoming command envelopes from the relay and dispatches
 * them to the accessibility service / action executor.
 *
 * Commands are executed on a dedicated background thread to avoid
 * blocking the WebSocket thread during gestures and app launches.
 */
class CommandHandler(private val service: ThumperAccessibilityService) {

    companion object {
        private const val TAG = "ThumperCmd"
        private const val POST_ACTION_DELAY_MS = 500L
        private const val POST_LAUNCH_DELAY_MS = 1500L
    }

    val executor = ActionExecutor(service)
    private val deviceInfoProvider = DeviceInfoProvider(service)
    private val flowEngine = FlowEngine(service, executor)

    private val workerThread = HandlerThread("ThumperWorker").apply { start() }
    private val workerHandler = Handler(workerThread.looper)

    fun handleCommand(envelopeJson: String, onResponse: (String) -> Unit) {
        workerHandler.post {
            val response = processCommand(envelopeJson)
            onResponse(response)
        }
    }

    private fun processCommand(envelopeJson: String): String {
        return try {
            val envelope = JSONObject(envelopeJson)
            val id = envelope.getString("id")
            val message = envelope.getJSONObject("message")
            val type = message.getString("type")

            val responseMessage = when (type) {
                // Phase 1
                "ReadScreen" -> handleReadScreen()
                "Tap" -> handleTap(message.getJSONObject("data"))
                "TypeText" -> handleTypeText(message.getJSONObject("data"))
                "LaunchApp" -> handleLaunchApp(message.getJSONObject("data"))
                "PressBack" -> handlePressBack()
                "Swipe" -> handleSwipe(message.getJSONObject("data"))
                "Ping" -> JSONObject().put("type", "Pong")

                // Phase 2A
                "TakeScreenshot" -> handleTakeScreenshot(message.optJSONObject("data"))
                "LongPress" -> handleLongPress(message.getJSONObject("data"))
                "Scroll" -> handleScroll(message.getJSONObject("data"))
                "GlobalAction" -> handleGlobalAction(message.getJSONObject("data"))
                "SetClipboard" -> handleSetClipboard(message.getJSONObject("data"))
                "GetClipboard" -> handleGetClipboard()
                "GetDeviceInfo" -> handleGetDeviceInfo()
                "ListInstalledApps" -> handleListInstalledApps()
                "WaitFor" -> handleWaitFor(message.getJSONObject("data"))

                // Phase 2B
                "ExecuteFlow" -> handleExecuteFlow(message.getJSONObject("data"))

                else -> makeError("unknown_command", "Unknown command type: $type")
            }

            JSONObject().apply {
                put("id", id)
                put("timestamp", System.currentTimeMillis())
                put("message", responseMessage)
                if (envelope.has("target")) put("source", envelope.opt("target"))
                if (envelope.has("source")) put("target", envelope.opt("source"))
            }.toString()
        } catch (e: Exception) {
            Log.e(TAG, "Error handling command", e)
            JSONObject().apply {
                put("id", "error")
                put("timestamp", System.currentTimeMillis())
                put("message", makeError("parse_error", "Failed to parse command: ${e.message}"))
            }.toString()
        }
    }

    // ===== Phase 1 handlers =====

    private fun handleReadScreen(): JSONObject {
        val screen = service.readScreen()
        return JSONObject().apply {
            put("type", "ScreenState")
            put("data", screenToJson(screen))
        }
    }

    private fun handleTap(data: JSONObject): JSONObject {
        val selector = parseSelector(data)

        if (selector.text == null && selector.textContains == null &&
            selector.desc == null && selector.descContains == null &&
            selector.resourceId == null && selector.coordinates != null
        ) {
            val result = executor.tapAtCoordinates(
                selector.coordinates.first,
                selector.coordinates.second
            )
            return makeActionResultWithScreen(result, POST_ACTION_DELAY_MS)
        }

        val result = executor.tap(selector)
        return makeActionResultWithScreen(result, POST_ACTION_DELAY_MS)
    }

    private fun handleTypeText(data: JSONObject): JSONObject {
        val selector = parseSelector(data.getJSONObject("selector"))
        val text = data.getString("text")
        val result = executor.typeText(selector, text)
        return makeActionResultWithScreen(result, POST_ACTION_DELAY_MS)
    }

    private fun handleLaunchApp(data: JSONObject): JSONObject {
        val packageName = data.getString("package")
        val result = executor.launchApp(packageName)
        return makeActionResultWithScreen(result, POST_LAUNCH_DELAY_MS)
    }

    private fun handlePressBack(): JSONObject {
        val result = executor.pressBack()
        return makeActionResultWithScreen(result, POST_ACTION_DELAY_MS)
    }

    private fun handleSwipe(data: JSONObject): JSONObject {
        val from = data.getJSONArray("from")
        val to = data.getJSONArray("to")
        val durationMs = data.optLong("duration_ms", 300)

        val (screenW, screenH) = service.getScreenSize()
        val fromX = (from.getInt(0).toFloat() / 1080 * screenW).toInt().coerceIn(0, screenW)
        val fromY = (from.getInt(1).toFloat() / 2400 * screenH).toInt().coerceIn(0, screenH)
        val toX = (to.getInt(0).toFloat() / 1080 * screenW).toInt().coerceIn(0, screenW)
        val toY = (to.getInt(1).toFloat() / 2400 * screenH).toInt().coerceIn(0, screenH)

        val result = executor.swipe(fromX, fromY, toX, toY, durationMs)
        return makeActionResultWithScreen(result, POST_ACTION_DELAY_MS)
    }

    // ===== Phase 2A handlers =====

    private fun handleTakeScreenshot(data: JSONObject?): JSONObject {
        val scale = data?.optDouble("scale", 0.5) ?: 0.5
        val quality = data?.optInt("quality", 50) ?: 50

        val screenshot = service.takeScreenshot(scale, quality)
            ?: return makeError("screenshot_failed", "Failed to capture screenshot (requires Android 11+)")

        return JSONObject().apply {
            put("type", "ScreenshotResult")
            put("data", JSONObject().apply {
                put("image_base64", screenshot.imageBase64)
                put("mime_type", "image/jpeg")
                put("width", screenshot.width)
                put("height", screenshot.height)
            })
        }
    }

    private fun handleLongPress(data: JSONObject): JSONObject {
        val selector = parseSelector(data.getJSONObject("selector"))
        val durationMs = data.optLong("duration_ms", 500)
        val result = executor.longPress(selector, durationMs)
        return makeActionResultWithScreen(result, POST_ACTION_DELAY_MS)
    }

    private fun handleScroll(data: JSONObject): JSONObject {
        val direction = data.getString("direction")
        val selectorData = data.optJSONObject("selector")
        val selector = if (selectorData != null) parseSelector(selectorData) else null
        val result = executor.scroll(selector, direction)
        return makeActionResultWithScreen(result, POST_ACTION_DELAY_MS)
    }

    private fun handleGlobalAction(data: JSONObject): JSONObject {
        val action = data.getString("action")
        val result = executor.globalAction(action)
        return makeActionResultWithScreen(result, POST_ACTION_DELAY_MS)
    }

    private fun handleSetClipboard(data: JSONObject): JSONObject {
        val text = data.getString("text")
        val result = executor.setClipboard(text)
        return makeActionResultWithScreen(result, 0)
    }

    private fun handleGetClipboard(): JSONObject {
        val text = executor.getClipboard()
        return JSONObject().apply {
            put("type", "ClipboardResult")
            put("data", JSONObject().apply {
                if (text != null) put("text", text)
            })
        }
    }

    private fun handleGetDeviceInfo(): JSONObject {
        val info = deviceInfoProvider.getDeviceInfo()
        return JSONObject().apply {
            put("type", "DeviceInfoResult")
            put("data", info)
        }
    }

    private fun handleListInstalledApps(): JSONObject {
        val apps = deviceInfoProvider.getInstalledApps()
        return JSONObject().apply {
            put("type", "InstalledAppsResult")
            put("data", JSONObject().apply {
                put("apps", apps)
            })
        }
    }

    private fun handleWaitFor(data: JSONObject): JSONObject {
        val selector = parseSelector(data.getJSONObject("selector"))
        val timeoutMs = data.optLong("timeout_ms", 10000)
        val pollIntervalMs = data.optLong("poll_interval_ms", 500)

        val startTime = System.currentTimeMillis()
        var found = false

        while (System.currentTimeMillis() - startTime < timeoutMs) {
            val root = service.rootInActiveWindow
            if (root != null) {
                val node = executor.findNodePublic(root, selector)
                if (node != null) {
                    found = true
                    node.recycle()
                    root.recycle()
                    break
                }
                root.recycle()
            }
            Thread.sleep(pollIntervalMs)
        }

        val elapsedMs = System.currentTimeMillis() - startTime
        val screen = service.readScreen()

        return JSONObject().apply {
            put("type", "WaitForResult")
            put("data", JSONObject().apply {
                put("found", found)
                put("elapsed_ms", elapsedMs)
                put("screen", screenToJson(screen))
            })
        }
    }

    // ===== Phase 2B handlers =====

    private fun handleExecuteFlow(data: JSONObject): JSONObject {
        val flowDef = data.getJSONObject("flow")
        val params = data.optJSONObject("params") ?: JSONObject()

        val result = flowEngine.execute(flowDef, params)

        return JSONObject().apply {
            put("type", "FlowResult")
            put("data", result)
        }
    }

    // ===== Shared helpers =====

    private fun parseSelector(data: JSONObject): NodeSelector {
        return NodeSelector(
            text = data.optString("text", null),
            textContains = data.optString("text_contains", null),
            desc = data.optString("desc", null),
            descContains = data.optString("desc_contains", null),
            resourceId = data.optString("resource_id", null),
            className = data.optString("class", null),
            clickable = if (data.has("clickable")) data.getBoolean("clickable") else null,
            coordinates = if (data.has("coordinates")) {
                val arr = data.getJSONArray("coordinates")
                Pair(arr.getInt(0), arr.getInt(1))
            } else null
        )
    }

    private fun makeActionResultWithScreen(
        result: xyz.orni.thumper.service.ActionResult,
        delayMs: Long
    ): JSONObject {
        if (delayMs > 0) Thread.sleep(delayMs)

        val screen = service.readScreen()

        val resultObj = JSONObject().apply {
            put("success", result.success)
            if (result.message != null) put("message", result.message)
            put("screen_after", screenToJson(screen))
        }

        return JSONObject().apply {
            put("type", "ActionResult")
            put("data", resultObj)
        }
    }

    private fun screenToJson(screen: xyz.orni.thumper.service.ScreenState): JSONObject {
        val nodesArray = JSONArray()
        for (node in screen.nodes) {
            nodesArray.put(JSONObject().apply {
                put("index", node.index)
                put("class", node.className)
                if (node.text != null) put("text", node.text)
                if (node.contentDescription != null) put("desc", node.contentDescription)
                if (node.resourceId != null) put("resource_id", node.resourceId)
                put("bounds", JSONArray(node.bounds.toList()))
                put("clickable", node.clickable)
                put("focusable", node.focusable)
                put("editable", node.editable)
                if (node.checked != null) put("checked", node.checked)
                put("enabled", node.enabled)
                put("depth", node.depth)
            })
        }

        return JSONObject().apply {
            put("package", screen.packageName)
            if (screen.activity != null) put("activity", screen.activity)
            put("nodes", nodesArray)
        }
    }

    private fun makeError(code: String, message: String): JSONObject {
        return JSONObject().apply {
            put("type", "Error")
            put("data", JSONObject().apply {
                put("code", code)
                put("message", message)
            })
        }
    }
}

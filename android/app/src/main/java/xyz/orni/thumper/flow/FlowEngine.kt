package xyz.orni.thumper.flow

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import xyz.orni.thumper.service.ActionExecutor
import xyz.orni.thumper.service.NodeSelector
import xyz.orni.thumper.service.ThumperAccessibilityService

/**
 * Executes FlowDefinition sequences on the device.
 * Each step is executed sequentially with optional wait-for conditions
 * and failure handling (retry, skip, abort).
 */
class FlowEngine(
    private val service: ThumperAccessibilityService,
    private val executor: ActionExecutor
) {

    companion object {
        private const val TAG = "ThumperFlow"
        private const val DEFAULT_TIMEOUT_MS = 10000L
        private const val DEFAULT_POLL_INTERVAL_MS = 500L
        private const val POST_ACTION_DELAY_MS = 500L
        private const val POST_LAUNCH_DELAY_MS = 1500L
    }

    /**
     * Execute a flow definition with the given parameter values.
     * Returns a FlowResult JSON object.
     */
    fun execute(flowJson: JSONObject, params: JSONObject): JSONObject {
        val steps = flowJson.getJSONArray("steps")
        val totalSteps = steps.length()
        var stepsCompleted = 0

        Log.i(TAG, "Starting flow '${flowJson.optString("name")}' with $totalSteps steps")

        for (i in 0 until totalSteps) {
            val step = steps.getJSONObject(i)
            val label = step.optString("label", "Step ${i + 1}")
            val action = step.getJSONObject("action")
            val onFailure = parseFailureStrategy(step.optJSONObject("on_failure"))
            val timeoutMs = step.optLong("timeout_ms", DEFAULT_TIMEOUT_MS)

            Log.i(TAG, "Executing step ${i + 1}/$totalSteps: $label")

            val stepResult = executeStepWithRetry(action, params, onFailure, timeoutMs)

            if (!stepResult.success) {
                when (onFailure) {
                    is FailureStrategy.Abort -> {
                        Log.e(TAG, "Flow aborted at step ${i + 1}: ${stepResult.message}")
                        return makeFlowResult(
                            success = false,
                            stepsCompleted = stepsCompleted,
                            totalSteps = totalSteps,
                            error = "Aborted at step ${i + 1} ($label): ${stepResult.message}"
                        )
                    }
                    is FailureStrategy.Skip -> {
                        Log.w(TAG, "Skipping failed step ${i + 1}: ${stepResult.message}")
                    }
                    is FailureStrategy.Retry -> {
                        // Already retried in executeStepWithRetry
                        Log.e(TAG, "Flow aborted after retries at step ${i + 1}")
                        return makeFlowResult(
                            success = false,
                            stepsCompleted = stepsCompleted,
                            totalSteps = totalSteps,
                            error = "Failed after retries at step ${i + 1} ($label): ${stepResult.message}"
                        )
                    }
                }
            }

            stepsCompleted++

            // Handle wait_for condition after the action
            val waitFor = step.optJSONObject("wait_for")
            if (waitFor != null && stepResult.success) {
                val waitResult = executeWaitFor(waitFor)
                if (!waitResult) {
                    Log.w(TAG, "Wait condition not met after step ${i + 1}")
                    // Don't abort on wait failure — the action itself succeeded
                }
            }
        }

        Log.i(TAG, "Flow completed successfully: $stepsCompleted/$totalSteps steps")
        return makeFlowResult(
            success = true,
            stepsCompleted = stepsCompleted,
            totalSteps = totalSteps,
            error = null
        )
    }

    private fun executeStepWithRetry(
        action: JSONObject,
        params: JSONObject,
        onFailure: FailureStrategy,
        timeoutMs: Long
    ): StepResult {
        val maxAttempts = when (onFailure) {
            is FailureStrategy.Retry -> onFailure.maxAttempts
            else -> 1
        }
        val retryDelay = when (onFailure) {
            is FailureStrategy.Retry -> onFailure.delayMs
            else -> 0L
        }

        var lastResult = StepResult(false, "not executed")

        for (attempt in 1..maxAttempts) {
            lastResult = executeAction(action, params)
            if (lastResult.success) return lastResult

            if (attempt < maxAttempts) {
                Log.i(TAG, "Retry attempt $attempt/$maxAttempts, waiting ${retryDelay}ms")
                Thread.sleep(retryDelay)
            }
        }

        return lastResult
    }

    private fun executeAction(action: JSONObject, params: JSONObject): StepResult {
        val type = action.getString("type")
        val data = action.optJSONObject("data")

        return when (type) {
            "LaunchApp" -> {
                val pkg = interpolate(data!!.getString("package"), params)
                val result = executor.launchApp(pkg)
                Thread.sleep(POST_LAUNCH_DELAY_MS)
                StepResult(result.success, result.message)
            }

            "Tap" -> {
                val selector = parseSelectorWithInterpolation(data!!, params)
                val result = if (selector.coordinates != null &&
                    selector.text == null && selector.textContains == null &&
                    selector.desc == null && selector.descContains == null &&
                    selector.resourceId == null
                ) {
                    executor.tapAtCoordinates(selector.coordinates.first, selector.coordinates.second)
                } else {
                    executor.tap(selector)
                }
                Thread.sleep(POST_ACTION_DELAY_MS)
                StepResult(result.success, result.message)
            }

            "LongPress" -> {
                val selector = parseSelectorWithInterpolation(data!!, params)
                val durationMs = data.optLong("duration_ms", 500)
                val result = executor.longPress(selector, durationMs)
                Thread.sleep(POST_ACTION_DELAY_MS)
                StepResult(result.success, result.message)
            }

            "TypeText" -> {
                val selectorData = data!!.getJSONObject("selector")
                val selector = parseSelectorWithInterpolation(selectorData, params)
                val text = interpolate(data.getString("value"), params)
                val result = executor.typeText(selector, text)
                Thread.sleep(POST_ACTION_DELAY_MS)
                StepResult(result.success, result.message)
            }

            "Swipe" -> {
                val from = data!!.getJSONArray("from")
                val to = data.getJSONArray("to")
                val durationMs = data.optLong("duration_ms", 300)
                val (screenW, screenH) = service.getScreenSize()
                val fromX = (from.getInt(0).toFloat() / 1080 * screenW).toInt().coerceIn(0, screenW)
                val fromY = (from.getInt(1).toFloat() / 2400 * screenH).toInt().coerceIn(0, screenH)
                val toX = (to.getInt(0).toFloat() / 1080 * screenW).toInt().coerceIn(0, screenW)
                val toY = (to.getInt(1).toFloat() / 2400 * screenH).toInt().coerceIn(0, screenH)
                val result = executor.swipe(fromX, fromY, toX, toY, durationMs)
                Thread.sleep(POST_ACTION_DELAY_MS)
                StepResult(result.success, result.message)
            }

            "Scroll" -> {
                val direction = data?.optString("direction", "down") ?: "down"
                val selectorData = data?.optJSONObject("selector")
                val selector = if (selectorData != null) parseSelectorWithInterpolation(selectorData, params) else null
                val result = executor.scroll(selector, direction)
                Thread.sleep(POST_ACTION_DELAY_MS)
                StepResult(result.success, result.message)
            }

            "WaitFor" -> {
                val selector = parseSelectorWithInterpolation(data!!, params)
                val timeoutMs = data.optLong("timeout_ms", DEFAULT_TIMEOUT_MS)
                val found = pollForSelector(selector, timeoutMs, DEFAULT_POLL_INTERVAL_MS)
                StepResult(found, if (found) "element found" else "timeout waiting for element")
            }

            "PressBack" -> {
                val result = executor.pressBack()
                Thread.sleep(POST_ACTION_DELAY_MS)
                StepResult(result.success, result.message)
            }

            "ReadScreen" -> {
                service.readScreen()
                StepResult(true, "screen read")
            }

            "Delay" -> {
                val ms = data!!.getLong("ms")
                Thread.sleep(ms)
                StepResult(true, "delayed ${ms}ms")
            }

            else -> StepResult(false, "unknown action type: $type")
        }
    }

    private fun executeWaitFor(waitFor: JSONObject): Boolean {
        val selector = parseSelectorWithInterpolation(waitFor.getJSONObject("selector"), JSONObject())
        val timeoutMs = waitFor.optLong("timeout_ms", DEFAULT_TIMEOUT_MS)
        val pollIntervalMs = waitFor.optLong("poll_interval_ms", DEFAULT_POLL_INTERVAL_MS)
        return pollForSelector(selector, timeoutMs, pollIntervalMs)
    }

    private fun pollForSelector(selector: NodeSelector, timeoutMs: Long, pollIntervalMs: Long): Boolean {
        val startTime = System.currentTimeMillis()
        while (System.currentTimeMillis() - startTime < timeoutMs) {
            val root = service.rootInActiveWindow
            if (root != null) {
                val found = executor.findNodePublic(root, selector)
                if (found != null) {
                    found.recycle()
                    root.recycle()
                    return true
                }
                root.recycle()
            }
            Thread.sleep(pollIntervalMs)
        }
        return false
    }

    /**
     * Interpolate {{param}} placeholders in a string with actual values.
     */
    private fun interpolate(template: String, params: JSONObject): String {
        var result = template
        val keys = params.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            result = result.replace("{{$key}}", params.optString(key, ""))
        }
        return result
    }

    private fun parseSelectorWithInterpolation(data: JSONObject, params: JSONObject): NodeSelector {
        return NodeSelector(
            text = data.optString("text", null)?.let { interpolate(it, params) },
            textContains = data.optString("text_contains", null)?.let { interpolate(it, params) },
            desc = data.optString("desc", null)?.let { interpolate(it, params) },
            descContains = data.optString("desc_contains", null)?.let { interpolate(it, params) },
            resourceId = data.optString("resource_id", null),
            className = data.optString("class", null),
            clickable = if (data.has("clickable")) data.getBoolean("clickable") else null,
            coordinates = if (data.has("coordinates")) {
                val arr = data.getJSONArray("coordinates")
                Pair(arr.getInt(0), arr.getInt(1))
            } else null
        )
    }

    private fun parseFailureStrategy(obj: JSONObject?): FailureStrategy {
        if (obj == null) return FailureStrategy.Abort
        // Check if it's a string "abort" or "skip"
        return when {
            obj.has("retry") -> {
                val retry = obj.getJSONObject("retry")
                FailureStrategy.Retry(
                    maxAttempts = retry.optInt("max_attempts", 3),
                    delayMs = retry.optLong("delay_ms", 1000)
                )
            }
            else -> {
                // Try to parse as a simple string
                when (obj.optString("type", "abort").lowercase()) {
                    "skip" -> FailureStrategy.Skip
                    else -> FailureStrategy.Abort
                }
            }
        }
    }

    private fun makeFlowResult(
        success: Boolean,
        stepsCompleted: Int,
        totalSteps: Int,
        error: String?
    ): JSONObject {
        val screen = service.readScreen()
        return JSONObject().apply {
            put("success", success)
            put("steps_completed", stepsCompleted)
            put("total_steps", totalSteps)
            put("final_screen", screenToJson(screen))
            if (error != null) put("error", error)
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

    private data class StepResult(val success: Boolean, val message: String?)

    private sealed class FailureStrategy {
        data object Abort : FailureStrategy()
        data object Skip : FailureStrategy()
        data class Retry(val maxAttempts: Int, val delayMs: Long) : FailureStrategy()
    }
}

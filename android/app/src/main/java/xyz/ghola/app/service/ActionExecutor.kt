package xyz.ghola.app.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Path
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Executes UI actions on the device using Accessibility APIs.
 */
class ActionExecutor(private val service: ThumperAccessibilityService) {

    companion object {
        private const val TAG = "ThumperAction"
    }

    // ===== Phase 1 actions =====

    fun tap(selector: NodeSelector): ActionResult {
        val root = service.rootInActiveWindow ?: return ActionResult(
            success = false,
            message = "no active window"
        )

        val node = findNode(root, selector)

        if (node == null) {
            root.recycle()
            return ActionResult(
                success = false,
                message = "no matching node found for selector"
            )
        }

        if (node.isClickable) {
            val result = node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            node.recycle()
            root.recycle()
            return ActionResult(
                success = result,
                message = if (result) "tapped via click action" else "click action failed"
            )
        }

        // Fallback: gesture tap at center of bounds
        val bounds = android.graphics.Rect()
        node.getBoundsInScreen(bounds)
        node.recycle()
        root.recycle()

        return dispatchTap(
            (bounds.left + bounds.right) / 2,
            (bounds.top + bounds.bottom) / 2
        )
    }

    fun tapAtCoordinates(x: Int, y: Int): ActionResult {
        return dispatchTap(x, y)
    }

    private fun dispatchTap(x: Int, y: Int): ActionResult {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }

        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 50))
            .build()

        return dispatchGestureSync(gesture, 2, "tapped at ($x, $y)", "tap gesture cancelled")
    }

    fun swipe(fromX: Int, fromY: Int, toX: Int, toY: Int, durationMs: Long): ActionResult {
        val path = Path().apply {
            moveTo(fromX.toFloat(), fromY.toFloat())
            lineTo(toX.toFloat(), toY.toFloat())
        }

        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs))
            .build()

        return dispatchGestureSync(
            gesture, 5,
            "swiped ($fromX,$fromY)->($toX,$toY)",
            "swipe cancelled"
        )
    }

    fun typeText(selector: NodeSelector, text: String): ActionResult {
        val root = service.rootInActiveWindow ?: return ActionResult(
            success = false,
            message = "no active window"
        )

        val node = findNode(root, selector)

        if (node == null) {
            root.recycle()
            return ActionResult(success = false, message = "no matching input field found")
        }

        node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)

        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        val result = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        node.recycle()
        root.recycle()

        return ActionResult(
            success = result,
            message = if (result) "text set successfully" else "failed to set text"
        )
    }

    fun launchApp(packageName: String): ActionResult {
        return try {
            val intent = service.packageManager.getLaunchIntentForPackage(packageName)
                ?: return ActionResult(false, "package not found: $packageName")
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            service.startActivity(intent)
            ActionResult(success = true, message = "launched $packageName")
        } catch (e: Exception) {
            ActionResult(false, "failed to launch: ${e.message}")
        }
    }

    fun pressBack(): ActionResult {
        val result = service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
        return ActionResult(result, if (result) "back pressed" else "back press failed")
    }

    // ===== Phase 2A actions =====

    /**
     * Long press a UI element. Uses a gesture with extended duration.
     */
    fun longPress(selector: NodeSelector, durationMs: Long = 500): ActionResult {
        val root = service.rootInActiveWindow ?: return ActionResult(
            success = false,
            message = "no active window"
        )

        val node = findNode(root, selector)

        if (node == null) {
            // Try coordinate-based long press
            if (selector.coordinates != null) {
                root.recycle()
                return dispatchLongPress(
                    selector.coordinates.first,
                    selector.coordinates.second,
                    durationMs
                )
            }
            root.recycle()
            return ActionResult(false, "no matching node found for long press")
        }

        // Use node's ACTION_LONG_CLICK if available
        if (node.isLongClickable) {
            val result = node.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)
            node.recycle()
            root.recycle()
            return ActionResult(result, if (result) "long pressed via action" else "long press action failed")
        }

        // Fallback: gesture-based long press at center of bounds
        val bounds = android.graphics.Rect()
        node.getBoundsInScreen(bounds)
        node.recycle()
        root.recycle()

        return dispatchLongPress(
            (bounds.left + bounds.right) / 2,
            (bounds.top + bounds.bottom) / 2,
            durationMs
        )
    }

    private fun dispatchLongPress(x: Int, y: Int, durationMs: Long): ActionResult {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }

        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs))
            .build()

        return dispatchGestureSync(
            gesture,
            (durationMs / 1000 + 2).toInt(),
            "long pressed at ($x, $y) for ${durationMs}ms",
            "long press gesture cancelled"
        )
    }

    /**
     * Scroll a scrollable view using accessibility actions.
     * More reliable than gesture-based swiping for scrollable containers.
     */
    fun scroll(selector: NodeSelector?, direction: String): ActionResult {
        val root = service.rootInActiveWindow ?: return ActionResult(
            success = false,
            message = "no active window"
        )

        // Find the scrollable node
        val scrollable = if (selector != null) {
            findNode(root, selector)
        } else {
            findFirstScrollable(root)
        }

        if (scrollable == null) {
            root.recycle()
            return ActionResult(false, "no scrollable view found")
        }

        val action = when (direction.lowercase()) {
            "down" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            "up" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            "right" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            "left" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            else -> {
                scrollable.recycle()
                root.recycle()
                return ActionResult(false, "invalid scroll direction: $direction")
            }
        }

        val result = scrollable.performAction(action)
        scrollable.recycle()
        root.recycle()

        return ActionResult(
            result,
            if (result) "scrolled $direction" else "scroll $direction failed"
        )
    }

    private fun findFirstScrollable(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (root.isScrollable) return root
        // BFS: prefer shallowest (outermost) scrollable to handle nested scrollable containers
        val queue = java.util.LinkedList<AccessibilityNodeInfo>()
        for (i in 0 until root.childCount) {
            val child = root.getChild(i) ?: continue
            queue.add(child)
        }
        val toRecycle = mutableListOf<AccessibilityNodeInfo>()
        while (queue.isNotEmpty()) {
            val node = queue.poll() ?: continue
            if (node.isScrollable) {
                // Recycle non-result nodes
                toRecycle.forEach { it.recycle() }
                queue.forEach { it.recycle() }
                return node
            }
            toRecycle.add(node)
            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                queue.add(child)
            }
        }
        toRecycle.forEach { it.recycle() }
        return null
    }

    /**
     * Perform a global device action (home, recents, notifications, etc.).
     */
    fun globalAction(action: String): ActionResult {
        val globalAction = when (action.lowercase()) {
            "home" -> AccessibilityService.GLOBAL_ACTION_HOME
            "recents" -> AccessibilityService.GLOBAL_ACTION_RECENTS
            "notifications" -> AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS
            "quick_settings" -> AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS
            "power_dialog" -> AccessibilityService.GLOBAL_ACTION_POWER_DIALOG
            else -> return ActionResult(false, "unknown global action: $action")
        }

        val result = service.performGlobalAction(globalAction)
        return ActionResult(result, if (result) "$action performed" else "$action failed")
    }

    /**
     * Set text to the device clipboard.
     */
    fun setClipboard(text: String): ActionResult {
        return try {
            val clipboard = service.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = ClipData.newPlainText("thumper", text)
            clipboard.setPrimaryClip(clip)
            ActionResult(true, "clipboard set")
        } catch (e: Exception) {
            ActionResult(false, "failed to set clipboard: ${e.message}")
        }
    }

    /**
     * Get text from the device clipboard.
     */
    fun getClipboard(): String? {
        return try {
            val clipboard = service.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            if (clipboard.hasPrimaryClip()) {
                clipboard.primaryClip?.getItemAt(0)?.text?.toString()
            } else {
                null
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to read clipboard", e)
            null
        }
    }

    // ===== Shared helpers =====

    /**
     * Public node finder for use by FlowEngine and WaitFor handler.
     */
    fun findNodePublic(root: AccessibilityNodeInfo, selector: NodeSelector): AccessibilityNodeInfo? {
        return findNode(root, selector)
    }

    private fun dispatchGestureSync(
        gesture: GestureDescription,
        timeoutSecs: Int,
        successMsg: String,
        failureMsg: String
    ): ActionResult {
        val latch = CountDownLatch(1)
        var gestureSuccess = false

        service.dispatchGesture(gesture, object : AccessibilityService.GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
                gestureSuccess = true
                latch.countDown()
            }
            override fun onCancelled(gestureDescription: GestureDescription?) {
                gestureSuccess = false
                latch.countDown()
            }
        }, null)

        latch.await(timeoutSecs.toLong(), TimeUnit.SECONDS)

        return ActionResult(
            success = gestureSuccess,
            message = if (gestureSuccess) successMsg else failureMsg
        )
    }

    private fun findNode(root: AccessibilityNodeInfo, selector: NodeSelector): AccessibilityNodeInfo? {
        // Resource ID (most specific) — try both full and short forms
        selector.resourceId?.let { id ->
            val nodes = root.findAccessibilityNodeInfosByViewId(id)
            if (nodes.isNotEmpty()) return nodes[0]
            // Try with common package prefixes if short form
            if (!id.contains(":id/")) {
                val pkg = root.packageName?.toString()
                if (pkg != null) {
                    val fullId = "$pkg:id/$id"
                    val fullNodes = root.findAccessibilityNodeInfosByViewId(fullId)
                    if (fullNodes.isNotEmpty()) return fullNodes[0]
                }
            }
        }

        // Exact text — try API first, then fall back to case-insensitive traversal
        selector.text?.let { text ->
            val nodes = root.findAccessibilityNodeInfosByText(text)
            for (node in nodes) {
                if (node.text?.toString() == text) {
                    if (selector.clickable == null || node.isClickable == selector.clickable) {
                        return node
                    }
                }
                node.recycle()
            }
            // Fallback: case-insensitive full traversal
            val found = findByTraversal(root) {
                it.text?.toString().equals(text, ignoreCase = true) &&
                    (selector.clickable == null || it.isClickable == selector.clickable)
            }
            if (found != null) return found
        }

        // Text contains — try API first, then case-insensitive traversal
        selector.textContains?.let { text ->
            val nodes = root.findAccessibilityNodeInfosByText(text)
            for (node in nodes) {
                if (node.text?.toString()?.contains(text, ignoreCase = true) == true) {
                    if (selector.clickable == null || node.isClickable == selector.clickable) {
                        return node
                    }
                }
                node.recycle()
            }
            // Fallback: case-insensitive full traversal
            val found = findByTraversal(root) {
                it.text?.toString()?.contains(text, ignoreCase = true) == true &&
                    (selector.clickable == null || it.isClickable == selector.clickable)
            }
            if (found != null) return found
        }

        // Content description — case-insensitive
        selector.desc?.let { desc ->
            return findByTraversal(root) { it.contentDescription?.toString().equals(desc, ignoreCase = true) }
        }

        selector.descContains?.let { desc ->
            return findByTraversal(root) { it.contentDescription?.toString()?.contains(desc, ignoreCase = true) == true }
        }

        // Class name selector
        selector.className?.let { cls ->
            return findByTraversal(root) {
                val nodeCls = it.className?.toString() ?: ""
                nodeCls == cls || nodeCls.endsWith(".$cls")
            }
        }

        return null
    }

    private fun findByTraversal(
        root: AccessibilityNodeInfo,
        predicate: (AccessibilityNodeInfo) -> Boolean
    ): AccessibilityNodeInfo? {
        if (predicate(root)) return root
        for (i in 0 until root.childCount) {
            val child = root.getChild(i) ?: continue
            val result = findByTraversal(child, predicate)
            if (result != null) return result
            child.recycle()
        }
        return null
    }
}

data class NodeSelector(
    val text: String? = null,
    val textContains: String? = null,
    val desc: String? = null,
    val descContains: String? = null,
    val resourceId: String? = null,
    val className: String? = null,
    val clickable: Boolean? = null,
    val coordinates: Pair<Int, Int>? = null
)

data class ActionResult(
    val success: Boolean,
    val message: String? = null
)

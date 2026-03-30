package xyz.orni.thumper.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.graphics.Bitmap
import android.os.Build
import android.util.Base64
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import xyz.orni.thumper.network.DeviceKeyManager
import xyz.orni.thumper.network.RelayConnection
import xyz.orni.thumper.network.CommandHandler
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Accessibility service that captures the UI tree and executes actions
 * on behalf of the remote MCP client via the relay.
 */
class ThumperAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "ThumperA11y"
        var instance: ThumperAccessibilityService? = null
            private set
    }

    private var relayConnection: RelayConnection? = null
    var commandHandler: CommandHandler? = null
        private set
    private var currentPackage: String? = null
    private var currentActivity: String? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        Log.i(TAG, "Accessibility service connected")
        instance = this

        serviceInfo = serviceInfo.apply {
            eventTypes = AccessibilityEvent.TYPES_ALL_MASK
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            flags = flags or
                    AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
                    AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or
                    AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
            notificationTimeout = 100
        }

        commandHandler = CommandHandler(this)

        val prefs = getSharedPreferences("thumper", Context.MODE_PRIVATE)
        val relayUrl = prefs.getString("relay_url", null)
        if (relayUrl != null) {
            connectToRelay(relayUrl)
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        event ?: return
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            event.packageName?.toString()?.let { currentPackage = it }
            event.className?.toString()?.let { cls ->
                // Only store if it looks like an Activity class name (contains a dot)
                if (cls.contains('.')) {
                    currentActivity = cls.substringAfterLast('.')
                }
            }
        }
    }

    override fun onInterrupt() {
        Log.w(TAG, "Accessibility service interrupted")
    }

    override fun onDestroy() {
        super.onDestroy()
        instance = null
        relayConnection?.disconnect()
        Log.i(TAG, "Accessibility service destroyed")
    }

    fun connectToRelay(url: String) {
        relayConnection?.disconnect()
        val keyManager = DeviceKeyManager(this)
        relayConnection = RelayConnection(url, keyManager.getDevicePubkey(), commandHandler!!)
        relayConnection?.connect()
    }

    fun isRelayConnected(): Boolean = relayConnection?.isConnected() ?: false

    /**
     * Read the current screen and return a compact representation
     * of the accessibility tree.
     */
    fun readScreen(): ScreenState {
        val root = rootInActiveWindow ?: return ScreenState(
            packageName = currentPackage ?: "unknown",
            activity = currentActivity,
            nodes = emptyList()
        )

        val pkg = root.packageName?.toString() ?: currentPackage ?: "unknown"
        val nodes = mutableListOf<UiNodeData>()
        parseNode(root, nodes, 0)
        root.recycle()

        return ScreenState(
            packageName = pkg,
            activity = currentActivity,
            nodes = nodes
        )
    }

    /**
     * Take a screenshot of the current screen.
     * Requires Android 11+ (API 30). Returns ScreenshotData or null.
     */
    fun takeScreenshot(scale: Double = 0.5, quality: Int = 50): ScreenshotData? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            Log.w(TAG, "Screenshot requires Android 11+ (API 30)")
            return null
        }

        val latch = CountDownLatch(1)
        var resultBitmap: Bitmap? = null

        takeScreenshot(
            Display.DEFAULT_DISPLAY,
            mainExecutor,
            object : TakeScreenshotCallback {
                override fun onSuccess(screenshot: ScreenshotResult) {
                    resultBitmap = screenshot.hardwareBuffer?.let {
                        Bitmap.wrapHardwareBuffer(it, screenshot.colorSpace)?.also { _ ->
                            it.close()
                        }
                    }
                    latch.countDown()
                }

                override fun onFailure(errorCode: Int) {
                    Log.e(TAG, "Screenshot failed with error code: $errorCode")
                    latch.countDown()
                }
            }
        )

        if (!latch.await(5, TimeUnit.SECONDS)) {
            Log.e(TAG, "Screenshot timed out")
            return null
        }

        val bitmap = resultBitmap ?: return null

        // Scale down if needed
        val scaledBitmap = if (scale < 1.0) {
            val newWidth = (bitmap.width * scale).toInt()
            val newHeight = (bitmap.height * scale).toInt()
            Bitmap.createScaledBitmap(bitmap, newWidth, newHeight, true).also {
                if (it != bitmap) bitmap.recycle()
            }
        } else {
            bitmap
        }

        // Convert hardware bitmap to software bitmap for compression
        val softwareBitmap = if (scaledBitmap.config == Bitmap.Config.HARDWARE) {
            scaledBitmap.copy(Bitmap.Config.ARGB_8888, false).also {
                scaledBitmap.recycle()
            }
        } else {
            scaledBitmap
        }

        // Compress to JPEG
        val outputStream = ByteArrayOutputStream()
        softwareBitmap.compress(Bitmap.CompressFormat.JPEG, quality, outputStream)
        val width = softwareBitmap.width
        val height = softwareBitmap.height
        softwareBitmap.recycle()

        val base64 = Base64.encodeToString(outputStream.toByteArray(), Base64.NO_WRAP)

        return ScreenshotData(
            imageBase64 = base64,
            width = width,
            height = height
        )
    }

    /**
     * Get the screen dimensions for coordinate calculations.
     */
    fun getScreenSize(): Pair<Int, Int> {
        val wm = getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager
        val metrics = android.util.DisplayMetrics()
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(metrics)
        return Pair(metrics.widthPixels, metrics.heightPixels)
    }

    private fun parseNode(
        node: AccessibilityNodeInfo,
        nodes: MutableList<UiNodeData>,
        depth: Int
    ) {
        if (!node.isVisibleToUser) return

        val index = nodes.size
        val bounds = android.graphics.Rect()
        node.getBoundsInScreen(bounds)

        val hasText = !node.text.isNullOrEmpty()
        val hasDesc = !node.contentDescription.isNullOrEmpty()
        val isInteractive = node.isClickable || node.isEditable || node.isFocusable || node.isScrollable || node.isLongClickable
        val hasId = node.viewIdResourceName != null

        if (hasText || hasDesc || isInteractive || hasId) {
            nodes.add(
                UiNodeData(
                    index = index,
                    className = node.className?.toString()?.substringAfterLast('.') ?: "",
                    text = node.text?.toString(),
                    contentDescription = node.contentDescription?.toString(),
                    resourceId = node.viewIdResourceName?.substringAfter('/'),
                    bounds = intArrayOf(bounds.left, bounds.top, bounds.right, bounds.bottom),
                    clickable = node.isClickable,
                    focusable = node.isFocusable,
                    editable = node.isEditable,
                    checked = if (node.isCheckable) node.isChecked else null,
                    enabled = node.isEnabled,
                    scrollable = node.isScrollable,
                    longClickable = node.isLongClickable,
                    depth = depth
                )
            )
        }

        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            parseNode(child, nodes, depth + 1)
            child.recycle()
        }
    }
}

data class ScreenState(
    val packageName: String,
    val activity: String?,
    val nodes: List<UiNodeData>
)

data class UiNodeData(
    val index: Int,
    val className: String,
    val text: String?,
    val contentDescription: String?,
    val resourceId: String?,
    val bounds: IntArray,
    val clickable: Boolean,
    val focusable: Boolean,
    val editable: Boolean,
    val checked: Boolean?,
    val enabled: Boolean,
    val scrollable: Boolean,
    val longClickable: Boolean,
    val depth: Int
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is UiNodeData) return false
        return index == other.index && className == other.className
    }

    override fun hashCode(): Int = index.hashCode()
}

data class ScreenshotData(
    val imageBase64: String,
    val width: Int,
    val height: Int
)

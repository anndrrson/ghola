package xyz.ghola.app.ai

import org.json.JSONArray
import org.json.JSONObject

/**
 * Defines all 21 tool schemas in Claude API format for on-device tool use.
 * Tool names drop the "device_" prefix from MCP names.
 */
object ToolDefinitions {

    fun getTools(): JSONArray {
        val tools = JSONArray()

        // Phase 1
        tools.put(tool(
            name = "read_screen",
            description = "Read the device screen and return the UI accessibility tree as structured JSON. Returns all visible UI elements with their text, descriptions, bounds, and interactive properties. Call this first to understand what's on screen before taking any action.",
            properties = JSONObject(),
            required = emptyList()
        ))

        tools.put(tool(
            name = "tap",
            description = "Tap a UI element on the device screen. Specify the element using one or more selectors: text (exact match), text_contains (partial match), desc (content description), resource_id (Android resource ID), or coordinates ([x, y] pixel position as fallback). Use read_screen first to find the right selector.",
            properties = selectorProperties(),
            required = emptyList()
        ))

        tools.put(tool(
            name = "type_text",
            description = "Type text into an input field on the device screen. Identify the target field using a selector (text, text_contains, desc, resource_id). The field must be editable. Returns the updated screen state after typing.",
            properties = JSONObject()
                .put("selector", JSONObject()
                    .put("type", "object")
                    .put("description", "Selector to identify the target input field")
                    .put("properties", selectorProperties())
                )
                .put("text", JSONObject()
                    .put("type", "string")
                    .put("description", "The text to type into the field")
                ),
            required = listOf("selector", "text")
        ))

        tools.put(tool(
            name = "launch_app",
            description = "Launch an Android app by its package name (e.g., 'app.phantom' for Phantom wallet, 'com.google.android.apps.maps' for Maps). Returns the screen state after the app launches.",
            properties = JSONObject()
                .put("package", JSONObject()
                    .put("type", "string")
                    .put("description", "The package name of the app to launch")
                ),
            required = listOf("package")
        ))

        tools.put(tool(
            name = "press_back",
            description = "Press the Android back button. Useful for closing dialogs, going back in navigation, or dismissing keyboards. Returns the updated screen state.",
            properties = JSONObject(),
            required = emptyList()
        ))

        tools.put(tool(
            name = "swipe",
            description = "Swipe on the device screen in a direction. Use 'up' to scroll down through content, 'down' to scroll up. The distance parameter controls swipe length. For scrollable containers, prefer scroll which uses accessibility APIs and is more reliable.",
            properties = JSONObject()
                .put("direction", JSONObject()
                    .put("type", "string")
                    .put("enum", JSONArray().put("up").put("down").put("left").put("right"))
                    .put("description", "Swipe direction")
                )
                .put("distance", JSONObject()
                    .put("type", "string")
                    .put("enum", JSONArray().put("small").put("medium").put("large"))
                    .put("description", "Swipe distance (default: medium)")
                ),
            required = listOf("direction")
        ))

        // Phase 2A
        tools.put(tool(
            name = "screenshot",
            description = "Take a screenshot of the device screen and return it as a JPEG image. Use this when the accessibility tree doesn't provide enough context -- e.g., for visual elements like icons, images, charts, or complex layouts.",
            properties = JSONObject()
                .put("scale", JSONObject()
                    .put("type", "number")
                    .put("description", "Scale factor 0.1-1.0 (default: 0.75)")
                )
                .put("quality", JSONObject()
                    .put("type", "integer")
                    .put("description", "JPEG quality 1-100 (default: 70)")
                ),
            required = emptyList()
        ))

        tools.put(tool(
            name = "long_press",
            description = "Long press a UI element to trigger context menus, drag operations, or selection mode. Uses the same selectors as tap. The duration_ms parameter controls hold time (default 500ms).",
            properties = JSONObject()
                .put("selector", JSONObject()
                    .put("type", "object")
                    .put("description", "Selector to identify the target element")
                    .put("properties", selectorProperties())
                )
                .put("duration_ms", JSONObject()
                    .put("type", "integer")
                    .put("description", "Hold duration in milliseconds (default: 500)")
                ),
            required = listOf("selector")
        ))

        tools.put(tool(
            name = "scroll",
            description = "Scroll a scrollable view up, down, left, or right using accessibility actions. More reliable than swipe for scrolling lists and containers. Optionally target a specific scrollable container by selector.",
            properties = JSONObject()
                .put("direction", JSONObject()
                    .put("type", "string")
                    .put("enum", JSONArray().put("up").put("down").put("left").put("right"))
                    .put("description", "Scroll direction")
                )
                .put("selector", JSONObject()
                    .put("type", "object")
                    .put("description", "Optional selector to target a specific scrollable container")
                    .put("properties", selectorProperties())
                ),
            required = listOf("direction")
        ))

        tools.put(tool(
            name = "global_action",
            description = "Perform a global device action: home, recents, notifications, quick_settings, or power_dialog. Returns the updated screen state.",
            properties = JSONObject()
                .put("action", JSONObject()
                    .put("type", "string")
                    .put("enum", JSONArray()
                        .put("home").put("recents").put("notifications")
                        .put("quick_settings").put("power_dialog"))
                    .put("description", "The global action to perform")
                ),
            required = listOf("action")
        ))

        tools.put(tool(
            name = "clipboard_set",
            description = "Copy text to the device clipboard. Useful for pasting addresses, amounts, or other data into apps.",
            properties = JSONObject()
                .put("text", JSONObject()
                    .put("type", "string")
                    .put("description", "The text to copy to the clipboard")
                ),
            required = listOf("text")
        ))

        tools.put(tool(
            name = "clipboard_get",
            description = "Read the current text from the device clipboard.",
            properties = JSONObject(),
            required = emptyList()
        ))

        tools.put(tool(
            name = "device_info",
            description = "Get device information including battery level, screen dimensions, Android version, connectivity status, and hardware details.",
            properties = JSONObject(),
            required = emptyList()
        ))

        tools.put(tool(
            name = "list_apps",
            description = "List all installed apps on the device with their package names and display labels. Useful for finding the correct package name to use with launch_app.",
            properties = JSONObject(),
            required = emptyList()
        ))

        tools.put(tool(
            name = "wait_for",
            description = "Wait for a UI element matching the selector to appear on screen. Polls the accessibility tree until the element is found or timeout is reached. Use this after actions that trigger loading or async transitions.",
            properties = JSONObject()
                .put("selector", JSONObject()
                    .put("type", "object")
                    .put("description", "Selector for the element to wait for")
                    .put("properties", selectorProperties())
                )
                .put("timeout_ms", JSONObject()
                    .put("type", "integer")
                    .put("description", "Max wait time in milliseconds (default: 10000)")
                ),
            required = listOf("selector")
        ))

        // Phase 2B
        tools.put(tool(
            name = "execute_flow",
            description = "Execute a pre-defined multi-step flow on the device. Flows are scripted sequences of actions that run entirely on-device with zero AI cost per step. Use list_flows to see available flows and their parameters.",
            properties = JSONObject()
                .put("flow", JSONObject()
                    .put("type", "object")
                    .put("description", "The flow definition object")
                )
                .put("params", JSONObject()
                    .put("type", "object")
                    .put("description", "Optional parameters for the flow")
                ),
            required = listOf("flow")
        ))

        tools.put(tool(
            name = "list_flows",
            description = "List all available flow definitions with their names, descriptions, parameters, and step counts.",
            properties = JSONObject(),
            required = emptyList()
        ))

        // Phase 2D
        tools.put(tool(
            name = "read_notifications",
            description = "Read recent notifications from the device. Returns key, package, title, text, and timestamp for each notification. Use the key with dismiss_notification to clear specific ones.",
            properties = JSONObject()
                .put("limit", JSONObject()
                    .put("type", "integer")
                    .put("description", "Max notifications to return (default: 20)")
                ),
            required = emptyList()
        ))

        tools.put(tool(
            name = "dismiss_notification",
            description = "Dismiss a notification by its key (obtained from read_notifications).",
            properties = JSONObject()
                .put("key", JSONObject()
                    .put("type", "string")
                    .put("description", "The notification key to dismiss")
                ),
            required = listOf("key")
        ))

        // Intelligence
        tools.put(tool(
            name = "smart_read",
            description = "Intelligently read the device screen. Reads the accessibility tree first, then automatically takes a screenshot if fewer than 5 nodes are found (indicating a WebView, Flutter app, or canvas-based UI). Use this when you're unsure about the app's UI framework.",
            properties = JSONObject(),
            required = emptyList()
        ))

        tools.put(tool(
            name = "history",
            description = "View recent action history from this session. Returns the last N actions with timestamps, tool names, parameters, success/failure status, and duration. Useful for reviewing what has been done and avoiding repeating failed approaches.",
            properties = JSONObject()
                .put("limit", JSONObject()
                    .put("type", "integer")
                    .put("description", "Number of recent actions to return (default: 20)")
                ),
            required = emptyList()
        ))

        return tools
    }

    private fun selectorProperties(): JSONObject {
        return JSONObject()
            .put("text", JSONObject()
                .put("type", "string")
                .put("description", "Exact visible text of the element")
            )
            .put("text_contains", JSONObject()
                .put("type", "string")
                .put("description", "Partial text match")
            )
            .put("desc", JSONObject()
                .put("type", "string")
                .put("description", "Accessibility content description")
            )
            .put("resource_id", JSONObject()
                .put("type", "string")
                .put("description", "Android resource ID (e.g., com.app:id/btn)")
            )
            .put("coordinates", JSONObject()
                .put("type", "object")
                .put("description", "Pixel coordinates {x, y} as fallback")
                .put("properties", JSONObject()
                    .put("x", JSONObject().put("type", "integer"))
                    .put("y", JSONObject().put("type", "integer"))
                )
                .put("required", JSONArray().put("x").put("y"))
            )
    }

    private fun tool(
        name: String,
        description: String,
        properties: JSONObject,
        required: List<String>
    ): JSONObject {
        return JSONObject().apply {
            put("name", name)
            put("description", description)
            put("input_schema", JSONObject().apply {
                put("type", "object")
                put("properties", properties)
                put("required", JSONArray(required))
            })
        }
    }
}

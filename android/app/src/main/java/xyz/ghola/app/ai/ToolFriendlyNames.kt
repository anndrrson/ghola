package xyz.ghola.app.ai

import org.json.JSONObject

/**
 * Maps tool names + input params to human-friendly status text.
 */
object ToolFriendlyNames {

    private val PACKAGE_TO_NAME = mapOf(
        "com.android.chrome" to "Chrome",
        "com.android.settings" to "Settings",
        "com.google.android.apps.maps" to "Maps",
        "com.google.android.youtube" to "YouTube",
        "com.google.android.gm" to "Gmail",
        "com.google.android.apps.messaging" to "Messages",
        "com.google.android.dialer" to "Phone",
        "com.google.android.apps.photos" to "Photos",
        "com.google.android.calendar" to "Calendar",
        "com.whatsapp" to "WhatsApp",
        "com.instagram.android" to "Instagram",
        "com.twitter.android" to "X",
        "com.spotify.music" to "Spotify",
        "app.phantom" to "Phantom",
        "com.slack" to "Slack",
        "com.android.camera" to "Camera",
        "com.google.android.documentsui" to "Files",
        "com.google.android.deskclock" to "Clock",
        "com.android.vending" to "Play Store",
        "com.solanamobile.dappstore" to "dApp Store",
        "com.solanamobile.seedvault" to "Seed Vault",
        "com.solflare.mobile" to "Solflare"
    )

    fun describe(toolName: String, input: JSONObject): String = when (toolName) {
        "read_screen" -> "Looking at screen..."
        "smart_read" -> "Looking at screen..."
        "screenshot" -> "Taking screenshot..."
        "launch_app" -> {
            val pkg = input.optString("package", "")
            val name = PACKAGE_TO_NAME[pkg]
            if (name != null) "Opening $name..." else "Opening app..."
        }
        "tap" -> {
            val label = input.optString("text", "").ifEmpty {
                input.optString("text_contains", "").ifEmpty {
                    input.optString("desc", "")
                }
            }
            if (label.isNotEmpty()) "Tapping \"$label\"..." else "Tapping..."
        }
        "long_press" -> {
            val label = input.optString("text", "").ifEmpty {
                input.optString("text_contains", "").ifEmpty {
                    input.optString("desc", "")
                }
            }
            if (label.isNotEmpty()) "Long pressing \"$label\"..." else "Long pressing..."
        }
        "type_text" -> "Typing..."
        "press_back" -> "Going back..."
        "swipe" -> {
            val dir = input.optString("direction", "")
            if (dir.isNotEmpty()) "Swiping $dir..." else "Swiping..."
        }
        "scroll" -> {
            val dir = input.optString("direction", "down")
            "Scrolling $dir..."
        }
        "global_action" -> {
            when (input.optString("action", "")) {
                "home" -> "Going home..."
                "recents" -> "Opening recents..."
                "notifications" -> "Opening notifications..."
                else -> "Working..."
            }
        }
        "clipboard_set" -> "Copying to clipboard..."
        "clipboard_get" -> "Reading clipboard..."
        "device_info" -> "Checking device info..."
        "list_apps" -> "Listing apps..."
        "wait_for" -> "Waiting..."
        "execute_flow" -> "Running flow..."
        "list_flows" -> "Listing flows..."
        "read_notifications" -> "Reading notifications..."
        "dismiss_notification" -> "Dismissing notification..."
        "history" -> "Checking history..."
        else -> "Working..."
    }
}

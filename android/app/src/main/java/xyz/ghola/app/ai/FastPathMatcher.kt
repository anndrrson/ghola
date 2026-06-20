package xyz.ghola.app.ai

import android.util.Log
import org.json.JSONObject

data class FastMatch(
    val toolName: String,
    val input: JSONObject,
    val description: String
)

object FastPathMatcher {

    private const val TAG = "FastPath"

    private val APP_PACKAGES = mapOf(
        // Core Android apps
        "chrome" to "com.android.chrome",
        "browser" to "com.android.chrome",
        "settings" to "com.android.settings",
        "maps" to "com.google.android.apps.maps",
        "youtube" to "com.google.android.youtube",
        "gmail" to "com.google.android.gm",
        "email" to "com.google.android.gm",
        "messages" to "com.google.android.apps.messaging",
        "texts" to "com.google.android.apps.messaging",
        "sms" to "com.google.android.apps.messaging",
        "phone" to "com.google.android.dialer",
        "dialer" to "com.google.android.dialer",
        "photos" to "com.google.android.apps.photos",
        "calendar" to "com.google.android.calendar",
        "camera" to "com.android.camera",
        "files" to "com.google.android.documentsui",
        "clock" to "com.google.android.deskclock",
        "alarm" to "com.google.android.deskclock",
        "store" to "com.android.vending",
        "contacts" to "com.google.android.contacts",
        // Social
        "whatsapp" to "com.whatsapp",
        "instagram" to "com.instagram.android",
        "twitter" to "com.twitter.android",
        "x" to "com.twitter.android",
        "spotify" to "com.spotify.music",
        "slack" to "com.slack",
        "telegram" to "org.telegram.messenger",
        "signal" to "org.thoughtcrime.securesms",
        "discord" to "com.discord",
        "tiktok" to "com.zhiliaoapp.musically",
        "snapchat" to "com.snapchat.android",
        "reddit" to "com.reddit.frontpage",
        "facebook" to "com.facebook.katana",
        "messenger" to "com.facebook.orca",
        // Productivity & Lifestyle
        "uber" to "com.ubercab",
        "lyft" to "me.lyft.android",
        "doordash" to "com.dd.doordash",
        "venmo" to "com.venmo",
        "cashapp" to "com.squareup.cash",
        "netflix" to "com.netflix.mediaclient",
        "amazon" to "com.amazon.mShop.android.shopping",
        "notion" to "notion.id",
        // Solana Seeker / Crypto (always available, detected dynamically)
        "phantom" to "app.phantom",
        // Multi-word
        "google maps" to "com.google.android.apps.maps",
        "google chrome" to "com.android.chrome",
        "google photos" to "com.google.android.apps.photos",
        "play store" to "com.android.vending",
        "app store" to "com.android.vending",
        "dapp store" to "com.solanamobile.dappstore",
        "dappstore" to "com.solanamobile.dappstore",
        "dapp" to "com.solanamobile.dappstore",
        "solana dapp store" to "com.solanamobile.dappstore",
        "cash app" to "com.squareup.cash",
        "door dash" to "com.dd.doordash",
        "tik tok" to "com.zhiliaoapp.musically"
    )

    private val BACK_PATTERNS = setOf("go back", "back", "press back")

    private val HOME_PATTERNS = setOf("home", "go home")

    private val RECENTS_PATTERNS = setOf("recents", "recent apps", "show recents")

    private val NOTIFICATION_PATTERNS = setOf("notifications", "show notifications", "open notifications")

    private val READ_SCREEN_PATTERNS = setOf(
        "read screen", "what's on screen", "what's on my screen",
        "what do you see", "what do i see", "whats on screen",
        "whats on my screen", "read the screen"
    )

    private val SCREENSHOT_PATTERNS = setOf(
        "screenshot", "take a screenshot", "take screenshot",
        "capture screen", "screen capture"
    )

    private val SCROLL_PATTERNS = mapOf(
        "scroll down" to "down",
        "scroll up" to "up",
        "scroll left" to "left",
        "scroll right" to "right"
    )

    private val SWIPE_PATTERNS = mapOf(
        "swipe left" to "left",
        "swipe right" to "right",
        "swipe up" to "up",
        "swipe down" to "down"
    )

    private val TAP_PREFIXES = listOf("tap on ", "tap ", "click on ", "click ", "press on ", "press ")

    private val FILLER_PREFIXES = listOf(
        "go ahead and ", "i'd like to ", "i want to ", "i need to ",
        "can you ", "could you ", "would you ",
        "let's ", "lets ", "hey ", "just ", "please "
    )

    private val FILLER_SUFFIXES = listOf(
        " right now", " real quick", " quickly", " for me", " now", " please"
    )

    private val ARTICLES = listOf("the ", "my ", "a ", "an ")

    private const val DEFAULT_WALLET_PACKAGE = "com.solflare.mobile"

    private val WALLET_PATTERNS = setOf(
        "open my wallet", "open wallet", "open solana wallet",
        "open my solana wallet", "open crypto wallet",
        "wallet", "my wallet", "solana wallet", "crypto wallet"
    )

    fun match(text: String, walletPackage: String?): FastMatch? {
        val normalized = text.trim().lowercase().trimEnd('?', '!', '.', ',')
        Log.d(TAG, "match() input='$text' normalized='$normalized'")

        // Reject multi-step commands (but allow simple " and " — only reject sequencing)
        if (normalized.contains(" and then ") || normalized.contains(" then ") ||
            normalized.contains(" after that ")) {
            Log.d(TAG, "rejected: multi-step")
            return null
        }

        // Reject actual questions (not polite requests)
        if (normalized.startsWith("how ") || normalized.startsWith("what is") ||
            normalized.startsWith("why ") || normalized.startsWith("where ") ||
            normalized.startsWith("when ")) {
            Log.d(TAG, "rejected: question")
            return null
        }

        // Strip filler words to get the core command
        val core = stripFiller(normalized)
        Log.d(TAG, "core after filler strip='$core'")

        // Back
        if (core in BACK_PATTERNS) {
            return FastMatch("press_back", JSONObject(), "Going back...")
        }

        // Home
        if (core in HOME_PATTERNS) {
            return FastMatch(
                "global_action",
                JSONObject().put("action", "home"),
                "Going home..."
            )
        }

        // Recents
        if (core in RECENTS_PATTERNS) {
            return FastMatch(
                "global_action",
                JSONObject().put("action", "recents"),
                "Opening recents..."
            )
        }

        // Notifications
        if (core in NOTIFICATION_PATTERNS) {
            return FastMatch(
                "global_action",
                JSONObject().put("action", "notifications"),
                "Opening notifications..."
            )
        }

        // Read screen
        if (core in READ_SCREEN_PATTERNS) {
            return FastMatch("read_screen", JSONObject(), "Reading screen...")
        }

        // Screenshot
        if (core in SCREENSHOT_PATTERNS) {
            return FastMatch("screenshot", JSONObject(), "Taking screenshot...")
        }

        // Wallet (only if wallet package is set — meaning crypto is available/opt-in)
        if (walletPackage != null && core in WALLET_PATTERNS) {
            return FastMatch(
                "launch_app",
                JSONObject().put("package", walletPackage),
                "Opening wallet..."
            )
        }

        // "open {app}" / "launch {app}" / "start {app}" with multi-word support
        extractAppName(core)?.let { appName ->
            // Check wallet patterns first
            if (walletPackage != null && appName in setOf("wallet", "solana wallet", "crypto wallet")) {
                return FastMatch(
                    "launch_app",
                    JSONObject().put("package", walletPackage),
                    "Opening wallet..."
                )
            }
            APP_PACKAGES[appName]?.let { pkg ->
                return FastMatch(
                    "launch_app",
                    JSONObject().put("package", pkg),
                    "Opening $appName..."
                )
            }
        }

        // Tap — "tap on X", "click X", "press X" (not "press back")
        extractTapTarget(core)?.let { target ->
            return FastMatch(
                "tap",
                JSONObject().put("text_contains", target),
                "Tapping $target..."
            )
        }

        // Scroll
        SCROLL_PATTERNS[core]?.let { direction ->
            return FastMatch(
                "scroll",
                JSONObject().put("direction", direction),
                "Scrolling $direction..."
            )
        }

        // Swipe
        SWIPE_PATTERNS[core]?.let { direction ->
            return FastMatch(
                "swipe",
                JSONObject().put("direction", direction),
                "Swiping $direction..."
            )
        }

        Log.d(TAG, "no match for core='$core' → LLM")
        return null
    }

    private fun stripFiller(text: String): String {
        var result = text

        // Strip filler prefixes (may need multiple passes, e.g. "hey just open")
        var changed = true
        while (changed) {
            changed = false
            for (prefix in FILLER_PREFIXES) {
                if (result.startsWith(prefix)) {
                    result = result.removePrefix(prefix).trimStart()
                    changed = true
                    break
                }
            }
        }

        // Strip filler suffixes
        for (suffix in FILLER_SUFFIXES) {
            if (result.endsWith(suffix)) {
                result = result.removeSuffix(suffix).trimEnd()
                break
            }
        }

        return result
    }

    private fun stripArticles(text: String): String {
        var result = text
        for (article in ARTICLES) {
            if (result.startsWith(article)) {
                result = result.removePrefix(article)
                break
            }
        }
        return result
    }

    private fun extractAppName(text: String): String? {
        for (prefix in listOf("open ", "launch ", "start ", "go to ")) {
            if (text.startsWith(prefix)) {
                val raw = text.removePrefix(prefix).trim()
                if (raw.isEmpty()) return null
                // Strip articles: "the settings" → "settings", "my wallet" → "wallet"
                val name = stripArticles(raw)
                if (name.isEmpty()) return null
                return name
            }
        }
        return null
    }

    private fun extractTapTarget(text: String): String? {
        for (prefix in TAP_PREFIXES) {
            if (text.startsWith(prefix)) {
                val target = text.removePrefix(prefix).trim()
                if (target.isEmpty()) return null
                // "press back" is handled by BACK_PATTERNS, not tap
                if (target == "back") return null
                return stripArticles(target)
            }
        }
        return null
    }
}

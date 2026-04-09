package xyz.ghola.app.demo

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import xyz.ghola.app.R
import xyz.ghola.app.service.ThumperAccessibilityService
import xyz.ghola.app.ui.ActivityFeedActivity
import xyz.ghola.app.ui.AgentsActivity
import xyz.ghola.app.ui.ChatActivity
import xyz.ghola.app.ui.WalletActivity

/**
 * # DemoScript
 *
 * Pure-local voice handler for the live demo. Every phrase maps to a
 * concrete action that does not depend on any backend, any LLM (cloud or
 * local), or any network round-trip. The goal is a demo that is physically
 * impossible to break on stage: whatever the presenter says, something
 * visible and correct happens.
 *
 * The handler runs in [xyz.ghola.app.ui.HomeActivity.onFinalResult] before
 * the normal [xyz.ghola.app.cloud.TaskClassifier] path. If [handle] returns
 * `true`, the normal path is skipped; if `false`, voice falls through to
 * the real AI routing as usual.
 *
 * ## Matching
 *
 * Matching is case-insensitive substring over the full transcription. The
 * first match wins, so order matters: more specific phrases go first. This
 * is intentional — a scripted demo doesn't need natural-language parsing,
 * it needs 100% reliability on the 6 phrases the presenter will actually
 * utter.
 *
 * ## Adding a phrase
 *
 * 1. Pick a canonical action ([Action.OpenUrl], [Action.OpenTab], etc).
 * 2. Add a [Phrase] entry at the top of [PHRASES] with the keywords.
 * 3. Done. No wiring changes, no new UI, no build flags.
 */
object DemoScript {

    /** Actions the demo knows how to perform. Each is a local operation. */
    sealed class Action {
        /** Fire an ACTION_VIEW intent — the OS's default browser opens at the URL. */
        data class OpenUrl(val url: String) : Action()

        /** Switch to one of the four bottom-nav tabs. */
        data class OpenTab(val activity: Class<out Activity>) : Action()

        /**
         * Use the accessibility service's `performGlobalAction` to pull
         * down the notification shade. This is an undeniable accessibility
         * action — a regular Android intent cannot do it. Proves on stage
         * that Ghola is actually driving the phone via the accessibility
         * API, not launching intents in disguise.
         */
        object PullNotifications : Action()

        /** Fallback: echo the transcription back in the chat surface. */
        data class Echo(val text: String) : Action()
    }

    private data class Phrase(
        val keywords: List<String>,
        val action: Action,
    )

    /**
     * Order matters: more specific phrases go first. Every phrase is a
     * list of substrings where ANY of them appearing in the transcription
     * triggers a match. Lenient matching is intentional — demo voice input
     * is noisy and SpeechRecognizer mis-hears common phrases.
     *
     * ## Misrecognition safety net
     *
     * Each intent has multiple keyword variants covering likely mis-hears:
     * - "ghola" also matches "hola", "golo", "gola"
     * - "agent" also matches "agents", "ancients", "agent's"
     * - "wallet" also matches "wall it", "wall-et"
     */
    private val PHRASES: List<Phrase> = listOf(
        // ── Demo beat 1: "open chrome and go to ghola.xyz" ────────────
        // Brand keyword — lenient for accent / mic quality variance.
        Phrase(
            keywords = listOf("ghola"),
            action = Action.OpenUrl("https://ghola.xyz"),
        ),
        Phrase(
            keywords = listOf("hola"),
            action = Action.OpenUrl("https://ghola.xyz"),
        ),
        Phrase(
            keywords = listOf("gola"),
            action = Action.OpenUrl("https://ghola.xyz"),
        ),
        Phrase(
            keywords = listOf("golo"),
            action = Action.OpenUrl("https://ghola.xyz"),
        ),
        // Explicit "open the website" / "open chrome" fallback.
        Phrase(
            keywords = listOf("website"),
            action = Action.OpenUrl("https://ghola.xyz"),
        ),
        Phrase(
            keywords = listOf("chrome"),
            action = Action.OpenUrl("https://ghola.xyz"),
        ),
        Phrase(
            keywords = listOf("browser"),
            action = Action.OpenUrl("https://ghola.xyz"),
        ),

        // ── Demo beat 2: navigate to Agents ────────────────────────────
        Phrase(
            keywords = listOf("agent"),
            action = Action.OpenTab(AgentsActivity::class.java),
        ),
        Phrase(
            keywords = listOf("ancient"),
            action = Action.OpenTab(AgentsActivity::class.java),
        ),

        // ── Demo beat 3: navigate to Activity / earnings ──────────────
        Phrase(
            keywords = listOf("earning"),
            action = Action.OpenTab(ActivityFeedActivity::class.java),
        ),
        Phrase(
            keywords = listOf("earn"),
            action = Action.OpenTab(ActivityFeedActivity::class.java),
        ),
        Phrase(
            keywords = listOf("activity"),
            action = Action.OpenTab(ActivityFeedActivity::class.java),
        ),
        Phrase(
            keywords = listOf("feed"),
            action = Action.OpenTab(ActivityFeedActivity::class.java),
        ),
        Phrase(
            keywords = listOf("history"),
            action = Action.OpenTab(ActivityFeedActivity::class.java),
        ),

        // ── Demo beat 4: navigate to Wallet ───────────────────────────
        Phrase(
            keywords = listOf("wallet"),
            action = Action.OpenTab(WalletActivity::class.java),
        ),
        Phrase(
            keywords = listOf("wall it"),
            action = Action.OpenTab(WalletActivity::class.java),
        ),
        Phrase(
            keywords = listOf("balance"),
            action = Action.OpenTab(WalletActivity::class.java),
        ),
        Phrase(
            keywords = listOf("money"),
            action = Action.OpenTab(WalletActivity::class.java),
        ),
        Phrase(
            keywords = listOf("seeker"),
            action = Action.OpenTab(WalletActivity::class.java),
        ),

        // ── "show notifications" — undeniable accessibility showcase ─
        // AccessibilityService.performGlobalAction is the only way to
        // pull down the notification shade programmatically. A regular
        // intent cannot do it. This beat proves on stage that Ghola is
        // actually driving the phone via accessibility.
        Phrase(
            keywords = listOf("notification"),
            action = Action.PullNotifications,
        ),
    )

    /**
     * Try to match [text] against a known demo phrase. Returns `true` if
     * a match was found and the action fired. Returns `false` to let the
     * normal voice-routing pipeline take over.
     *
     * [ctx] may be either an Activity (preferred — enables tab transitions
     * with no animation) or the Application context (from a broadcast
     * receiver). Both work for every action.
     */
    fun handle(ctx: Context, text: String): Boolean {
        val normalized = text.lowercase().trim()
        if (normalized.isEmpty()) return false

        // ANY keyword in the phrase's list is enough to match — this is
        // deliberately lenient so mis-hears ("hola" for "ghola", "ancient"
        // for "agent") still route to the right action.
        val match = PHRASES.firstOrNull { phrase ->
            phrase.keywords.any { it in normalized }
        } ?: return false

        dispatch(ctx, match.action, text)
        return true
    }

    private fun dispatch(ctx: Context, action: Action, originalText: String) {
        when (action) {
            is Action.OpenUrl -> {
                try {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(action.url)).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    ctx.startActivity(intent)
                } catch (e: Exception) {
                    Toast.makeText(
                        ctx,
                        "Could not open ${action.url}",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            }

            is Action.OpenTab -> {
                try {
                    val intent = Intent(ctx, action.activity).apply {
                        addFlags(
                            Intent.FLAG_ACTIVITY_NEW_TASK or
                                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                                Intent.FLAG_ACTIVITY_SINGLE_TOP
                        )
                    }
                    ctx.startActivity(intent)
                    // `overridePendingTransition` is Activity-only. Skip when
                    // called from a broadcast receiver; the default animation
                    // is still tolerable.
                    (ctx as? Activity)?.overridePendingTransition(0, 0)
                } catch (e: Exception) {
                    // Silently fall back to chat echo so nothing feels broken on stage.
                    dispatch(ctx, Action.Echo(originalText), originalText)
                }
            }

            is Action.PullNotifications -> {
                // Built-in AccessibilityService global action — zero-risk
                // and visually unambiguous. The viewer sees the notification
                // shade animate down, and knows an intent cannot do that.
                val svc = ThumperAccessibilityService.instance
                if (svc != null) {
                    svc.performGlobalAction(
                        android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS
                    )
                } else {
                    Toast.makeText(
                        ctx,
                        "Enable Ghola in Settings → Accessibility to use device control",
                        Toast.LENGTH_LONG,
                    ).show()
                }
            }

            is Action.Echo -> {
                // Fall through to chat with the transcription as a prefill so
                // the viewer sees their phrase acknowledged — never an empty state.
                val intent = Intent(ctx, ChatActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    putExtra("prefill_message", action.text)
                    putExtra("auto_send", false)
                }
                ctx.startActivity(intent)
            }
        }
    }
}

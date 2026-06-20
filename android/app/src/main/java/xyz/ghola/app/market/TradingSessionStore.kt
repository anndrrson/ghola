package xyz.ghola.app.market

import android.content.Context
import org.json.JSONObject

class TradingSessionStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("ghola_trading_sessions", Context.MODE_PRIVATE)

    fun save(productId: String, session: JSONObject) {
        prefs.edit()
            .putString(sessionKey(productId), session.toString())
            .putBoolean(killKey(productId), false)
            .apply()
    }

    fun activeSession(productId: String): JSONObject? {
        if (prefs.getBoolean(killKey(productId), false)) return null
        val raw = prefs.getString(sessionKey(productId), null) ?: return null
        val json = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        val status = json.optString("status")
        if (status == "killed" || status == "blocked" || status == "expired" || status.isBlank()) return null
        val expiresAt = json.optString("expires_at").ifBlank {
            json.optJSONObject("session_policy")?.optString("expires_at").orEmpty()
        }
        if (expiresAt.isNotBlank() && expiresAt <= java.time.Instant.now().toString()) return null
        return json
    }

    fun kill(productId: String) {
        prefs.edit().putBoolean(killKey(productId), true).apply()
    }

    private fun sessionKey(productId: String): String = "session:${productId.uppercase()}"
    private fun killKey(productId: String): String = "killed:${productId.uppercase()}"
}

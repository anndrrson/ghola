package xyz.ghola.app.cloud

import android.util.Base64
import org.json.JSONObject

/**
 * Tiny JWT decoder for the access-token lifecycle. We only need the `exp`
 * claim client-side — full signature verification stays server-side. No third-
 * party dep: token strings are three base64url segments joined by `.` and the
 * middle one is JSON.
 *
 * Returns null on any malformed input rather than throwing, so callers can
 * treat "we don't know the expiry" as "assume soon-expiring."
 */
object JwtUtil {

    /** Skew window to absorb device clock drift vs server. */
    private const val DEFAULT_SKEW_SECONDS: Long = 60

    /** Unix-seconds expiry claim, or null if not present / malformed. */
    fun expirySeconds(token: String?): Long? {
        if (token.isNullOrBlank()) return null
        val parts = token.split('.')
        if (parts.size != 3) return null
        return try {
            val payload = Base64.decode(
                parts[1],
                Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
            )
            val json = JSONObject(String(payload, Charsets.UTF_8))
            val exp = json.optLong("exp", 0L)
            if (exp > 0L) exp else null
        } catch (_: Throwable) {
            null
        }
    }

    /**
     * True if `exp - now <= skew`. **Fail-OPEN** on decode errors: if the
     * token doesn't have a parseable `exp` claim, we treat it as not-expired
     * and let a real 401 from the server escalate. The alternative (fail-
     * closed) caused a sign-in loop when the backend hadn't yet been upgraded
     * to return refresh tokens — clients with valid JWTs but unparseable
     * payloads were being bounced back to SIWS on every resume.
     */
    fun isExpired(
        token: String?,
        nowSeconds: Long = System.currentTimeMillis() / 1000,
        skewSeconds: Long = DEFAULT_SKEW_SECONDS,
    ): Boolean {
        if (token.isNullOrBlank()) return true
        val exp = expirySeconds(token) ?: return false // fail-open
        return exp - nowSeconds <= skewSeconds
    }

    /**
     * True if `exp - now <= windowSeconds`. Used to trigger proactive refresh.
     * **Fail-OPEN** on decode errors so a token we can't read doesn't trigger
     * an unnecessary refresh attempt every foreground.
     */
    fun isExpiringWithin(
        token: String?,
        windowSeconds: Long,
        nowSeconds: Long = System.currentTimeMillis() / 1000,
    ): Boolean {
        if (token.isNullOrBlank()) return true
        val exp = expirySeconds(token) ?: return false // fail-open
        return exp - nowSeconds <= windowSeconds
    }
}

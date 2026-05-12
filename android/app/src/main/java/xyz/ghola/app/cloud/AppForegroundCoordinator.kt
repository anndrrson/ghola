package xyz.ghola.app.cloud

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import xyz.ghola.app.ai.SecureStorage
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Single decision point for "do we have valid cloud auth right now?"
 *
 * Two entry points:
 *  - [onAppForegrounded] — fire-and-forget. Called from ProcessLifecycleOwner
 *    when the app comes to the foreground. Silently refreshes the access JWT
 *    if it's within REFRESH_WINDOW_SECONDS of expiry. NEVER triggers an
 *    interactive wallet prompt — that's reserved for explicit sign-in flows
 *    and the 401 retry path.
 *  - [ensureAuthValid] — suspend. Called from activity startup paths. Returns
 *    true if the access token is valid (or was successfully refreshed),
 *    false if the user must re-SIWS.
 *
 * Replaces the old [ChatActivity.checkPrerequisites] cascade where every
 * onResume() would re-trigger [signInWithWallet] if [hasCloudAuth] was false.
 * That cascade is the user-reported "wallet keeps popping up" bug.
 */
object AppForegroundCoordinator {

    private const val TAG = "AppForegroundCoordinator"

    /** Trigger proactive refresh when access token within 24h of expiry. */
    private const val REFRESH_WINDOW_SECONDS: Long = 24L * 3600L

    /** Guard against concurrent refresh attempts. */
    private val refreshing = AtomicBoolean(false)

    /**
     * Fire-and-forget. Safe to call from any thread. If the access token is
     * within [REFRESH_WINDOW_SECONDS] of expiry, attempts a silent refresh on
     * a background coroutine. No-op if no token, or no refresh token, or a
     * refresh is already in flight.
     */
    @OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)
    fun onAppForegrounded(context: Context) {
        val appCtx = context.applicationContext
        GlobalScope.launch(Dispatchers.IO) {
            try {
                tryProactiveRefresh(appCtx)
            } catch (t: Throwable) {
                Log.w(TAG, "proactive refresh raised: ${t.message}")
            }
        }
    }

    /**
     * Returns true if cloud auth is usable RIGHT NOW. Performs a silent
     * refresh if the access token is expiring soon. Returns false if the
     * user must re-authenticate (no token, expired token + no refresh token,
     * or refresh failed).
     */
    suspend fun ensureAuthValid(context: Context): Boolean = withContext(Dispatchers.IO) {
        val storage = SecureStorage(context.applicationContext)
        val token = storage.getCloudAuthToken()

        if (token.isNullOrBlank()) {
            Log.i(TAG, "ensureAuthValid: no token")
            return@withContext false
        }

        // Drop stale tokens that have no refresh path.
        if (JwtUtil.isExpired(token) && !storage.hasCloudRefreshToken()) {
            Log.i(TAG, "ensureAuthValid: token expired and no refresh — clearing")
            storage.clearCloudAuth()
            return@withContext false
        }

        // Proactive refresh window: token is valid but soon to die. Try to
        // refresh; if it fails the existing token is still usable.
        if (JwtUtil.isExpiringWithin(token, REFRESH_WINDOW_SECONDS)) {
            tryProactiveRefresh(context.applicationContext)
        }

        // Re-read in case refresh just rotated it.
        return@withContext storage.hasCloudAuth() || storage.hasCloudRefreshToken()
    }

    /**
     * Single-flight refresh. Returns true if the access token is valid after
     * this call (either it was already valid and we no-op'd, or refresh
     * succeeded).
     */
    private suspend fun tryProactiveRefresh(context: Context): Boolean {
        if (!refreshing.compareAndSet(false, true)) {
            Log.d(TAG, "proactive refresh already in flight, skipping")
            return false
        }
        return try {
            val storage = SecureStorage(context)
            if (!storage.hasCloudRefreshToken()) {
                Log.d(TAG, "no refresh token; skipping")
                return false
            }
            val token = storage.getCloudAuthToken()
            if (token != null && !JwtUtil.isExpiringWithin(token, REFRESH_WINDOW_SECONDS)) {
                Log.d(TAG, "token not in refresh window; skipping")
                return true
            }
            val mgr = CloudAuthManager(context)
            val ok = mgr.refreshToken()
            Log.i(TAG, "proactive refresh: ${if (ok) "ok" else "failed"}")
            ok
        } finally {
            refreshing.set(false)
        }
    }
}

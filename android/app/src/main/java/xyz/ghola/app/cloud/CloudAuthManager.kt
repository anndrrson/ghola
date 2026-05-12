package xyz.ghola.app.cloud

import android.content.Context
import android.util.Log
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import xyz.ghola.app.ai.SecureStorage
import java.io.IOException

/**
 * Manages JWT auth with thumper-cloud.
 * v0.4 defaults to SIWS wallet auth; Google remains available for
 * backwards compatibility and optional linked-account paths.
 */
class CloudAuthManager(private val context: Context) {

    companion object {
        private const val TAG = "CloudAuth"
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }

    private val secureStorage = SecureStorage(context)
    private val client = OkHttpClient()
    private val siwsAuthFlow = SiwsAuthFlow(context)

    suspend fun signInWithWallet(
        sender: ActivityResultSender,
        walletPubkey: String
    ): AuthResult = siwsAuthFlow.signInWithWallet(sender, walletPubkey)

    /**
     * Exchange a Google ID token for a Thumper cloud JWT.
     * Called after Google Sign-In succeeds on the client.
     */
    fun signInWithGoogle(idToken: String): AuthResult {
        val baseUrl = secureStorage.getCloudBaseUrl()
        val body = JSONObject().apply {
            put("id_token", idToken)
        }

        val request = Request.Builder()
            .url("$baseUrl/api/auth/google")
            .post(body.toString().toRequestBody(JSON_MEDIA))
            .build()

        return try {
            val response = client.newCall(request).execute()
            val responseBody = response.body?.string()

            if (response.isSuccessful && responseBody != null) {
                val json = JSONObject(responseBody)
                val token = json.getString("token")
                val userId = json.getString("user_id")
                val isNewUser = json.optBoolean("is_new_user", false)

                // Store thumper-cloud credentials WITH exp + refresh token if
                // the server returned them (v0.4 backend) — these enable
                // proactive refresh + 401 retry without a wallet prompt.
                secureStorage.setCloudAuthToken(
                    token = token,
                    expSeconds = json.optLongOrNull("exp"),
                    refreshToken = json.optString("refresh_token", "").ifBlank { null },
                    refreshExpSeconds = json.optLongOrNull("refresh_exp"),
                )
                secureStorage.setCloudUserId(userId)

                Log.i(TAG, "Google sign-in succeeded, userId=$userId isNew=$isNewUser")

                // Phase M5: Mint a parallel said-cloud JWT from the same Google
                // ID token. said-cloud is a separate backend with its own user
                // table — the IDs won't match, but the user only signs in once.
                // Best-effort: if said-cloud is down, the agent surfaces will
                // be unavailable but chat/tasks still work.
                try {
                    val saidClient = SaidCloudClient(secureStorage.getSaidBaseUrl(), null)
                    val saidResp = saidClient.googleSignIn(idToken)
                    if (saidResp != null) {
                        secureStorage.setSaidToken(
                            token = saidResp.getString("token"),
                            expSeconds = saidResp.optLongOrNull("exp"),
                            refreshToken = saidResp.optString("refresh_token", "").ifBlank { null },
                            refreshExpSeconds = saidResp.optLongOrNull("refresh_exp"),
                        )
                        secureStorage.setSaidUserId(saidResp.getString("user_id"))
                        Log.i(TAG, "said-cloud sign-in succeeded")
                    } else {
                        Log.w(TAG, "said-cloud sign-in returned null — agents tab will be empty")
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "said-cloud sign-in failed (non-fatal): ${e.message}")
                }

                AuthResult.Success(token, userId, isNewUser)
            } else {
                Log.e(TAG, "Google sign-in failed: ${response.code} $responseBody")
                AuthResult.Error("Authentication failed: ${response.code}")
            }
        } catch (e: IOException) {
            Log.e(TAG, "Google sign-in error", e)
            AuthResult.Error("Network error: ${e.message}")
        }
    }

    /**
     * Refresh the thumper-cloud access JWT.
     *
     * Prefers the long-lived refresh token (single-use rotation, server-side).
     * Falls back to presenting the still-valid access JWT for legacy clients.
     * Persists the new access token, its `exp`, and (when rotation succeeded)
     * the new refresh token + its exp.
     *
     * Returns true on success, false on any failure path. Callers should not
     * surface failure as a user-visible error — let the next 401 escalate.
     */
    fun refreshToken(): Boolean {
        val baseUrl = secureStorage.getCloudBaseUrl()
        val refreshTok = secureStorage.getCloudRefreshToken()
        val accessTok = secureStorage.getCloudAuthToken()

        if (refreshTok.isNullOrBlank() && accessTok.isNullOrBlank()) {
            Log.w(TAG, "refreshToken: no credentials to present")
            return false
        }

        val body = JSONObject().apply {
            if (!refreshTok.isNullOrBlank()) {
                put("refresh_token", refreshTok)
            } else {
                put("token", accessTok)
            }
        }

        val request = Request.Builder()
            .url("$baseUrl/api/auth/refresh")
            .post(body.toString().toRequestBody(JSON_MEDIA))
            .build()

        return try {
            val response = client.newCall(request).execute()
            val responseBody = response.body?.string()

            if (response.isSuccessful && responseBody != null) {
                val json = JSONObject(responseBody)
                secureStorage.setCloudAuthToken(
                    token = json.getString("token"),
                    expSeconds = json.optLongOrNull("exp"),
                    refreshToken = json.optString("refresh_token", "").ifBlank { null },
                    refreshExpSeconds = json.optLongOrNull("refresh_exp"),
                )
                Log.i(TAG, "thumper-cloud token refresh succeeded")
                true
            } else {
                Log.e(TAG, "thumper-cloud refresh failed: ${response.code} $responseBody")
                false
            }
        } catch (e: IOException) {
            Log.e(TAG, "thumper-cloud refresh error", e)
            false
        }
    }

    /**
     * Refresh the said-cloud access JWT. Mirrors [refreshToken] against the
     * `/v1/auth/refresh` endpoint of said-cloud.
     */
    fun refreshSaidToken(): Boolean {
        val baseUrl = secureStorage.getSaidBaseUrl()
        val refreshTok = secureStorage.getSaidRefreshToken()
        val accessTok = secureStorage.getSaidToken()

        if (refreshTok.isNullOrBlank() && accessTok.isNullOrBlank()) {
            Log.w(TAG, "refreshSaidToken: no credentials to present")
            return false
        }

        val body = JSONObject().apply {
            if (!refreshTok.isNullOrBlank()) {
                put("refresh_token", refreshTok)
            } else {
                put("token", accessTok)
            }
        }

        val request = Request.Builder()
            .url("$baseUrl/auth/refresh")
            .post(body.toString().toRequestBody(JSON_MEDIA))
            .build()

        return try {
            val response = client.newCall(request).execute()
            val responseBody = response.body?.string()
            if (response.isSuccessful && responseBody != null) {
                val json = JSONObject(responseBody)
                secureStorage.setSaidToken(
                    token = json.getString("token"),
                    expSeconds = json.optLongOrNull("exp"),
                    refreshToken = json.optString("refresh_token", "").ifBlank { null },
                    refreshExpSeconds = json.optLongOrNull("refresh_exp"),
                )
                Log.i(TAG, "said-cloud token refresh succeeded")
                true
            } else {
                Log.e(TAG, "said-cloud refresh failed: ${response.code} $responseBody")
                false
            }
        } catch (e: IOException) {
            Log.e(TAG, "said-cloud refresh error", e)
            false
        }
    }

    fun signOut() {
        secureStorage.clearCloudAuth()
        secureStorage.clearSaidAuth()
        Log.i(TAG, "Signed out")
    }

    fun isSignedIn(): Boolean = secureStorage.hasCloudAuth()

    fun getCloudClient(): ThumperCloudClient? {
        val token = secureStorage.getCloudAuthToken() ?: return null
        return ThumperCloudClient(secureStorage.getCloudBaseUrl(), token)
    }

    sealed class AuthResult {
        data class Success(val token: String, val userId: String, val isNewUser: Boolean) : AuthResult()
        data class Error(val message: String) : AuthResult()
    }
}

/**
 * Read an optional unix-seconds claim from a JSONObject, returning null if
 * the key is missing or zero. Used to thread JWT/refresh expiry fields through
 * to [SecureStorage] without overwriting prior persisted values with garbage.
 */
internal fun JSONObject.optLongOrNull(key: String): Long? {
    if (!has(key)) return null
    val v = optLong(key, 0L)
    return if (v > 0L) v else null
}

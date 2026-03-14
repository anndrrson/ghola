package xyz.orni.thumper.cloud

import android.content.Context
import android.util.Log
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import xyz.orni.thumper.ai.SecureStorage
import java.io.IOException

/**
 * Manages Google Sign-In and JWT auth with thumper-cloud.
 * The Google Sign-In UI is handled by the Activity — this class
 * exchanges the ID token for a Thumper JWT.
 */
class CloudAuthManager(private val context: Context) {

    companion object {
        private const val TAG = "CloudAuth"
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }

    private val secureStorage = SecureStorage(context)
    private val client = OkHttpClient()

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

                // Store credentials
                secureStorage.setCloudAuthToken(token)
                secureStorage.setCloudUserId(userId)

                Log.i(TAG, "Google sign-in succeeded, userId=$userId isNew=$isNewUser")
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
     * Refresh the current JWT token.
     */
    fun refreshToken(): Boolean {
        val currentToken = secureStorage.getCloudAuthToken() ?: return false
        val baseUrl = secureStorage.getCloudBaseUrl()

        val body = JSONObject().apply {
            put("token", currentToken)
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
                secureStorage.setCloudAuthToken(json.getString("token"))
                true
            } else {
                Log.e(TAG, "Token refresh failed: ${response.code}")
                false
            }
        } catch (e: IOException) {
            Log.e(TAG, "Token refresh error", e)
            false
        }
    }

    fun signOut() {
        secureStorage.clearCloudAuth()
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

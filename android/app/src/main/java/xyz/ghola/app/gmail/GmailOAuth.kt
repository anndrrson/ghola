package xyz.ghola.app.gmail

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.activity.result.ActivityResult
import androidx.activity.result.ActivityResultLauncher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import net.openid.appauth.AuthorizationException
import net.openid.appauth.AuthorizationRequest
import net.openid.appauth.AuthorizationResponse
import net.openid.appauth.AuthorizationService
import net.openid.appauth.AuthorizationServiceConfiguration
import net.openid.appauth.ResponseTypeValues
import net.openid.appauth.TokenRequest
import net.openid.appauth.TokenResponse
import xyz.ghola.app.ai.SecureStorage
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * On-device Gmail OAuth 2.0 flow via AppAuth.
 *
 * Today's behavior: opens a Chrome Custom Tab pointing at Google's OAuth
 * authorization endpoint with `prompt=consent + access_type=offline + scope=
 * gmail.modify`. When the user approves, Google redirects back to the app via
 * an `app:` scheme intent filter (see AndroidManifest). AppAuth captures the
 * authorization code, this class exchanges it for `{access_token, refresh_token,
 * expires_in}`, and persists the pair to [SecureStorage].
 *
 * No server is involved. The refresh token lives on the device and is used
 * directly to refresh access tokens against `oauth2.googleapis.com`.
 *
 * This replaces the v0.4 path where the Gmail OAuth happened in a browser
 * redirect handled by `thumper-cloud` and the tokens lived server-side. The
 * v0.5 promise is "the user's email content never leaves the device" — so the
 * tokens that grant access to that content must also stay on-device.
 */
class GmailOAuth(private val context: Context) {

    companion object {
        private const val TAG = "GmailOAuth"

        // Google's discovery document. AppAuth fetches the auth + token
        // endpoints at runtime so we don't pin URLs that Google can rotate.
        private const val DISCOVERY_URI =
            "https://accounts.google.com/.well-known/openid-configuration"

        // Authorization scope — read, modify, send. Composed from Gmail's
        // canonical scope list. We don't request `mail.google.com` (the
        // legacy "everything") because it's broader than we need and triggers
        // a stronger consent dialog.
        private val SCOPES = arrayOf(
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.send",
            "https://www.googleapis.com/auth/gmail.modify",
            "openid",
            "email",
            "profile",
        )

        // Redirect URI must match the manifest's intent-filter scheme +
        // host. We use a custom scheme to bypass needing a hosted intent
        // receiver, which is safer for a wallet-bound app.
        const val REDIRECT_URI = "xyz.ghola.app.oauth://gmail-callback"

        // Google OAuth client id for the Android app. Source from
        // BuildConfig so debug builds and the release APK can carry separate
        // ids without recompiling.
        //
        // The client id is NOT secret on Android (mobile OAuth is the
        // public-client flow; no client secret is sent over the wire). The
        // PKCE code_verifier protects the exchange. Setting it via
        // BuildConfig keeps the file checkable into version control without
        // committing a value that's painful to rotate.
        private fun googleClientId(): String = xyz.ghola.app.BuildConfig.GOOGLE_OAUTH_CLIENT_ID
    }

    private val authService = AuthorizationService(context)
    private val secureStorage = SecureStorage(context)

    /**
     * Build the intent that launches Google's consent screen. Caller registers
     * an [ActivityResultLauncher] and passes the result back to [handleAuthResult].
     */
    suspend fun buildAuthIntent(): Intent = withContext(Dispatchers.IO) {
        val config = fetchServiceConfig()
        val request = AuthorizationRequest.Builder(
            config,
            googleClientId(),
            ResponseTypeValues.CODE,
            Uri.parse(REDIRECT_URI),
        )
            .setScopes(*SCOPES)
            // Forces a consent prompt + refresh_token issuance even on
            // returning users. Without this, Google only emits a refresh
            // token on the first authorization — re-authorizing for new
            // scopes leaves us with an access-token-only response.
            .setPrompt("consent")
            .setAdditionalParameters(mapOf("access_type" to "offline"))
            .build()
        authService.getAuthorizationRequestIntent(request)
    }

    /**
     * Handle the result of the consent intent. On success, persists access +
     * refresh tokens to [SecureStorage].
     */
    suspend fun handleAuthResult(result: ActivityResult): GmailAuthResult =
        withContext(Dispatchers.IO) {
            val data = result.data ?: return@withContext GmailAuthResult.Error(
                "Authorization returned no intent data"
            )
            val resp = AuthorizationResponse.fromIntent(data)
            val err = AuthorizationException.fromIntent(data)
            if (err != null) {
                Log.w(TAG, "AppAuth error: ${err.error} / ${err.errorDescription}")
                return@withContext GmailAuthResult.Error(
                    err.errorDescription ?: err.error ?: "OAuth failed"
                )
            }
            if (resp == null) {
                return@withContext GmailAuthResult.Error("No authorization response")
            }
            val tokenRequest: TokenRequest = resp.createTokenExchangeRequest()
            try {
                val tokenResp = exchangeToken(tokenRequest)
                if (tokenResp.accessToken.isNullOrBlank()) {
                    return@withContext GmailAuthResult.Error("Empty access token")
                }
                val refreshToken = tokenResp.refreshToken
                if (refreshToken.isNullOrBlank()) {
                    // Without a refresh token we can't refresh later. Treat
                    // as a failure rather than persisting an access-only set;
                    // the user can re-authorize.
                    return@withContext GmailAuthResult.Error(
                        "Google did not return a refresh token — try removing the app from " +
                            "your Google account's third-party apps list and retry."
                    )
                }
                val accessExpEpoch = tokenResp.accessTokenExpirationTime
                    ?: (System.currentTimeMillis() + 3600L * 1000L)
                secureStorage.setGmailTokens(
                    accessToken = tokenResp.accessToken!!,
                    accessExpEpochMillis = accessExpEpoch,
                    refreshToken = refreshToken,
                )
                Log.i(TAG, "Gmail OAuth succeeded — tokens persisted on-device")
                GmailAuthResult.Success
            } catch (t: Throwable) {
                Log.e(TAG, "Token exchange failed", t)
                GmailAuthResult.Error(t.message ?: "Token exchange failed")
            }
        }

    /**
     * Refresh the access token using the stored refresh token. Returns the
     * new access token, or null if the refresh failed (in which case the
     * caller should re-prompt the user to reauthorize).
     */
    suspend fun refreshAccessToken(): String? = withContext(Dispatchers.IO) {
        val refreshToken = secureStorage.getGmailRefreshToken() ?: return@withContext null
        val config = try {
            fetchServiceConfig()
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to fetch service config for refresh", t)
            return@withContext null
        }
        val request = TokenRequest.Builder(config, googleClientId())
            .setGrantType("refresh_token")
            .setRefreshToken(refreshToken)
            .build()
        try {
            val resp = exchangeToken(request)
            if (resp.accessToken.isNullOrBlank()) return@withContext null
            val accessExp = resp.accessTokenExpirationTime
                ?: (System.currentTimeMillis() + 3600L * 1000L)
            secureStorage.setGmailTokens(
                accessToken = resp.accessToken!!,
                accessExpEpochMillis = accessExp,
                // Google sometimes rotates the refresh token; if it issues a
                // new one, persist that too. Otherwise keep the existing.
                refreshToken = resp.refreshToken ?: refreshToken,
            )
            resp.accessToken
        } catch (t: Throwable) {
            Log.w(TAG, "Refresh token exchange failed", t)
            null
        }
    }

    private suspend fun fetchServiceConfig(): AuthorizationServiceConfiguration =
        suspendCancellableCoroutine { cont ->
            AuthorizationServiceConfiguration.fetchFromIssuer(
                Uri.parse("https://accounts.google.com"),
            ) { config, ex ->
                if (config != null) cont.resume(config)
                else cont.resumeWithException(
                    ex ?: RuntimeException("Failed to fetch OAuth config")
                )
            }
        }

    private suspend fun exchangeToken(req: TokenRequest): TokenResponse =
        suspendCancellableCoroutine { cont ->
            authService.performTokenRequest(req) { resp, ex ->
                if (resp != null) cont.resume(resp)
                else cont.resumeWithException(
                    ex ?: RuntimeException("Token exchange returned no response")
                )
            }
        }

    fun dispose() {
        authService.dispose()
    }

    sealed class GmailAuthResult {
        data object Success : GmailAuthResult()
        data class Error(val message: String) : GmailAuthResult()
    }
}

package xyz.ghola.app.cloud

import android.content.Context
import android.util.Base64
import android.util.Log
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.crypto.signWithWallet
import xyz.ghola.app.solana.MWAConnect
import java.io.IOException

/**
 * Wallet-only Sign-In With Solana flow for thumper-cloud.
 */
class SiwsAuthFlow(context: Context) {

    companion object {
        private const val TAG = "SiwsAuthFlow"
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }

    private val secureStorage = SecureStorage(context)
    private val client = OkHttpClient()

    suspend fun signInWithWallet(
        sender: ActivityResultSender,
        walletPubkey: String
    ): CloudAuthManager.AuthResult = withContext(Dispatchers.IO) {
        val baseUrl = secureStorage.getCloudBaseUrl()

        val challengeReq = Request.Builder()
            .url("$baseUrl/api/auth/siws/challenge")
            .get()
            .build()

        val challengeResp = try {
            client.newCall(challengeReq).execute()
        } catch (e: IOException) {
            Log.e(TAG, "SIWS challenge request failed", e)
            return@withContext CloudAuthManager.AuthResult.Error("Network error: ${e.message}")
        }

        val challengeBody = challengeResp.use { resp ->
            val body = resp.body?.string()
            if (!resp.isSuccessful || body.isNullOrBlank()) {
                Log.e(TAG, "SIWS challenge failed: ${resp.code} $body")
                return@withContext CloudAuthManager.AuthResult.Error("Failed to start wallet sign-in")
            }
            body
        }

        val challengeJson = JSONObject(challengeBody)
        val nonce = challengeJson.getString("nonce")
        val challenge = challengeJson.getString("challenge")

        val sig1 = when (val out = signWithWallet(sender, walletPubkey, challenge.toByteArray(Charsets.UTF_8))) {
            is MWAConnect.SignOutcome.Success -> out.signature
            MWAConnect.SignOutcome.NoWallet -> return@withContext CloudAuthManager.AuthResult.Error("No compatible wallet installed")
            MWAConnect.SignOutcome.Declined -> return@withContext CloudAuthManager.AuthResult.Error("Wallet declined the sign-in request")
            MWAConnect.SignOutcome.Cancelled -> return@withContext CloudAuthManager.AuthResult.Error("Wallet sign-in was cancelled")
            is MWAConnect.SignOutcome.Failure -> return@withContext CloudAuthManager.AuthResult.Error(out.cause.message ?: "Wallet signing failed")
        }

        val signatureB64 = Base64.encodeToString(sig1, Base64.NO_WRAP)
        val verifyBody = JSONObject().apply {
            put("wallet_pubkey", walletPubkey)
            put("nonce", nonce)
            put("challenge", challenge)
            put("signature", signatureB64)
        }
        val verifyReq = Request.Builder()
            .url("$baseUrl/api/auth/siws")
            .post(verifyBody.toString().toRequestBody(JSON_MEDIA))
            .build()

        val verifyResp = try {
            client.newCall(verifyReq).execute()
        } catch (e: IOException) {
            Log.e(TAG, "SIWS verify request failed", e)
            return@withContext CloudAuthManager.AuthResult.Error("Network error: ${e.message}")
        }

        verifyResp.use { resp ->
            val body = resp.body?.string()
            if (!resp.isSuccessful || body.isNullOrBlank()) {
                Log.e(TAG, "SIWS verify failed: ${resp.code} $body")
                return@withContext CloudAuthManager.AuthResult.Error("Wallet sign-in failed")
            }
            val json = JSONObject(body)
            val token = json.getString("token")
            val userId = json.getString("user_id")
            val isNewUser = json.optBoolean("is_new_user", false)

            // Persist with exp + refresh token so AppForegroundCoordinator
            // can do proactive non-interactive refresh on subsequent foreground
            // events. Falls back gracefully if the backend hasn't been updated
            // yet (older deploys return only `token` + `user_id`).
            secureStorage.setCloudAuthToken(
                token = token,
                expSeconds = json.optLongOrNull("exp"),
                refreshToken = json.optString("refresh_token", "").ifBlank { null },
                refreshExpSeconds = json.optLongOrNull("refresh_exp"),
            )
            secureStorage.setCloudUserId(userId)

            // Best effort: mint a parallel said-cloud JWT from the same SIWS
            // proof so agent ownership surfaces work for wallet-only users.
            try {
                val saidClient = SaidCloudClient(secureStorage.getSaidBaseUrl(), null)
                val saidResp = saidClient.siwsSignIn(walletPubkey, nonce, challenge, sig1)
                if (saidResp != null) {
                    secureStorage.setSaidToken(
                        token = saidResp.getString("token"),
                        expSeconds = saidResp.optLongOrNull("exp"),
                        refreshToken = saidResp.optString("refresh_token", "").ifBlank { null },
                        refreshExpSeconds = saidResp.optLongOrNull("refresh_exp"),
                    )
                    secureStorage.setSaidUserId(saidResp.getString("user_id"))
                    Log.i(TAG, "said-cloud SIWS sign-in succeeded")
                } else {
                    Log.w(TAG, "said-cloud SIWS sign-in returned null")
                }
            } catch (e: Exception) {
                Log.w(TAG, "said-cloud SIWS sign-in failed (non-fatal): ${e.message}")
            }

            CloudAuthManager.AuthResult.Success(token, userId, isNewUser)
        }
    }
}

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

        // Determinism guard: sign the exact same challenge twice.
        val sig1 = when (val out = signWithWallet(sender, walletPubkey, challenge.toByteArray(Charsets.UTF_8))) {
            is MWAConnect.SignOutcome.Success -> out.signature
            MWAConnect.SignOutcome.NoWallet -> return@withContext CloudAuthManager.AuthResult.Error("No compatible wallet installed")
            MWAConnect.SignOutcome.Declined -> return@withContext CloudAuthManager.AuthResult.Error("Wallet declined the sign-in request")
            MWAConnect.SignOutcome.Cancelled -> return@withContext CloudAuthManager.AuthResult.Error("Wallet sign-in was cancelled")
            is MWAConnect.SignOutcome.Failure -> return@withContext CloudAuthManager.AuthResult.Error(out.cause.message ?: "Wallet signing failed")
        }
        val sig2 = when (val out = signWithWallet(sender, walletPubkey, challenge.toByteArray(Charsets.UTF_8))) {
            is MWAConnect.SignOutcome.Success -> out.signature
            else -> return@withContext CloudAuthManager.AuthResult.Error("Wallet must produce stable signatures for SIWS")
        }
        if (!sig1.contentEquals(sig2)) {
            return@withContext CloudAuthManager.AuthResult.Error("Wallet returned non-deterministic signatures")
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

            secureStorage.setCloudAuthToken(token)
            secureStorage.setCloudUserId(userId)

            CloudAuthManager.AuthResult.Success(token, userId, isNewUser)
        }
    }
}

package xyz.ghola.app.cloud

import android.content.Context
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
import xyz.ghola.app.crypto.SigningDomains
import xyz.ghola.app.crypto.signWithWallet
import xyz.ghola.app.solana.MWAConnect
import java.io.IOException
import java.util.Base64

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
        signInWithSigner(walletPubkey) { challengeBytes ->
            when (val out = signWithWallet(sender, walletPubkey, challengeBytes, secureStorage.getMwaAuthToken())) {
                is MWAConnect.SignOutcome.Success -> DeviceSignResult.Success(out.signature)
                MWAConnect.SignOutcome.NoWallet -> DeviceSignResult.NoSigner
                MWAConnect.SignOutcome.Declined -> DeviceSignResult.Declined
                MWAConnect.SignOutcome.Cancelled -> DeviceSignResult.Cancelled
                is MWAConnect.SignOutcome.Failure -> DeviceSignResult.Failure(out.cause)
            }
        }
    }

    suspend fun signInWithDeviceSigner(signer: DeviceSigner): CloudAuthManager.AuthResult =
        signInWithSigner(signer.identity.address) { challengeBytes -> signer.sign(challengeBytes) }

    private suspend fun signInWithSigner(
        walletPubkey: String,
        sign: suspend (ByteArray) -> DeviceSignResult,
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

        // Cross-context-signature guard (H1). The wallet is about to sign these
        // exact bytes; the SigningDomains registry only guarantees the SIWS
        // domain is prefix-free vs the vault-unlock / agent-root / shielded
        // challenges if the server-minted challenge actually begins with the
        // registered SIWS prefix. A compromised/MITM'd cloud (e.g. before the
        // first-party TLS pins are activated) could otherwise return arbitrary
        // bytes for the wallet to sign. Refuse anything that doesn't carry the
        // expected sign-in prefix so a SIWS popup can never be turned into a
        // signature over another flow's key-deriving challenge.
        if (!challenge.startsWith(SigningDomains.SIWS_SIGN_IN)) {
            Log.e(TAG, "SIWS challenge missing expected sign-in prefix; refusing to sign")
            return@withContext CloudAuthManager.AuthResult.Error("Wallet sign-in failed: unexpected challenge")
        }

        val challengeBytes = challenge.toByteArray(Charsets.UTF_8)
        val sig1 = when (val out = sign(challengeBytes)) {
            is DeviceSignResult.Success -> out.signature
            DeviceSignResult.NoSigner -> return@withContext CloudAuthManager.AuthResult.Error("No compatible signer installed")
            DeviceSignResult.Declined -> return@withContext CloudAuthManager.AuthResult.Error("Sign-in request declined")
            DeviceSignResult.Cancelled -> return@withContext CloudAuthManager.AuthResult.Error("Sign-in was cancelled")
            is DeviceSignResult.Failure -> return@withContext CloudAuthManager.AuthResult.Error(out.cause.message ?: "Signing failed")
        }
        val signatureB64 = Base64.getEncoder().encodeToString(sig1)
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

            // The reviewed user journey promises one wallet approval. said-cloud
            // accepts the same SIWS payload shape, so reuse the already-approved
            // signature and populate agent auth before returning success.
            val saidJson = try {
                SaidCloudClient(secureStorage.getSaidBaseUrl(), null)
                    .siwsSignIn(walletPubkey, nonce, challenge, sig1)
            } catch (e: Exception) {
                Log.e(TAG, "said-cloud SIWS request failed", e)
                null
            }
            if (saidJson == null) {
                return@withContext CloudAuthManager.AuthResult.Error(
                    "Wallet sign-in failed for agents. Please try again."
                )
            }
            val saidToken = saidJson.optString("token", "")
            val saidUserId = saidJson.optString("user_id", "")
            if (saidToken.isBlank() || saidUserId.isBlank()) {
                Log.e(TAG, "said-cloud SIWS returned incomplete auth payload: $saidJson")
                return@withContext CloudAuthManager.AuthResult.Error(
                    "Wallet sign-in failed for agents. Please try again."
                )
            }

            secureStorage.setCloudAuthToken(
                token = token,
                expSeconds = json.optLongOrNull("exp"),
                refreshToken = json.optString("refresh_token", "").ifBlank { null },
                refreshExpSeconds = json.optLongOrNull("refresh_exp"),
            )
            secureStorage.setCloudUserId(userId)
            secureStorage.setSaidToken(
                token = saidToken,
                expSeconds = saidJson.optLongOrNull("exp"),
                refreshToken = saidJson.optString("refresh_token", "").ifBlank { null },
                refreshExpSeconds = saidJson.optLongOrNull("refresh_exp"),
            )
            secureStorage.setSaidUserId(saidUserId)

            CloudAuthManager.AuthResult.Success(token, userId, isNewUser)
        }
    }
}

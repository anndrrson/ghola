package xyz.ghola.app.cloud

import android.util.Log
import android.util.Base64
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * REST client for the said-cloud server (port 8080 — separate from thumper-cloud).
 *
 * said-cloud owns the agent ownership product (the /v1/agents endpoints) added in Phases 1-3
 * of the Ghola web build. Mobile users authenticate against said-cloud using
 * Google Sign-In (Phase M1: `POST /v1/auth/google`), then use the resulting
 * `said_cloud_token` to manage their cryptographically-owned AI agents.
 *
 * This client is INTENTIONALLY parallel to [ThumperCloudClient] rather than
 * unified — said-cloud and thumper-cloud are separate Postgres databases with
 * separate JWT secrets and separate user-ID spaces. The Android app holds two
 * tokens (one per backend) and decides per-call which client to use.
 */
class SaidCloudClient private constructor(
    private val baseUrl: String,
    private val tokenProvider: () -> String?,
    private val tokenRefresher: (() -> Boolean)?,
    private val onAuthExhausted: (() -> Unit)?,
) {

    /** Legacy constructor: static token, no refresh path. */
    constructor(baseUrl: String, authToken: String?) : this(
        baseUrl = baseUrl,
        tokenProvider = { authToken },
        tokenRefresher = null,
        onAuthExhausted = null,
    )
    data class SiwsChallenge(
        val nonce: String,
        val challenge: String
    )

    companion object {
        private const val TAG = "SaidCloud"
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
        const val DEFAULT_BASE_URL = "https://ghola-api.onrender.com/v1"

        /**
         * Construct a client that lazily reads the said-cloud access token and
         * silently refreshes on 401 before retrying once. Mirrors
         * `ThumperCloudClient.withRefresh`. Wire the refresher to
         * `CloudAuthManager(ctx).refreshSaidToken()`.
         */
        fun withRefresh(
            baseUrl: String,
            tokenProvider: () -> String?,
            tokenRefresher: () -> Boolean,
            onAuthExhausted: () -> Unit = {},
        ): SaidCloudClient = SaidCloudClient(
            baseUrl = baseUrl,
            tokenProvider = tokenProvider,
            tokenRefresher = tokenRefresher,
            onAuthExhausted = onAuthExhausted,
        )
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    // --- Auth ---

    /**
     * POST /v1/auth/google — exchange a Google ID token for a said-cloud JWT.
     * Mirrors thumper-cloud's google_sign_in flow but mints a separate token
     * scoped to said-cloud's user table. Idempotent: returning users get
     * their existing user_id back.
     */
    fun googleSignIn(idToken: String): JSONObject? {
        val body = JSONObject().apply { put("id_token", idToken) }
        return postUnauthenticated("/auth/google", body)
    }

    /** GET /v1/auth/siws/challenge */
    fun siwsChallenge(): SiwsChallenge? {
        val json = getUnauthenticated("/auth/siws/challenge") ?: return null
        return try {
            SiwsChallenge(
                nonce = json.getString("nonce"),
                challenge = json.getString("challenge")
            )
        } catch (e: Exception) {
            Log.e(TAG, "Invalid SIWS challenge payload", e)
            null
        }
    }

    /** POST /v1/auth/siws */
    fun siwsSignIn(walletPubkey: String, nonce: String, challenge: String, signature: ByteArray): JSONObject? {
        val body = JSONObject().apply {
            put("wallet_pubkey", walletPubkey)
            put("nonce", nonce)
            put("challenge", challenge)
            put("signature", Base64.encodeToString(signature, Base64.NO_WRAP))
        }
        return postUnauthenticated("/auth/siws", body)
    }

    // --- Agents (multi-agent ownership, Phase 2 backend) ---

    /** GET /v1/agents — list all agents owned by the authenticated user. */
    fun listAgents(): JSONArray? = getArray("/agents")

    /** GET /v1/agents/{id} — full detail with wallet, service count, reputation. */
    fun getAgent(id: String): JSONObject? = get("/agents/$id")

    /**
     * POST /v1/agents.
     *
     * Legacy clients omit the client-owned identity fields and said-cloud
     * generates the public identity. Seeker clients send a locally-derived
     * public key plus a signature proof, so the agent secret never exists on
     * the server.
     */
    fun createAgent(
        slug: String,
        displayName: String,
        bio: String? = null,
        avatarUrl: String? = null,
        clientPubkey: String? = null,
        clientDid: String? = null,
        clientIdentityMessage: String? = null,
        clientIdentitySignature: String? = null,
    ): JSONObject? {
        val body = JSONObject().apply {
            put("slug", slug)
            put("display_name", displayName)
            if (bio != null) put("bio", bio)
            if (avatarUrl != null) put("avatar_url", avatarUrl)
            if (clientPubkey != null) put("client_pubkey", clientPubkey)
            if (clientDid != null) put("client_did", clientDid)
            if (clientIdentityMessage != null) put("client_identity_message", clientIdentityMessage)
            if (clientIdentitySignature != null) put("client_identity_signature", clientIdentitySignature)
        }
        return post("/agents", body)
    }

    /** POST /v1/chat/agents — stores opaque E2E-encrypted private agent config. */
    fun createEncryptedChatAgent(
        encryptedConfig: String,
        publicAgentId: String? = null,
        displayOrder: Int = 0,
    ): JSONObject? {
        val body = JSONObject().apply {
            put("encrypted_config", encryptedConfig)
            if (!publicAgentId.isNullOrEmpty()) put("public_agent_id", publicAgentId)
            put("display_order", displayOrder)
        }
        return post("/chat/agents", body)
    }

    /** PATCH /v1/agents/{id} — update display fields and/or status. */
    fun updateAgent(id: String, displayName: String? = null, bio: String? = null, avatarUrl: String? = null, status: String? = null): JSONObject? {
        val body = JSONObject().apply {
            if (displayName != null) put("display_name", displayName)
            if (bio != null) put("bio", bio)
            if (avatarUrl != null) put("avatar_url", avatarUrl)
            if (status != null) put("status", status)
        }
        return patch("/agents/$id", body)
    }

    /** DELETE /v1/agents/{id} — soft-archive (status='archived'). */
    fun archiveAgent(id: String): Boolean = delete("/agents/$id")

    /** GET /v1/agents/{id}/wallet — wallet info for the agent. */
    fun getAgentWallet(id: String): JSONObject? = get("/agents/$id/wallet")

    /** GET /v1/agents/{id}/services — services owned by this agent. */
    fun listAgentServices(id: String): JSONArray? = getArray("/agents/$id/services")

    /** POST /v1/agents/{id}/services — register a new service listing under this agent. */
    fun createAgentService(
        id: String,
        name: String,
        slug: String,
        baseUrl: String,
        priceMicroUsdc: Long = 0,
        description: String? = null,
        category: String? = null
    ): JSONObject? {
        val body = JSONObject().apply {
            put("name", name)
            put("slug", slug)
            put("base_url", baseUrl)
            put("price_micro_usdc", priceMicroUsdc)
            if (description != null) put("description", description)
            if (category != null) put("category", category)
        }
        return post("/agents/$id/services", body)
    }

    /** GET /v1/agents/{id}/reputation — on-chain reputation score keyed by agent DID. */
    fun getAgentReputation(id: String): JSONObject? = get("/agents/$id/reputation")

    /** GET /v1/agents/{id}/earnings — USDC totals from payment_transactions. */
    fun getAgentEarnings(id: String): JSONObject? = get("/agents/$id/earnings")

    // --- HTTP helpers ---

    private fun authedBuilder(path: String, token: String?): Request.Builder {
        val b = Request.Builder().url("$baseUrl$path")
        if (!token.isNullOrEmpty()) {
            b.header("Authorization", "Bearer $token")
        }
        return b
    }

    /**
     * Run [build] with the current token. On 401 with a refresher configured,
     * call [tokenRefresher] once and retry. See [ThumperCloudClient.withAuthRetry]
     * for the rationale.
     */
    private inline fun <T : Any> withAuthRetry(
        path: String,
        method: String,
        crossinline build: (token: String?) -> Request,
        crossinline parse: (String) -> T?,
    ): T? {
        val token = tokenProvider()
        val first = try {
            client.newCall(build(token)).execute()
        } catch (e: IOException) {
            Log.e(TAG, "$method $path error", e)
            return null
        }
        val firstBody = first.body?.string()
        if (first.isSuccessful && firstBody != null) {
            return parse(firstBody)
        }
        if (first.code != 401 || tokenRefresher == null) {
            Log.e(TAG, "$method $path failed: ${first.code} $firstBody")
            return null
        }
        Log.i(TAG, "$method $path: 401, attempting silent refresh")
        val refreshed = try {
            tokenRefresher.invoke()
        } catch (t: Throwable) {
            Log.w(TAG, "refresh raised: ${t.message}")
            false
        }
        if (!refreshed) {
            onAuthExhausted?.invoke()
            return null
        }
        val second = try {
            client.newCall(build(tokenProvider())).execute()
        } catch (e: IOException) {
            Log.e(TAG, "$method $path retry error", e)
            return null
        }
        val secondBody = second.body?.string()
        if (second.isSuccessful && secondBody != null) {
            return parse(secondBody)
        }
        Log.e(TAG, "$method $path retry failed: ${second.code} $secondBody")
        if (second.code == 401) onAuthExhausted?.invoke()
        return null
    }

    private fun get(path: String): JSONObject? = withAuthRetry(
        path = path,
        method = "GET",
        build = { token -> authedBuilder(path, token).get().build() },
        parse = { body -> JSONObject(body) },
    )

    private fun getArray(path: String): JSONArray? = withAuthRetry(
        path = path,
        method = "GET",
        build = { token -> authedBuilder(path, token).get().build() },
        parse = { body -> JSONArray(body) },
    )

    private fun post(path: String, json: JSONObject): JSONObject? = withAuthRetry(
        path = path,
        method = "POST",
        build = { token ->
            authedBuilder(path, token)
                .post(json.toString().toRequestBody(JSON_MEDIA))
                .build()
        },
        parse = { body -> JSONObject(body) },
    )

    private fun postUnauthenticated(path: String, json: JSONObject): JSONObject? {
        val req = Request.Builder()
            .url("$baseUrl$path")
            .post(json.toString().toRequestBody(JSON_MEDIA))
            .build()
        return executeJson(req, "POST(unauth) $path")
    }

    private fun getUnauthenticated(path: String): JSONObject? {
        val req = Request.Builder()
            .url("$baseUrl$path")
            .get()
            .build()
        return executeJson(req, "GET(unauth) $path")
    }

    private fun patch(path: String, json: JSONObject): JSONObject? = withAuthRetry(
        path = path,
        method = "PATCH",
        build = { token ->
            authedBuilder(path, token)
                .patch(json.toString().toRequestBody(JSON_MEDIA))
                .build()
        },
        parse = { body -> JSONObject(body) },
    )

    private fun delete(path: String): Boolean {
        // Single-attempt: DELETE has no body to parse, and retrying after a
        // failed refresh adds little signal. If the user is unauthed we return
        // false and the caller surfaces it.
        val token = tokenProvider()
        val req = authedBuilder(path, token).delete().build()
        return try {
            val resp = client.newCall(req).execute()
            if (resp.code == 401 && tokenRefresher != null) {
                val refreshed = try { tokenRefresher.invoke() } catch (_: Throwable) { false }
                if (refreshed) {
                    val retry = client.newCall(authedBuilder(path, tokenProvider()).delete().build())
                        .execute()
                    if (retry.code == 401) onAuthExhausted?.invoke()
                    return retry.isSuccessful
                }
                onAuthExhausted?.invoke()
            }
            if (!resp.isSuccessful) {
                Log.e(TAG, "DELETE $path failed: ${resp.code} ${resp.body?.string()}")
            }
            resp.isSuccessful
        } catch (e: IOException) {
            Log.e(TAG, "DELETE $path error", e)
            false
        }
    }

    private fun executeJson(req: Request, label: String): JSONObject? {
        return try {
            val resp = client.newCall(req).execute()
            val body = resp.body?.string()
            if (resp.isSuccessful && body != null) {
                JSONObject(body)
            } else {
                Log.e(TAG, "$label failed: ${resp.code} $body")
                null
            }
        } catch (e: IOException) {
            Log.e(TAG, "$label error", e)
            null
        }
    }
}

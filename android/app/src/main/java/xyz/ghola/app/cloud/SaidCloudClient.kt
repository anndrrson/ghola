package xyz.ghola.app.cloud

import android.util.Log
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
class SaidCloudClient(
    private val baseUrl: String,
    private val authToken: String?
) {
    companion object {
        private const val TAG = "SaidCloud"
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
        const val DEFAULT_BASE_URL = "https://ghola-api.onrender.com/v1"
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

    /**
     * Anonymous bootstrap. Registers a throwaway said-cloud account with
     * a randomized email + password so the device can get a valid JWT
     * without making the user sit through Google Sign-In on first launch.
     * Returns `(token, userId)` on success, null on failure.
     *
     * The resulting account is a real `users` row in said-cloud's database
     * and behaves identically to a Google-signed user for all downstream
     * flows (agents, challenges, mutations). The random email never hits
     * a mailbox — it's just a uniqueness key.
     *
     * Used by [xyz.ghola.app.ui.CreateAgentActivity] when the user taps
     * Create Agent without having signed in yet, so first-time agent
     * creation "just works" on a fresh install. A future build can
     * upgrade the anonymous account to a real one via email linking.
     */
    data class AnonRegistration(val token: String, val userId: String, val email: String)

    fun registerAnon(): AnonRegistration? {
        val rand = java.util.UUID.randomUUID().toString().replace("-", "").take(16)
        val email = "anon-$rand@ghola.device"
        // Password is a random 32-char string that's never sent anywhere
        // after this call — the token we get back is the only thing we
        // need. Making it long so the server's argon2 hash is meaningful
        // even though we'll never use the password-login path.
        val password = java.util.UUID.randomUUID().toString() +
            java.util.UUID.randomUUID().toString()
        val body = JSONObject().apply {
            put("email", email)
            put("password", password)
            put("business_name", "Ghola Mobile")
            put("category", "mobile")
            put("website", "https://ghola.xyz")
        }
        val resp = postUnauthenticated("/auth/register", body) ?: return null
        val token = resp.optString("token", "")
        val userId = resp.optString("user_id", "")
        if (token.isEmpty() || userId.isEmpty()) {
            Log.e(TAG, "register response missing token or user_id: $resp")
            return null
        }
        return AnonRegistration(token = token, userId = userId, email = email)
    }

    // --- Agents (multi-agent ownership, Phase 2 backend) ---

    /** GET /v1/agents — list all agents owned by the authenticated user. */
    fun listAgents(): JSONArray? = getArray("/agents")

    /** GET /v1/agents/{id} — full detail with wallet, service count, reputation. */
    fun getAgent(id: String): JSONObject? = get("/agents/$id")

    /**
     * Challenge response from `POST /v1/agents/challenge`. The nonce is a
     * base64-encoded 32-byte random value generated server-side and tied to
     * the submitted pubkey; `expiresAt` is an RFC3339 timestamp (currently
     * unused client-side but carried through for diagnostics / future use).
     */
    data class AgentChallenge(val nonceBase64: String, val expiresAt: String)

    /**
     * POST /v1/agents/challenge — request a fresh nonce for the given
     * master pubkey. The server persists the nonce keyed by pubkey with a
     * short TTL; the caller signs the raw decoded bytes with their Seed
     * Vault key and includes the signature in the subsequent
     * [createAgentSigned] call.
     *
     * Returns null on any HTTP failure (network, 401, 429, etc). The caller
     * should surface a generic error in that case — the underlying reason
     * is logged at the TAG level but deliberately not returned, because the
     * UI doesn't need to distinguish rate-limit from auth-failure (both
     * require the user to retry).
     */
    fun requestAgentChallenge(masterPubkeyBase58: String): AgentChallenge? {
        val body = JSONObject().apply {
            put("master_pubkey_base58", masterPubkeyBase58)
        }
        val resp = post("/agents/challenge", body) ?: return null
        val nonce = resp.optString("nonce_base64", "")
        val expires = resp.optString("expires_at", "")
        if (nonce.isEmpty()) {
            Log.e(TAG, "challenge response missing nonce_base64: $resp")
            return null
        }
        return AgentChallenge(nonceBase64 = nonce, expiresAt = expires)
    }

    /**
     * POST /v1/agents (upgraded, signed variant) — create a new agent bound
     * to a caller-supplied master pubkey, with a signature proving the
     * client controls the corresponding private key. Server validates:
     *   - pubkey length (32 bytes once base58-decoded)
     *   - signature length (64 bytes once base64-decoded)
     *   - signature verifies via ed25519 `verify_strict` over the raw nonce
     *   - challenge has not expired
     *   - challenge has not already been consumed
     *   - challenge was issued for the same pubkey being submitted
     *
     * On success returns the full agent JSON (same shape as the old
     * [createAgent]). On failure returns null and logs the HTTP code.
     * Callers that need the server error message should fall back to the
     * raw HTTP response via the /agents endpoint with curl for diagnostics.
     */
    fun createAgentSigned(
        slug: String,
        displayName: String,
        bio: String?,
        masterPubkeyBase58: String,
        challengeNonceBase64: String,
        signatureBase64: String,
    ): JSONObject? {
        val body = JSONObject().apply {
            put("slug", slug)
            put("display_name", displayName)
            if (bio != null) put("bio", bio)
            put("master_pubkey_base58", masterPubkeyBase58)
            put("challenge_nonce_base64", challengeNonceBase64)
            put("signature_base64", signatureBase64)
        }
        return post("/agents", body)
    }

    /** POST /v1/agents — legacy unsigned variant. Kept for backward
     *  compatibility with callers that haven't been migrated to the signed
     *  flow yet. The backend now requires all six fields (pubkey + nonce +
     *  signature), so this method will almost certainly 400 in production.
     *  New callers should use [createAgentSigned] via the challenge flow. */
    fun createAgent(
        slug: String,
        displayName: String,
        bio: String? = null,
        avatarUrl: String? = null,
        masterPubkeyBase58: String? = null,
    ): JSONObject? {
        val body = JSONObject().apply {
            put("slug", slug)
            put("display_name", displayName)
            if (bio != null) put("bio", bio)
            if (avatarUrl != null) put("avatar_url", avatarUrl)
            if (masterPubkeyBase58 != null) put("master_pubkey_base58", masterPubkeyBase58)
        }
        return post("/agents", body)
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

    private fun get(path: String): JSONObject? {
        val req = authedBuilder(path).get().build()
        return executeJson(req, "GET $path")
    }

    private fun getArray(path: String): JSONArray? {
        val req = authedBuilder(path).get().build()
        return try {
            val resp = client.newCall(req).execute()
            val body = resp.body?.string()
            if (resp.isSuccessful && body != null) {
                JSONArray(body)
            } else {
                Log.e(TAG, "GET $path failed: ${resp.code} $body")
                null
            }
        } catch (e: IOException) {
            Log.e(TAG, "GET $path error", e)
            null
        }
    }

    private fun post(path: String, json: JSONObject): JSONObject? {
        val req = authedBuilder(path)
            .post(json.toString().toRequestBody(JSON_MEDIA))
            .build()
        return executeJson(req, "POST $path")
    }

    private fun postUnauthenticated(path: String, json: JSONObject): JSONObject? {
        val req = Request.Builder()
            .url("$baseUrl$path")
            .post(json.toString().toRequestBody(JSON_MEDIA))
            .build()
        return executeJson(req, "POST(unauth) $path")
    }

    private fun patch(path: String, json: JSONObject): JSONObject? {
        val req = authedBuilder(path)
            .patch(json.toString().toRequestBody(JSON_MEDIA))
            .build()
        return executeJson(req, "PATCH $path")
    }

    private fun delete(path: String): Boolean {
        val req = authedBuilder(path).delete().build()
        return try {
            val resp = client.newCall(req).execute()
            if (!resp.isSuccessful) {
                Log.e(TAG, "DELETE $path failed: ${resp.code} ${resp.body?.string()}")
            }
            resp.isSuccessful
        } catch (e: IOException) {
            Log.e(TAG, "DELETE $path error", e)
            false
        }
    }

    private fun authedBuilder(path: String): Request.Builder {
        val b = Request.Builder().url("$baseUrl$path")
        if (!authToken.isNullOrEmpty()) {
            b.header("Authorization", "Bearer $authToken")
        }
        return b
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

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

    // --- Agents (multi-agent ownership, Phase 2 backend) ---

    /** GET /v1/agents — list all agents owned by the authenticated user. */
    fun listAgents(): JSONArray? = getArray("/agents")

    /** GET /v1/agents/{id} — full detail with wallet, service count, reputation. */
    fun getAgent(id: String): JSONObject? = get("/agents/$id")

    /** POST /v1/agents — create a new agent. Server generates ed25519 keypair,
     *  derives DID, provisions a dedicated agent_wallets row in one transaction. */
    fun createAgent(slug: String, displayName: String, bio: String? = null, avatarUrl: String? = null): JSONObject? {
        val body = JSONObject().apply {
            put("slug", slug)
            put("display_name", displayName)
            if (bio != null) put("bio", bio)
            if (avatarUrl != null) put("avatar_url", avatarUrl)
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

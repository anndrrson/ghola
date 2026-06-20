package xyz.ghola.app.market

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.Locale
import java.util.concurrent.TimeUnit

typealias LiveProofProvider = suspend (method: String, path: String, body: JSONObject) -> Result<Map<String, String>>

data class AgentTradingSessionDraft(
    val productId: String,
    val maxNotionalBucket: String,
    val maxOrderCount: Int,
    val ttlMinutes: Int,
    val killSwitch: Boolean = false,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("execution_mode", "partner_omnibus")
        put("market_allowlist", JSONArray().put(productId.uppercase()))
        put("max_notional_bucket", maxNotionalBucket)
        put("max_order_count", maxOrderCount.coerceIn(0, 100))
        put("ttl_ms", ttlMinutes.coerceAtLeast(1) * 60_000L)
        put("kill_switch", killSwitch)
    }
}

data class AgentTradingSessionResult(
    val ok: Boolean,
    val body: JSONObject?,
    val error: String?,
    val statusCode: Int,
)

data class AutopilotReadiness(
    val canArm: Boolean,
    val canLiveSubmit: Boolean,
    val workerConfigured: Boolean,
    val walletBindingStatus: String,
    val blockers: List<String>,
    val body: JSONObject,
) {
    companion object {
        fun fromJson(json: JSONObject): AutopilotReadiness =
            AutopilotReadiness(
                canArm = json.optBoolean("can_arm", false),
                canLiveSubmit = json.optBoolean("can_live_submit", false),
                workerConfigured = json.optBoolean("worker_configured", false),
                walletBindingStatus = json.optString("wallet_binding_status", "unknown"),
                blockers = json.optJSONArray("blockers").toStringList(),
                body = json,
            )
    }
}

data class AutopilotSessionDraft(
    val productId: String,
    val maxNotionalBucket: String = "50",
    val maxPositionNotionalBucket: String = "100",
    val maxDailyNotionalBucket: String = "250",
    val maxOrderCount: Int = 10,
    val ttlMinutes: Int = 120,
    val maxSlippageBps: Int = 50,
    val aiDirectEnabled: Boolean = true,
    val localeHint: String = "en",
    val timezone: String? = null,
    // User-authored mandate. side "buy"/"sell" is enforced by the worker;
    // "auto" leaves direction to the agent. The rest steer the AI decision.
    val mandateSide: String = "auto",
    val strategyProfile: String = "momentum_continuation",
    val entryTrigger: String = "preview_now",
    val exitRule: String = "manual_approval",
    val timeHorizon: String = "scalp",
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("session_policy", JSONObject().apply {
            put("decision_model", if (aiDirectEnabled) "ai_direct_order_v1" else "rules_plus_ai_score")
            put("ai_direct_enabled", aiDirectEnabled)
            put("venue_allowlist", JSONArray().apply {
                put("jupiter")
                put("phoenix")
                put("hyperliquid")
                put("coinbase_advanced")
            })
            put("market_allowlist", JSONArray().apply {
                put(productId.uppercase(Locale.US))
                if (productId.equals("SOL-USD", ignoreCase = true)) put("SOL/USDC")
            })
            put("max_notional_bucket", maxNotionalBucket)
            put("max_position_notional_bucket", maxPositionNotionalBucket)
            put("max_daily_notional_bucket", maxDailyNotionalBucket)
            put("max_order_count", maxOrderCount.coerceIn(1, 25))
            put("ttl_ms", ttlMinutes.coerceIn(5, 240) * 60_000L)
            put("max_slippage_bps", maxSlippageBps.coerceIn(1, 100))
            put("ai_min_confidence_bps", 6500)
            put("reduce_only_on_reconcile_failure", true)
            put("locale_hint", localeHint)
            if (!timezone.isNullOrBlank()) put("timezone", timezone)
            put("agent_mandate", JSONObject().apply {
                put("version", 1)
                put("side", mandateSide)
                put("strategy_profile", strategyProfile)
                put("entry_trigger", entryTrigger)
                put("exit_rule", exitRule)
                put("time_horizon", timeHorizon)
            })
        })
    }
}

class PrivateAccountClient(
    baseUrl: String,
    private val tokenProvider: () -> String?,
    private val liveProofProvider: LiveProofProvider? = null,
    private val httpClient: OkHttpClient = OkHttpClient(),
) {
    private val apiBase = baseUrl.trim().removeSuffix("/")
    private val streamingClient = httpClient.newBuilder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    interface AutopilotEventListener {
        fun onSession(session: JSONObject)
        fun onEvent(type: String, event: JSONObject)
        fun onStatus(status: JSONObject)
        fun onFailure(message: String)
    }

    suspend fun armCoinbaseStyleSession(
        draft: AgentTradingSessionDraft,
    ): AgentTradingSessionResult = postJson(
        path = "/v1/private-account/venues/coinbase_style_provider/agent/session",
        body = draft.toJson(),
    )

    suspend fun createAutopilotSession(
        draft: AutopilotSessionDraft,
    ): AgentTradingSessionResult = postJson(
        path = "/v1/private-account/autopilot/sessions",
        body = draft.toJson(),
    )

    suspend fun fetchMobileWalletBindingChallenge(walletPubkey: String): Result<JSONObject> =
        withContext(Dispatchers.IO) {
            runCatching {
                val token = tokenProvider()?.takeIf { it.isNotBlank() }
                    ?: return@withContext Result.failure(
                        IllegalStateException("Sign in to Ghola Cloud before binding Seeker Wallet."),
                    )
                val encoded = URLEncoder.encode(walletPubkey.trim(), Charsets.UTF_8.name())
                val request = Request.Builder()
                    .url("$apiBase/v1/private-account/wallet-bindings/challenge?wallet_pubkey=$encoded")
                    .header("authorization", "Bearer $token")
                    .header("cache-control", "no-cache")
                    .get()
                    .build()
                httpClient.newCall(request).execute().use { response ->
                    val raw = response.body?.string().orEmpty()
                    val json = raw.takeIf { it.isNotBlank() }?.let {
                        runCatching { JSONObject(it) }.getOrNull()
                    }
                    if (response.isSuccessful && json != null) {
                        Result.success(json)
                    } else {
                        Result.failure(
                            IllegalStateException(
                                json?.optString("error")?.takeIf { it.isNotBlank() }
                                    ?: "wallet_binding_challenge_${response.code}",
                            ),
                        )
                    }
                }
            }.getOrElse { Result.failure(IllegalStateException(networkErrorMessage(it), it)) }
        }

    suspend fun bindMobileWallet(
        walletPubkey: String,
        message: String,
        signatureB64: String,
    ): AgentTradingSessionResult = postJson(
        path = "/v1/private-account/wallet-bindings",
        body = JSONObject().apply {
            put("wallet_pubkey", walletPubkey)
            put("message", message)
            put("signature_b64", signatureB64)
        },
        attachLiveProof = false,
    )

    suspend fun fetchAutopilotReadiness(productId: String, walletPubkey: String? = null): Result<AutopilotReadiness> =
        withContext(Dispatchers.IO) {
            runCatching {
                val token = tokenProvider()?.takeIf { it.isNotBlank() }
                    ?: return@withContext Result.failure(
                        IllegalStateException("Sign in to Ghola Cloud before checking agent readiness."),
                    )
                val encoded = URLEncoder.encode(productId.uppercase(Locale.US), Charsets.UTF_8.name())
                val walletQuery = walletPubkey?.takeIf { it.isNotBlank() }?.let {
                    "&wallet_pubkey=${URLEncoder.encode(it.trim(), Charsets.UTF_8.name())}"
                }.orEmpty()
                val request = Request.Builder()
                    .url("$apiBase/v1/private-account/autopilot/readiness?product_id=$encoded$walletQuery")
                    .header("authorization", "Bearer $token")
                    .header("cache-control", "no-cache")
                    .get()
                    .build()
                httpClient.newCall(request).execute().use { response ->
                    val raw = response.body?.string().orEmpty()
                    val json = raw.takeIf { it.isNotBlank() }?.let {
                        runCatching { JSONObject(it) }.getOrNull()
                    }
                    if (response.isSuccessful && json != null) {
                        Result.success(AutopilotReadiness.fromJson(json))
                    } else if (response.code == 404) {
                        // Prod cloud doesn't deploy the private-account/autopilot
                        // backend yet, so it returns 404. Surface that as a calm,
                        // user-readable sentence instead of a raw status code.
                        Result.failure(IllegalStateException(LIVE_TRADING_UNAVAILABLE))
                    } else {
                        Result.failure(
                            IllegalStateException(
                                json?.optString("error")?.takeIf { it.isNotBlank() }
                                    ?: "autopilot_readiness_${response.code}",
                            ),
                        )
                    }
                }
            }.getOrElse { Result.failure(IllegalStateException(networkErrorMessage(it), it)) }
        }

    suspend fun controlAutopilotSession(
        sessionId: String,
        action: String,
    ): AgentTradingSessionResult {
        val normalized = when (action.lowercase(Locale.US)) {
            "pause" -> "pause"
            "resume" -> "resume"
            "kill" -> "kill"
            else -> "pause"
        }
        return postJson(
            path = "/v1/private-account/autopilot/sessions/$sessionId/$normalized",
            body = JSONObject(),
        )
    }

    fun openAutopilotEvents(
        sessionId: String,
        listener: AutopilotEventListener,
    ): EventSource? {
        val token = tokenProvider()?.takeIf { it.isNotBlank() } ?: return null
        if (apiBase.isBlank()) return null
        val request = Request.Builder()
            .url("$apiBase/v1/private-account/autopilot/sessions/$sessionId/events")
            .header("authorization", "Bearer $token")
            .header("cache-control", "no-cache")
            .get()
            .build()
        return EventSources.createFactory(streamingClient).newEventSource(
            request,
            object : EventSourceListener() {
                override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                    runCatching { JSONObject(data) }
                        .onSuccess { json ->
                            when (type) {
                                "session_state" -> listener.onSession(json)
                                "stream_status" -> listener.onStatus(json)
                                else -> listener.onEvent(type ?: "message", json)
                            }
                        }
                        .onFailure { listener.onFailure(it.message ?: "Invalid autopilot event") }
                }

                override fun onFailure(eventSource: EventSource, t: Throwable?, response: okhttp3.Response?) {
                    listener.onFailure(t?.message ?: "Autopilot stream disconnected")
                }
            },
        )
    }

    private suspend fun postJson(
        path: String,
        body: JSONObject,
        attachLiveProof: Boolean = true,
    ): AgentTradingSessionResult {
        val token = tokenProvider()?.takeIf { it.isNotBlank() }
            ?: return AgentTradingSessionResult(
                ok = false,
                body = null,
                error = "Sign in to Ghola Cloud before approving an agent session.",
                statusCode = 401,
            )
        val proofHeaders = if (attachLiveProof) liveProofProvider?.invoke("POST", path, body)?.getOrElse {
            return AgentTradingSessionResult(
                ok = false,
                body = null,
                error = it.message ?: "Seeker Wallet proof failed.",
                statusCode = 0,
            )
        } ?: emptyMap() else emptyMap()
        return withContext(Dispatchers.IO) {
            runCatching {
                val request = Request.Builder()
                    .url("$apiBase$path")
                    .header("authorization", "Bearer $token")
                    .header("content-type", "application/json")
                    .also { builder ->
                        proofHeaders.forEach { (name, value) -> builder.header(name, value) }
                    }
                    .post(body.toString().toRequestBody(JSON_MEDIA))
                    .build()
                httpClient.newCall(request).execute().use { response ->
                    val raw = response.body?.string().orEmpty()
                    val json = raw.takeIf { it.isNotBlank() }?.let {
                        runCatching { JSONObject(it) }.getOrNull()
                    }
                    val error = when {
                        response.isSuccessful -> null
                        // Prod cloud doesn't deploy the private-account/autopilot
                        // backend yet (404). Show a calm, user-readable sentence
                        // rather than a raw status code.
                        response.code == 404 -> LIVE_TRADING_UNAVAILABLE
                        else -> json?.optString("error")?.takeIf { it.isNotBlank() }
                            ?: "private_account_${response.code}"
                    }
                    AgentTradingSessionResult(
                        ok = response.isSuccessful,
                        body = json,
                        error = error,
                        statusCode = response.code,
                    )
                }
            }.getOrElse {
                AgentTradingSessionResult(
                    ok = false,
                    body = null,
                    error = networkErrorMessage(it),
                    statusCode = 0,
                )
            }
        }
    }

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

        // Shown when the cloud returns 404 for the private-account/autopilot
        // endpoints — that backend isn't deployed to the production network yet.
        // Callers can match on this constant to render a calm "not available"
        // state rather than a red error.
        const val LIVE_TRADING_UNAVAILABLE = "Live trading isn't available on this network yet."

        private fun networkErrorMessage(error: Throwable): String =
            error.message?.takeIf { it.isNotBlank() }?.let { "Ghola Cloud is unreachable: $it" }
                ?: "Ghola Cloud is unreachable."
    }
}

private fun JSONArray?.toStringList(): List<String> {
    if (this == null) return emptyList()
    val values = mutableListOf<String>()
    for (i in 0 until length()) {
        optString(i).takeIf { it.isNotBlank() }?.let { values += it }
    }
    return values
}

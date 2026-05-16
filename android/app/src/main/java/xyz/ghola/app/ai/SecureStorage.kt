package xyz.ghola.app.ai

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import xyz.ghola.app.BuildConfig

class SecureStorage(context: Context) {

    companion object {
        private const val PREFS_NAME = "thumper_ai_secure"
        private const val KEY_API_KEY = "claude_api_key"
        private const val KEY_MODEL = "claude_model"
        private const val KEY_BACKEND = "backend_mode"
        private const val KEY_WALLET_PACKAGE = "wallet_package"
        private const val KEY_QWEN_API_KEY = "qwen_api_key"
        private const val KEY_QWEN_MODEL = "qwen_model"
        private const val KEY_CLOUD_AUTH_TOKEN = "cloud_auth_token"
        private const val KEY_CLOUD_AUTH_EXP = "cloud_auth_token_exp"
        private const val KEY_CLOUD_REFRESH_TOKEN = "cloud_refresh_token"
        private const val KEY_CLOUD_REFRESH_EXP = "cloud_refresh_token_exp"
        private const val KEY_SAID_REFRESH_TOKEN = "said_cloud_refresh_token"
        private const val KEY_SAID_REFRESH_EXP = "said_cloud_refresh_token_exp"
        private const val KEY_SAID_TOKEN_EXP = "said_cloud_token_exp"
        // v0.5: on-device Gmail OAuth (AppAuth flow).
        private const val KEY_GMAIL_ACCESS_TOKEN = "gmail_access_token"
        private const val KEY_GMAIL_ACCESS_EXP = "gmail_access_token_exp_millis"
        private const val KEY_GMAIL_REFRESH_TOKEN = "gmail_refresh_token"
        private const val KEY_CLOUD_USER_ID = "cloud_user_id"
        private const val KEY_CLOUD_BASE_URL = "cloud_base_url"
        private const val KEY_USER_DISPLAY_NAME = "user_display_name"
        private const val KEY_USER_EMAIL = "user_email"
        private const val KEY_IS_SEEKER = "is_seeker_device"
        private const val KEY_CRYPTO_ENABLED = "crypto_features_enabled"
        // v0.6: on-device LLM runtime + LoRA state.
        private const val KEY_USE_LLAMACPP_RUNTIME = "use_llamacpp_runtime"
        // v0.7 (Phase γ.1): on-device runtime selector. Replaces the
        // boolean useLlamaCppRuntime flag with a tri-state string so the
        // MediaPipe / llama.cpp / LiteRT-NeuroPilot triplet can be
        // expressed without a second flag. The legacy boolean is still
        // honoured for backwards compat (see [activeRuntime]).
        private const val KEY_RUNTIME = "local_llm_runtime"
        private const val KEY_VOICE_LORA_READY = "voice_lora_ready"
        private const val KEY_VOICE_LORA_READY_AT = "voice_lora_ready_at_millis"
        private const val KEY_VOICE_LORA_ACTIVE = "voice_lora_active"
        private const val KEY_VOICE_LORA_TRAINING_PAIR_HASH = "voice_lora_training_pair_hash"
        private const val KEY_SAID_TOKEN = "said_cloud_token"
        private const val KEY_SAID_BASE_URL = "said_cloud_base_url"
        private const val KEY_SAID_USER_ID = "said_cloud_user_id"
        private const val KEY_PRIMARY_AGENT_ID = "primary_agent_id"
        private const val KEY_SOLANA_ADDRESS = "solana_address"
        private const val DEFAULT_MODEL = "claude-sonnet-4-6"
        private const val DEFAULT_QWEN_MODEL = "qwen2.5-72b-instruct"
        // Source of truth lives in build.gradle.kts buildConfigField so debug
        // builds can point at a local thumper-cloud while release stays on
        // https://api.ghola.xyz. Override at build time:
        //   ./gradlew … -PghoLaCloudUrl=http://<lan-ip>:3000
        private val DEFAULT_CLOUD_URL: String = BuildConfig.DEFAULT_CLOUD_URL
        private const val DEFAULT_SAID_URL = "https://ghola-api.onrender.com/v1"
        const val BACKEND_CLOUD = "cloud"
        const val BACKEND_QWEN_CLOUD = "qwen_cloud"
        const val BACKEND_LOCAL = "local"
        /** End-to-end encrypted via thumper-cloud's `/api/chat`
         *  (sealed-envelope-v1). Default for wallet-paired users from
         *  v0.3.0 onward. */
        const val BACKEND_E2E_CLOUD = "e2e_cloud"
        /**
         * v0.7 (Phase γ.1) — LiteRT-LM + NeuroPilot Accelerator on-device
         * backend mode. Selects Gemma-3-1B running on the APU 655 NPU
         * via Google's `com.google.ai.edge.litertlm` runtime. Power
         * target: ~0.32W decode on D9500-class hardware per Google's
         * published numbers; APU 655 on D7300 (Seeker) is mid-tier of
         * the same family. Exposed as a [BACKEND_*] constant for
         * symmetry with [BACKEND_LOCAL] / [BACKEND_E2E_CLOUD]; wiring
         * into the SettingsActivity radio + ChatActivity.createAgent
         * dispatch lands in Phase γ.3.
         */
        const val BACKEND_LITERT_NPU = "litert_npu"

        // ── v0.7 runtime triplet (Phase γ.1) ──────────────────────────────
        //
        // The on-device facade [xyz.ghola.app.email.LocalLlm] now picks
        // between three implementations. Each value below is what
        // [setRuntime] / [activeRuntime] store and read from
        // [KEY_RUNTIME].

        /** [LocalLlm.MediaPipeImpl] — v0.5 path, `.task` bundle. */
        const val RUNTIME_MEDIAPIPE = "mediapipe"

        /** [LocalLlm.LlamaCppImpl] — v0.6 path, GGUF + LoRA support. */
        const val RUNTIME_LLAMACPP = "llamacpp"

        /**
         * [LocalLlm.LiteRTNeuroPilotImpl] — v0.7 path, `.litertlm`
         * artifact on the APU 655 NPU. The big battery win.
         */
        const val RUNTIME_LITERT_NPU = "litert_npu"
    }

    private val prefs: SharedPreferences

    init {
        val masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)
        prefs = EncryptedSharedPreferences.create(
            PREFS_NAME,
            masterKeyAlias,
            context,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    // --- LLM Backend ---

    fun getApiKey(): String? = prefs.getString(KEY_API_KEY, null)

    fun setApiKey(key: String) {
        prefs.edit().putString(KEY_API_KEY, key).apply()
    }

    fun getModel(): String = prefs.getString(KEY_MODEL, DEFAULT_MODEL) ?: DEFAULT_MODEL

    fun setModel(model: String) {
        prefs.edit().putString(KEY_MODEL, model).apply()
    }

    fun hasApiKey(): Boolean = !getApiKey().isNullOrBlank()

    /**
     * Resolved backend mode. If the user has explicitly chosen a backend
     * via Settings the stored value wins. Otherwise we default to
     * [BACKEND_E2E_CLOUD] unconditionally — the marketing copy "Off the
     * record. Even we can't read it." has to be true on first launch,
     * not after the user pairs a wallet. The vault-unlock failure matrix
     * routes `NoWalletPaired` to `MWAConnect` on first send, so fresh
     * installs hit a wallet popup, not a DashScope API key form. Power
     * users who want a direct-LLM fallback (Anthropic / Qwen / Local)
     * can still pick one explicitly in Settings.
     */
    fun getBackendMode(): String {
        val stored = prefs.getString(KEY_BACKEND, null)
        if (stored != null) return stored
        return BACKEND_E2E_CLOUD
    }

    fun setBackendMode(mode: String) {
        prefs.edit().putString(KEY_BACKEND, mode).apply()
    }

    fun isLocalMode(): Boolean = getBackendMode() == BACKEND_LOCAL

    fun isQwenCloudMode(): Boolean = getBackendMode() == BACKEND_QWEN_CLOUD

    fun isE2ECloudMode(): Boolean = getBackendMode() == BACKEND_E2E_CLOUD

    // --- Qwen ---

    fun getQwenApiKey(): String? = prefs.getString(KEY_QWEN_API_KEY, null)

    fun setQwenApiKey(key: String) {
        prefs.edit().putString(KEY_QWEN_API_KEY, key).apply()
    }

    fun hasQwenApiKey(): Boolean = !getQwenApiKey().isNullOrBlank()

    fun getQwenModel(): String = prefs.getString(KEY_QWEN_MODEL, DEFAULT_QWEN_MODEL) ?: DEFAULT_QWEN_MODEL

    fun setQwenModel(model: String) {
        prefs.edit().putString(KEY_QWEN_MODEL, model).apply()
    }

    // --- Wallet / Crypto ---

    fun getWalletPackage(): String? = prefs.getString(KEY_WALLET_PACKAGE, null)

    fun setWalletPackage(pkg: String) {
        prefs.edit().putString(KEY_WALLET_PACKAGE, pkg).apply()
    }

    fun hasWalletPackage(): Boolean = !getWalletPackage().isNullOrBlank()

    fun isSeeker(): Boolean = prefs.getBoolean(KEY_IS_SEEKER, false)

    // --- MWA wallet address (Phase 0.3) ---
    //
    // The Solana base58 pubkey returned by MWAConnect.authorize. Held here
    // so any activity (ChatActivity for vault unlock, PairDeviceSender for
    // handshake signing) can reuse the same wallet without re-prompting
    // the user to authorize. Cleared on wallet disconnect.

    fun getSolanaAddress(): String? = prefs.getString(KEY_SOLANA_ADDRESS, null)

    fun setSolanaAddress(address: String) {
        prefs.edit().putString(KEY_SOLANA_ADDRESS, address).apply()
    }

    fun clearSolanaAddress() {
        prefs.edit().remove(KEY_SOLANA_ADDRESS).apply()
    }

    fun hasSolanaAddress(): Boolean = !getSolanaAddress().isNullOrBlank()

    fun setIsSeeker(value: Boolean) {
        prefs.edit().putBoolean(KEY_IS_SEEKER, value).apply()
    }

    // ── v0.6: on-device LLM runtime + LoRA state ─────────────────────────────
    //
    // Two flags work together:
    //   useLlamaCppRuntime → routes LocalLlm to llama.cpp instead of MediaPipe.
    //   voiceLoraActive    → when true AND a voice.lora file exists on disk,
    //                        LlamaCppImpl binds the adapter at session init.
    // The training metadata (when, how many pairs, what hash) is preserved so
    // the user can be told "Trained at …, X emails, Y epochs."

    fun useLlamaCppRuntime(): Boolean {
        // The Phase γ.1 string selector wins when present so callers
        // that have flipped to MediaPipe via [setRuntime] don't get
        // overridden by a stale legacy boolean. When the string is
        // absent we fall through to the legacy boolean so v0.6 installs
        // keep their existing runtime through the upgrade.
        prefs.getString(KEY_RUNTIME, null)?.let { return it == RUNTIME_LLAMACPP }
        return prefs.getBoolean(KEY_USE_LLAMACPP_RUNTIME, false)
    }

    fun setUseLlamaCppRuntime(value: Boolean) {
        // Keep the legacy boolean in lockstep with the string selector
        // so observers that haven't been migrated yet keep working.
        prefs.edit()
            .putBoolean(KEY_USE_LLAMACPP_RUNTIME, value)
            .putString(
                KEY_RUNTIME,
                if (value) RUNTIME_LLAMACPP else RUNTIME_MEDIAPIPE,
            )
            .apply()
    }

    /**
     * v0.7 (Phase γ.1) — true when the LiteRT-LM + NeuroPilot
     * Accelerator path should serve on-device generation. Symmetric
     * with [useLlamaCppRuntime]. Mutually exclusive: at most one of
     * {MediaPipe, llama.cpp, LiteRT-NPU} is active at a time, mediated
     * via [setRuntime].
     *
     * Default is `false` — Phase γ.1 ships the runtime skeleton only;
     * the radio UI that lets users opt in lands in Phase γ.3.
     */
    fun useLiteRTNeuroPilotRuntime(): Boolean {
        return prefs.getString(KEY_RUNTIME, null) == RUNTIME_LITERT_NPU
    }

    /**
     * v0.7 (Phase γ.1) — read the active on-device runtime as a
     * string from the triplet [RUNTIME_MEDIAPIPE] / [RUNTIME_LLAMACPP]
     * / [RUNTIME_LITERT_NPU]. Falls back to the legacy boolean for
     * upgrades from v0.6.
     */
    fun activeRuntime(): String {
        prefs.getString(KEY_RUNTIME, null)?.let { return it }
        return if (prefs.getBoolean(KEY_USE_LLAMACPP_RUNTIME, false))
            RUNTIME_LLAMACPP
        else
            RUNTIME_MEDIAPIPE
    }

    /**
     * v0.7 (Phase γ.1) — write the active on-device runtime. Accepts
     * any of the three [RUNTIME_*] constants. Also updates the legacy
     * llama.cpp boolean so unmigrated readers stay consistent.
     *
     * @throws IllegalArgumentException if [runtime] isn't one of the
     *   three known values. Defensive — silent fallthrough would leave
     *   the prefs in a state that [activeRuntime] can't classify.
     */
    fun setRuntime(runtime: String) {
        require(
            runtime == RUNTIME_MEDIAPIPE ||
                runtime == RUNTIME_LLAMACPP ||
                runtime == RUNTIME_LITERT_NPU,
        ) { "unknown runtime: $runtime" }
        prefs.edit()
            .putString(KEY_RUNTIME, runtime)
            .putBoolean(KEY_USE_LLAMACPP_RUNTIME, runtime == RUNTIME_LLAMACPP)
            .apply()
    }

    fun voiceLoraReady(): Boolean = prefs.getBoolean(KEY_VOICE_LORA_READY, false)
    fun voiceLoraReadyAtMillis(): Long = prefs.getLong(KEY_VOICE_LORA_READY_AT, 0L)
    fun voiceLoraActive(): Boolean = prefs.getBoolean(KEY_VOICE_LORA_ACTIVE, false)
    fun voiceLoraTrainingPairHash(): String? = prefs.getString(KEY_VOICE_LORA_TRAINING_PAIR_HASH, null)

    fun setVoiceLoraReady(readyAtMillis: Long, trainingPairHash: String) {
        prefs.edit()
            .putBoolean(KEY_VOICE_LORA_READY, true)
            .putLong(KEY_VOICE_LORA_READY_AT, readyAtMillis)
            .putString(KEY_VOICE_LORA_TRAINING_PAIR_HASH, trainingPairHash)
            .apply()
    }

    fun setVoiceLoraActive(value: Boolean) {
        prefs.edit().putBoolean(KEY_VOICE_LORA_ACTIVE, value).apply()
    }

    fun clearVoiceLora() {
        prefs.edit()
            .remove(KEY_VOICE_LORA_READY)
            .remove(KEY_VOICE_LORA_READY_AT)
            .remove(KEY_VOICE_LORA_ACTIVE)
            .remove(KEY_VOICE_LORA_TRAINING_PAIR_HASH)
            .apply()
    }

    fun isCryptoEnabled(): Boolean = prefs.getBoolean(KEY_CRYPTO_ENABLED, false)

    fun setCryptoEnabled(value: Boolean) {
        prefs.edit().putBoolean(KEY_CRYPTO_ENABLED, value).apply()
    }

    // --- Cloud Auth ---

    fun getCloudAuthToken(): String? = prefs.getString(KEY_CLOUD_AUTH_TOKEN, null)

    /**
     * Persist the access token and (optionally) its exp + a refresh-token pair.
     * The exp/refresh fields are optional for backwards compatibility — pre-v0.4
     * code paths and the legacy single-arg form (below) keep working.
     */
    fun setCloudAuthToken(
        token: String,
        expSeconds: Long? = null,
        refreshToken: String? = null,
        refreshExpSeconds: Long? = null,
    ) {
        val editor = prefs.edit().putString(KEY_CLOUD_AUTH_TOKEN, token)
        // If exp not given by the server, derive from the JWT.
        val resolvedExp = expSeconds ?: xyz.ghola.app.cloud.JwtUtil.expirySeconds(token)
        if (resolvedExp != null) {
            editor.putLong(KEY_CLOUD_AUTH_EXP, resolvedExp)
        } else {
            editor.remove(KEY_CLOUD_AUTH_EXP)
        }
        if (!refreshToken.isNullOrBlank()) {
            editor.putString(KEY_CLOUD_REFRESH_TOKEN, refreshToken)
            if (refreshExpSeconds != null) {
                editor.putLong(KEY_CLOUD_REFRESH_EXP, refreshExpSeconds)
            }
        }
        editor.apply()
    }

    /** Unix-seconds expiry of the cloud access JWT (or 0 if unknown). */
    fun getCloudAuthTokenExp(): Long = prefs.getLong(KEY_CLOUD_AUTH_EXP, 0L)

    fun getCloudRefreshToken(): String? = prefs.getString(KEY_CLOUD_REFRESH_TOKEN, null)
    fun getCloudRefreshTokenExp(): Long = prefs.getLong(KEY_CLOUD_REFRESH_EXP, 0L)

    fun hasCloudRefreshToken(): Boolean {
        val rt = getCloudRefreshToken() ?: return false
        if (rt.isBlank()) return false
        val exp = getCloudRefreshTokenExp()
        if (exp == 0L) return true // unknown exp — assume valid until proven otherwise
        return exp > System.currentTimeMillis() / 1000
    }

    fun clearCloudAuth() {
        prefs.edit()
            .remove(KEY_CLOUD_AUTH_TOKEN)
            .remove(KEY_CLOUD_AUTH_EXP)
            .remove(KEY_CLOUD_REFRESH_TOKEN)
            .remove(KEY_CLOUD_REFRESH_EXP)
            .remove(KEY_CLOUD_USER_ID)
            .remove(KEY_USER_DISPLAY_NAME)
            .remove(KEY_USER_EMAIL)
            .apply()
    }

    /**
     * True when an access token is present AND not expired (within a small
     * skew window). Previously this was just a `!isNullOrBlank()` check, which
     * reported expired tokens as valid. Callers that need to ALSO know whether
     * a refresh would succeed should additionally consult [hasCloudRefreshToken].
     *
     * Note: [JwtUtil.isExpired] **fails open** if the JWT can't be decoded —
     * a present-but-unparseable token is treated as valid. The next API call
     * will 401 if the server disagrees, at which point the cloud-client
     * retry path takes over.
     */
    fun hasCloudAuth(): Boolean {
        val token = getCloudAuthToken() ?: return false
        if (token.isBlank()) return false
        return !xyz.ghola.app.cloud.JwtUtil.isExpired(token)
    }

    fun getCloudUserId(): String? = prefs.getString(KEY_CLOUD_USER_ID, null)

    fun setCloudUserId(userId: String) {
        prefs.edit().putString(KEY_CLOUD_USER_ID, userId).apply()
    }

    fun getCloudBaseUrl(): String = prefs.getString(KEY_CLOUD_BASE_URL, DEFAULT_CLOUD_URL) ?: DEFAULT_CLOUD_URL

    fun setCloudBaseUrl(url: String) {
        prefs.edit().putString(KEY_CLOUD_BASE_URL, url).apply()
    }

    // --- User Profile ---

    fun getUserDisplayName(): String? = prefs.getString(KEY_USER_DISPLAY_NAME, null)

    fun setUserDisplayName(name: String) {
        prefs.edit().putString(KEY_USER_DISPLAY_NAME, name).apply()
    }

    fun getUserEmail(): String? = prefs.getString(KEY_USER_EMAIL, null)

    fun setUserEmail(email: String) {
        prefs.edit().putString(KEY_USER_EMAIL, email).apply()
    }

    // --- said-cloud Auth (Phase M5) ---
    //
    // said-cloud is a separate backend from thumper-cloud with its own JWT secret
    // and user table. The mobile app holds two tokens: `cloud_auth_token` for
    // thumper-cloud (tasks, calls, emails) and `said_cloud_token` for said-cloud
    // (agent ownership, marketplace). Both are minted from the same Google ID
    // token via parallel /api/auth/google and /v1/auth/google endpoints.

    fun getSaidToken(): String? = prefs.getString(KEY_SAID_TOKEN, null)

    fun setSaidToken(
        token: String,
        expSeconds: Long? = null,
        refreshToken: String? = null,
        refreshExpSeconds: Long? = null,
    ) {
        val editor = prefs.edit().putString(KEY_SAID_TOKEN, token)
        val resolvedExp = expSeconds ?: xyz.ghola.app.cloud.JwtUtil.expirySeconds(token)
        if (resolvedExp != null) {
            editor.putLong(KEY_SAID_TOKEN_EXP, resolvedExp)
        } else {
            editor.remove(KEY_SAID_TOKEN_EXP)
        }
        if (!refreshToken.isNullOrBlank()) {
            editor.putString(KEY_SAID_REFRESH_TOKEN, refreshToken)
            if (refreshExpSeconds != null) {
                editor.putLong(KEY_SAID_REFRESH_EXP, refreshExpSeconds)
            }
        }
        editor.apply()
    }

    fun getSaidTokenExp(): Long = prefs.getLong(KEY_SAID_TOKEN_EXP, 0L)
    fun getSaidRefreshToken(): String? = prefs.getString(KEY_SAID_REFRESH_TOKEN, null)
    fun getSaidRefreshTokenExp(): Long = prefs.getLong(KEY_SAID_REFRESH_EXP, 0L)

    fun hasSaidRefreshToken(): Boolean {
        val rt = getSaidRefreshToken() ?: return false
        if (rt.isBlank()) return false
        val exp = getSaidRefreshTokenExp()
        if (exp == 0L) return true
        return exp > System.currentTimeMillis() / 1000
    }

    /** True when an access token is present AND not expired. */
    fun hasSaidAuth(): Boolean {
        val token = getSaidToken() ?: return false
        if (token.isBlank()) return false
        return !xyz.ghola.app.cloud.JwtUtil.isExpired(token)
    }

    fun getSaidBaseUrl(): String = prefs.getString(KEY_SAID_BASE_URL, DEFAULT_SAID_URL) ?: DEFAULT_SAID_URL

    fun setSaidBaseUrl(url: String) {
        prefs.edit().putString(KEY_SAID_BASE_URL, url).apply()
    }

    fun getSaidUserId(): String? = prefs.getString(KEY_SAID_USER_ID, null)

    fun setSaidUserId(userId: String) {
        prefs.edit().putString(KEY_SAID_USER_ID, userId).apply()
    }

    fun clearSaidAuth() {
        prefs.edit()
            .remove(KEY_SAID_TOKEN)
            .remove(KEY_SAID_TOKEN_EXP)
            .remove(KEY_SAID_REFRESH_TOKEN)
            .remove(KEY_SAID_REFRESH_EXP)
            .remove(KEY_SAID_USER_ID)
            .remove(KEY_PRIMARY_AGENT_ID)
            .apply()
    }

    // ── Gmail OAuth (v0.5 on-device flow via AppAuth) ────────────────────────
    //
    // Pre-v0.5, Gmail OAuth happened in a server-mediated browser redirect and
    // tokens lived in thumper-cloud.connected_accounts. v0.5 moves the whole
    // dance on-device: the Custom Tab returns tokens directly to the app, we
    // store them here (still inside EncryptedSharedPreferences), and refresh
    // by calling oauth2.googleapis.com from the device. No server roundtrip
    // for any Gmail data access. Required by the v0.5 privacy promise.

    fun setGmailTokens(
        accessToken: String,
        accessExpEpochMillis: Long,
        refreshToken: String,
    ) {
        prefs.edit()
            .putString(KEY_GMAIL_ACCESS_TOKEN, accessToken)
            .putLong(KEY_GMAIL_ACCESS_EXP, accessExpEpochMillis)
            .putString(KEY_GMAIL_REFRESH_TOKEN, refreshToken)
            .apply()
    }

    fun getGmailAccessToken(): String? = prefs.getString(KEY_GMAIL_ACCESS_TOKEN, null)
    fun getGmailAccessExpMillis(): Long = prefs.getLong(KEY_GMAIL_ACCESS_EXP, 0L)
    fun getGmailRefreshToken(): String? = prefs.getString(KEY_GMAIL_REFRESH_TOKEN, null)

    /** Access token present AND not within 60s of expiry. */
    fun hasFreshGmailAccess(): Boolean {
        val t = getGmailAccessToken() ?: return false
        if (t.isBlank()) return false
        val exp = getGmailAccessExpMillis()
        return exp == 0L || exp - System.currentTimeMillis() > 60_000L
    }

    fun hasGmailRefreshToken(): Boolean = !getGmailRefreshToken().isNullOrBlank()

    fun clearGmailAuth() {
        prefs.edit()
            .remove(KEY_GMAIL_ACCESS_TOKEN)
            .remove(KEY_GMAIL_ACCESS_EXP)
            .remove(KEY_GMAIL_REFRESH_TOKEN)
            .apply()
    }

    /** The agent the chat surface defaults to executing tasks as. */
    fun getPrimaryAgentId(): String? = prefs.getString(KEY_PRIMARY_AGENT_ID, null)

    fun setPrimaryAgentId(id: String) {
        prefs.edit().putString(KEY_PRIMARY_AGENT_ID, id).apply()
    }
}

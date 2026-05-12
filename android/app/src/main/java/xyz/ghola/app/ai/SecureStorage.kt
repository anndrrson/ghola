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
        private const val KEY_CLOUD_USER_ID = "cloud_user_id"
        private const val KEY_CLOUD_BASE_URL = "cloud_base_url"
        private const val KEY_USER_DISPLAY_NAME = "user_display_name"
        private const val KEY_USER_EMAIL = "user_email"
        private const val KEY_IS_SEEKER = "is_seeker_device"
        private const val KEY_CRYPTO_ENABLED = "crypto_features_enabled"
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

    /** The agent the chat surface defaults to executing tasks as. */
    fun getPrimaryAgentId(): String? = prefs.getString(KEY_PRIMARY_AGENT_ID, null)

    fun setPrimaryAgentId(id: String) {
        prefs.edit().putString(KEY_PRIMARY_AGENT_ID, id).apply()
    }
}

package xyz.ghola.app.ai

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

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
        private const val KEY_SEED_VAULT_AUTH_TOKEN = "seed_vault_auth_token"
        private const val KEY_SEED_VAULT_AUTH_ISSUED_AT = "seed_vault_auth_issued_at"
        private const val KEY_FIRST_RUN_COMPLETED = "first_run_completed"
        private const val DEFAULT_MODEL = "claude-sonnet-4-6"
        private const val DEFAULT_QWEN_MODEL = "qwen2.5-72b-instruct"
        private const val DEFAULT_CLOUD_URL = "https://thumper-cloud.onrender.com"
        private const val DEFAULT_SAID_URL = "https://ghola-api.onrender.com/v1"
        const val BACKEND_CLOUD = "cloud"
        const val BACKEND_QWEN_CLOUD = "qwen_cloud"
        const val BACKEND_LOCAL = "local"
    }

    private val prefs: SharedPreferences

    init {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        prefs = EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            masterKey,
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

    fun getBackendMode(): String = prefs.getString(KEY_BACKEND, BACKEND_QWEN_CLOUD) ?: BACKEND_QWEN_CLOUD

    fun setBackendMode(mode: String) {
        prefs.edit().putString(KEY_BACKEND, mode).apply()
    }

    fun isLocalMode(): Boolean = getBackendMode() == BACKEND_LOCAL

    fun isQwenCloudMode(): Boolean = getBackendMode() == BACKEND_QWEN_CLOUD

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

    fun setIsSeeker(value: Boolean) {
        prefs.edit().putBoolean(KEY_IS_SEEKER, value).apply()
    }

    fun isCryptoEnabled(): Boolean = prefs.getBoolean(KEY_CRYPTO_ENABLED, false)

    fun setCryptoEnabled(value: Boolean) {
        prefs.edit().putBoolean(KEY_CRYPTO_ENABLED, value).apply()
    }

    // --- Cloud Auth ---

    fun getCloudAuthToken(): String? = prefs.getString(KEY_CLOUD_AUTH_TOKEN, null)

    fun setCloudAuthToken(token: String) {
        prefs.edit().putString(KEY_CLOUD_AUTH_TOKEN, token).apply()
    }

    fun clearCloudAuth() {
        prefs.edit()
            .remove(KEY_CLOUD_AUTH_TOKEN)
            .remove(KEY_CLOUD_USER_ID)
            .remove(KEY_USER_DISPLAY_NAME)
            .remove(KEY_USER_EMAIL)
            .apply()
    }

    fun hasCloudAuth(): Boolean = !getCloudAuthToken().isNullOrBlank()

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

    fun setSaidToken(token: String) {
        prefs.edit().putString(KEY_SAID_TOKEN, token).apply()
    }

    fun hasSaidAuth(): Boolean = !getSaidToken().isNullOrBlank()

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
            .remove(KEY_SAID_USER_ID)
            .remove(KEY_PRIMARY_AGENT_ID)
            .apply()
    }

    /** The agent the chat surface defaults to executing tasks as. */
    fun getPrimaryAgentId(): String? = prefs.getString(KEY_PRIMARY_AGENT_ID, null)

    fun setPrimaryAgentId(id: String) {
        prefs.edit().putString(KEY_PRIMARY_AGENT_ID, id).apply()
    }

    // --- Seed Vault auth token cache (Op-Better #1) ---
    //
    // The Seed Vault SDK returns an opaque `authToken: Long` when the user
    // approves the authorize dialog. That token is valid until the user
    // revokes the app's access from the system Seed Vault settings, which
    // is rare. Caching it here lets us skip the authorize step on every
    // subsequent derive/sign call — the first agent creation is 2 prompts,
    // every later one is 1 prompt.

    fun getSeedVaultAuthToken(): Long {
        return prefs.getLong(KEY_SEED_VAULT_AUTH_TOKEN, -1L)
    }

    fun setSeedVaultAuthToken(token: Long) {
        prefs.edit()
            .putLong(KEY_SEED_VAULT_AUTH_TOKEN, token)
            .putLong(KEY_SEED_VAULT_AUTH_ISSUED_AT, System.currentTimeMillis())
            .apply()
    }

    fun clearSeedVaultAuthToken() {
        prefs.edit()
            .remove(KEY_SEED_VAULT_AUTH_TOKEN)
            .remove(KEY_SEED_VAULT_AUTH_ISSUED_AT)
            .apply()
    }

    fun hasSeedVaultAuthToken(): Boolean = getSeedVaultAuthToken() != -1L

    // --- First-run sequencer flag (Op-Better #4) ---

    fun isFirstRunCompleted(): Boolean = prefs.getBoolean(KEY_FIRST_RUN_COMPLETED, false)

    fun setFirstRunCompleted(completed: Boolean) {
        prefs.edit().putBoolean(KEY_FIRST_RUN_COMPLETED, completed).apply()
    }

    // --- Software-keyed agent private keys (Op-Better #2) ---
    //
    // On non-Seeker devices we fall back to Java ed25519 for agent keys.
    // The 32-byte seed is stored here keyed by the agent's slug. On a
    // Seeker the agent uses Seed Vault and this path is never touched.
    //
    // Keys are stored base64-encoded because SharedPreferences doesn't
    // natively handle ByteArray.

    fun getSoftwareAgentKey(slug: String): ByteArray? {
        val b64 = prefs.getString("sw_agent_key__$slug", null) ?: return null
        return try {
            android.util.Base64.decode(b64, android.util.Base64.NO_WRAP)
        } catch (e: Exception) {
            null
        }
    }

    fun setSoftwareAgentKey(slug: String, privateKeySeed: ByteArray) {
        val b64 = android.util.Base64.encodeToString(privateKeySeed, android.util.Base64.NO_WRAP)
        prefs.edit().putString("sw_agent_key__$slug", b64).apply()
    }
}

package xyz.ghola.app.cloud

import android.app.Activity
import android.app.Application
import android.content.Context
import android.util.Log
import com.turnkey.core.TurnkeyContext
import com.turnkey.core.models.AuthConfig
import com.turnkey.core.models.CreateSubOrgParams
import com.turnkey.core.models.CustomWallet
import com.turnkey.core.models.MethodCreateSubOrgParams
import com.turnkey.core.models.TurnkeyConfig
import com.turnkey.types.V1AddressFormat
import com.turnkey.types.V1Curve
import com.turnkey.types.V1HashFunction
import com.turnkey.types.V1PathFormat
import com.turnkey.types.V1PayloadEncoding
import com.turnkey.types.V1WalletAccountParams
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import xyz.ghola.app.BuildConfig
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.crypto.VaultStore

object TurnkeyAuthBridge {
    private const val TAG = "TurnkeyAuthBridge"
    private const val SOLANA_PATH = "m/44'/501'/0'/0'"

    fun initialize(app: Application) {
        if (!isBuildConfigured()) {
            Log.w(TAG, "Turnkey is not configured; Play auth will show setup error")
            return
        }
        runCatching {
            TurnkeyContext.init(
                app = app,
                config = TurnkeyConfig(
                    organizationId = BuildConfig.TURNKEY_ORG_ID,
                    apiBaseUrl = "https://api.turnkey.com",
                    authProxyBaseUrl = "https://authproxy.turnkey.com",
                    authProxyConfigId = BuildConfig.TURNKEY_AUTH_PROXY_CONFIG_ID,
                    authConfig = AuthConfig(
                        rpId = BuildConfig.TURNKEY_RP_ID,
                        createSubOrgParams = MethodCreateSubOrgParams(
                            passkeyAuth = createSubOrgParams(),
                            emailOtpAuth = createSubOrgParams(),
                            smsOtpAuth = createSubOrgParams(),
                            oAuth = createSubOrgParams(),
                        ),
                    ),
                    appScheme = BuildConfig.TURNKEY_APP_SCHEME,
                )
            )
        }.onFailure { err ->
            Log.e(TAG, "Turnkey init failed", err)
        }
    }

    fun isConfigured(context: Context): Boolean = isBuildConfigured()

    suspend fun signIn(activity: Activity): Result<DeviceSigner> = withContext(Dispatchers.Main) {
        if (!isBuildConfigured()) {
            return@withContext Result.failure(
                IllegalStateException("Turnkey is missing TURNKEY_ORG_ID or TURNKEY_RP_ID for this Play build")
            )
        }
        runCatching {
            TurnkeyContext.awaitReady()
            val storage = SecureStorage(activity)
            val login = runCatching {
                TurnkeyContext.loginWithPasskey(activity = activity)
            }.getOrElse {
                Log.i(TAG, "No existing Turnkey passkey session; creating one")
                TurnkeyContext.signUpWithPasskey(
                    activity = activity,
                    createSubOrgParams = createSubOrgParams(),
                )
            }
            val sessionJwt = when (login) {
                is com.turnkey.core.models.LoginWithPasskeyResult -> login.sessionJwt
                is com.turnkey.core.models.SignUpWithPasskeyResult -> login.sessionJwt
                else -> error("Unexpected Turnkey passkey result: ${login::class.java.simpleName}")
            }
            val sessionKey = "ghola-play"
            TurnkeyContext.createSession(sessionJwt, sessionKey = sessionKey)
            TurnkeyContext.setSelectedSession(sessionKey)
            TurnkeyContext.refreshWallets()
            val identity = resolveIdentity()
            storage.setTurnkeySession(
                address = identity.address,
                provider = identity.provider,
                displayName = identity.displayName,
            )
            StandardTurnkeySigner(activity.applicationContext, identity)
        }
    }

    fun cached(context: Context): DeviceSigner? {
        if (!isBuildConfigured()) return null
        val storage = SecureStorage(context)
        val address = storage.getTurnkeyAddress()?.takeIf { it.isNotBlank() } ?: return null
        return StandardTurnkeySigner(
            context.applicationContext,
            DeviceIdentity(
                address = address,
                displayName = storage.getTurnkeyDisplayName() ?: "Turnkey wallet",
                provider = storage.getTurnkeyProvider() ?: "turnkey",
            ),
        )
    }

    suspend fun signOut(context: Context) {
        runCatching { TurnkeyContext.clearAllSessions() }
        SecureStorage(context).clearTurnkeySession()
    }

    private fun isBuildConfigured(): Boolean =
        BuildConfig.TURNKEY_ORG_ID.isNotBlank() &&
            BuildConfig.TURNKEY_RP_ID.isNotBlank()

    private fun createSubOrgParams(): CreateSubOrgParams =
        CreateSubOrgParams(
            customWallet = CustomWallet(
                walletName = "Ghola Wallet",
                walletAccounts = listOf(solanaAccountParams()),
            ),
        )

    private fun solanaAccountParams(): V1WalletAccountParams =
        V1WalletAccountParams(
            addressFormat = V1AddressFormat.ADDRESS_FORMAT_SOLANA,
            curve = V1Curve.CURVE_ED25519,
            path = SOLANA_PATH,
            pathFormat = V1PathFormat.PATH_FORMAT_BIP32,
        )

    private suspend fun resolveIdentity(): DeviceIdentity {
        val wallets = TurnkeyContext.wallets.value.orEmpty()
        val solanaAccount = wallets
            .flatMap { it.accounts }
            .firstOrNull { it.addressFormat == V1AddressFormat.ADDRESS_FORMAT_SOLANA }
            ?: run {
                TurnkeyContext.createWallet(
                    walletName = "Ghola Wallet",
                    accounts = listOf(solanaAccountParams()),
                    mnemonicLength = 12,
                )
                TurnkeyContext.refreshWallets()
                TurnkeyContext.wallets.value.orEmpty()
                    .flatMap { it.accounts }
                    .firstOrNull { it.addressFormat == V1AddressFormat.ADDRESS_FORMAT_SOLANA }
                    ?: error("Turnkey did not return a Solana wallet account")
            }
        return DeviceIdentity(
            address = solanaAccount.address,
            displayName = "Turnkey wallet",
            provider = "turnkey",
        )
    }

    private class StandardTurnkeySigner(
        private val context: Context,
        override val identity: DeviceIdentity,
    ) : DeviceSigner {
        override suspend fun sign(message: ByteArray): DeviceSignResult = withContext(Dispatchers.IO) {
            runCatching {
                TurnkeyContext.awaitReady()
                val result = TurnkeyContext.signRawPayload(
                    signWith = identity.address,
                    payload = message.toHex(),
                    encoding = V1PayloadEncoding.PAYLOAD_ENCODING_HEXADECIMAL,
                    hashFunction = V1HashFunction.HASH_FUNCTION_NOT_APPLICABLE,
                )
                DeviceSignResult.Success((result.r + result.s).hexToBytes())
            }.getOrElse { err ->
                DeviceSignResult.Failure(err)
            }
        }

        override fun vaultSigner(): VaultStore.SignMessage =
            VaultStore.SignMessage { challenge ->
                when (val outcome = kotlinx.coroutines.runBlocking(Dispatchers.IO) { sign(challenge) }) {
                    is DeviceSignResult.Success -> VaultStore.SignResult.Success(outcome.signature)
                    DeviceSignResult.NoSigner -> VaultStore.SignResult.NoWallet
                    DeviceSignResult.Declined -> VaultStore.SignResult.Declined
                    DeviceSignResult.Cancelled -> VaultStore.SignResult.Cancelled
                    is DeviceSignResult.Failure -> throw outcome.cause
                }
            }
    }

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

    private fun String.hexToBytes(): ByteArray {
        val clean = removePrefix("0x").trim()
        require(clean.length % 2 == 0) { "invalid hex length" }
        return ByteArray(clean.length / 2) { i ->
            clean.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
    }
}

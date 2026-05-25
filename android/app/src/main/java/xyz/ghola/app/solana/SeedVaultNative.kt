package xyz.ghola.app.solana

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResult
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.solanamobile.seedvault.PermissionedAccount
import com.solanamobile.seedvault.SeedVault
import com.solanamobile.seedvault.SigningRequest
import com.solanamobile.seedvault.Wallet
import com.solanamobile.seedvault.WalletContractV1
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import xyz.ghola.app.cloud.DeviceIdentity
import xyz.ghola.app.cloud.DeviceSignResult
import xyz.ghola.app.cloud.DeviceSigner
import xyz.ghola.app.crypto.VaultStore
import java.util.ArrayList

/**
 * Native Seed Vault integration for Solana Seeker.
 *
 * This bypasses generic MWA when the hardware Seed Vault is available: the app
 * receives only an auth token, derivation path URI, public key, and detached
 * signatures. Private key material remains in Seed Vault.
 */
class SeedVaultNative(private val activity: ComponentActivity) {
    data class Session(
        val address: String,
        val authToken: Long,
        val derivationPathUri: String,
    )

    sealed class SignOutcome {
        data class Success(val signature: ByteArray) : SignOutcome()
        object NoSeedVault : SignOutcome()
        object Declined : SignOutcome()
        object Cancelled : SignOutcome()
        data class Failure(val cause: Throwable) : SignOutcome()
    }

    private var pending: CompletableDeferred<ActivityResult>? = null
    private var pendingPermission: CompletableDeferred<Boolean>? = null

    private val launcher: ActivityResultLauncher<Intent> =
        activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            pending?.complete(result)
            pending = null
        }

    private val permissionLauncher: ActivityResultLauncher<String> =
        activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            pendingPermission?.complete(granted)
            pendingPermission = null
        }

    fun hasAccessPermission(): Boolean =
        ContextCompat.checkSelfPermission(activity, ACCESS_PERMISSION) == PackageManager.PERMISSION_GRANTED

    fun isAvailable(): Boolean = runCatching { SeedVault.isAvailable(activity) }.getOrDefault(false)

    suspend fun authorizeSession(): Result<Session> {
        ensureAccessPermission().getOrElse { return Result.failure(it) }
        if (!isAvailable()) return Result.failure(NoSeedVaultException())
        val token = findAuthorizedSeedToken()
            ?: runIntent { Wallet.authorizeSeed(activity, WalletContractV1.PURPOSE_SIGN_SOLANA_TRANSACTION) }
                .mapCatching { result ->
                    if (result.resultCode != Activity.RESULT_OK) {
                        throw seedVaultActionException("authorizeSeed", result.resultCode)
                    }
                    Wallet.onAuthorizeSeedResult(result.resultCode, result.data)
                }
                .getOrElse { return Result.failure(it) }
        val path = PermissionedAccount.getPermissionedAccountDerivationPath(0).toUri()
        val pubkey = requestPublicKey(token, path).getOrElse { return Result.failure(it) }
        return Result.success(
            Session(
                address = Base58.encode(pubkey),
                authToken = token,
                derivationPathUri = path.toString(),
            ),
        )
    }

    suspend fun signMessage(authToken: Long, derivationPathUri: String, message: ByteArray): SignOutcome {
        ensureAccessPermission().getOrElse { return SignOutcome.Failure(it) }
        if (!isAvailable()) return SignOutcome.NoSeedVault
        val path = Uri.parse(derivationPathUri)
        val request = SigningRequest(message, listOf(path))
        val result = runIntent { Wallet.signMessages(activity, authToken, arrayListOf(request)) }
            .getOrElse { return mapSignFailure(it) }
        return try {
            val responses = Wallet.onSignMessagesResult(result.resultCode, result.data)
            val signature = responses.firstOrNull()?.signatures?.firstOrNull()
                ?: return SignOutcome.Failure(IllegalStateException("Seed Vault returned no signature"))
            if (signature.size != 64) {
                return SignOutcome.Failure(IllegalStateException("Seed Vault returned ${signature.size}-byte signature"))
            }
            SignOutcome.Success(signature)
        } catch (t: Throwable) {
            mapSignFailure(t)
        }
    }

    private fun findAuthorizedSeedToken(): Long? {
        val projection = arrayOf(
            WalletContractV1.AUTHORIZED_SEEDS_AUTH_TOKEN,
            WalletContractV1.AUTHORIZED_SEEDS_AUTH_PURPOSE,
        )
        val cursor = try {
            Wallet.getAuthorizedSeeds(activity, projection)
        } catch (t: Throwable) {
            Log.w(TAG, "Seed Vault authorized-seed query failed: ${t.message}", t)
            return null
        } ?: return null
        cursor.use {
            val tokenCol = it.getColumnIndexOrThrow(WalletContractV1.AUTHORIZED_SEEDS_AUTH_TOKEN)
            val purposeCol = it.getColumnIndexOrThrow(WalletContractV1.AUTHORIZED_SEEDS_AUTH_PURPOSE)
            while (it.moveToNext()) {
                if (it.getInt(purposeCol) == WalletContractV1.PURPOSE_SIGN_SOLANA_TRANSACTION) {
                    Log.i(TAG, "Reusing existing Seed Vault authorization")
                    return it.getLong(tokenCol)
                }
            }
        }
        return null
    }

    suspend fun signTransactions(
        authToken: Long,
        derivationPathUri: String,
        serializedTransactions: List<ByteArray>,
    ): Result<List<ByteArray>> {
        ensureAccessPermission().getOrElse { return Result.failure(it) }
        if (!isAvailable()) return Result.failure(NoSeedVaultException())
        val path = Uri.parse(derivationPathUri)
        val requests = ArrayList(serializedTransactions.map { SigningRequest(it, listOf(path)) })
        val result = runIntent { Wallet.signTransactions(activity, authToken, requests) }
            .getOrElse { return Result.failure(it) }
        return runCatching {
            Wallet.onSignTransactionsResult(result.resultCode, result.data)
                .map { response ->
                    response.signatures.firstOrNull()
                        ?: throw IllegalStateException("Seed Vault returned no transaction signature")
                }
        }
    }

    fun signer(session: Session): DeviceSigner = SeedVaultDeviceSigner(this, session)

    private suspend fun ensureAccessPermission(): Result<Unit> = withContext(Dispatchers.Main) {
        if (hasAccessPermission()) return@withContext Result.success(Unit)
        if (pendingPermission != null) {
            return@withContext Result.failure(IllegalStateException("Seed Vault permission request already pending"))
        }
        val deferred = CompletableDeferred<Boolean>()
        pendingPermission = deferred
        try {
            permissionLauncher.launch(ACCESS_PERMISSION)
            if (deferred.await()) {
                Result.success(Unit)
            } else {
                Result.failure(SeedVaultAccessDeniedException())
            }
        } catch (t: Throwable) {
            pendingPermission = null
            Result.failure(t)
        }
    }

    private suspend fun requestPublicKey(authToken: Long, path: Uri): Result<ByteArray> {
        val result = runIntent { Wallet.requestPublicKeys(activity, authToken, arrayListOf(path)) }
            .getOrElse { return Result.failure(it) }
        return runCatching {
            Wallet.onRequestPublicKeysResult(result.resultCode, result.data)
                .firstOrNull()
                ?.publicKey
                ?: throw IllegalStateException("Seed Vault returned no public key")
        }
    }

    private suspend fun runIntent(create: () -> Intent): Result<ActivityResult> = withContext(Dispatchers.Main) {
        if (pending != null) return@withContext Result.failure(IllegalStateException("Seed Vault request already pending"))
        val deferred = CompletableDeferred<ActivityResult>()
        pending = deferred
        try {
            val intent = create()
            Log.i(TAG, "Launching Seed Vault action=${intent.action}")
            launcher.launch(intent)
            val result = deferred.await()
            Log.i(
                TAG,
                "Seed Vault action=${intent.action} resultCode=${result.resultCode} hasData=${result.data != null}",
            )
            Result.success(result)
        } catch (t: Throwable) {
            pending = null
            Result.failure(t)
        }
    }

    private fun seedVaultActionException(action: String, resultCode: Int): Throwable =
        SeedVaultActionException("$action ${seedVaultResultLabel(resultCode)}")

    private fun seedVaultResultLabel(resultCode: Int): String =
        when (resultCode) {
            Activity.RESULT_CANCELED -> "was cancelled"
            WalletContractV1.RESULT_UNSPECIFIED_ERROR -> "failed with unspecified error"
            WalletContractV1.RESULT_INVALID_AUTH_TOKEN -> "failed with invalid auth token"
            WalletContractV1.RESULT_INVALID_PAYLOAD -> "failed with invalid payload"
            WalletContractV1.RESULT_AUTHENTICATION_FAILED -> "failed authentication"
            WalletContractV1.RESULT_NO_AVAILABLE_SEEDS -> "failed because no Seed Vault seed is available"
            WalletContractV1.RESULT_INVALID_PURPOSE -> "failed with invalid purpose"
            WalletContractV1.RESULT_INVALID_DERIVATION_PATH -> "failed with invalid derivation path"
            WalletContractV1.RESULT_IMPLEMENTATION_LIMIT_EXCEEDED -> "failed because the implementation limit was exceeded"
            else -> "failed with result=$resultCode"
        }

    private fun mapSignFailure(t: Throwable): SignOutcome {
        val msg = (t.message ?: "").lowercase()
        Log.w(TAG, "Seed Vault signing failed: ${t.message}", t)
        return when {
            msg.contains("cancel") -> SignOutcome.Cancelled
            msg.contains("declin") || msg.contains("reject") || msg.contains("authentication") -> SignOutcome.Declined
            else -> SignOutcome.Failure(t)
        }
    }

    class NoSeedVaultException : Exception("Seed Vault is not available")
    class SeedVaultAccessDeniedException : Exception("Seed Vault access permission was denied")
    class SeedVaultActionException(message: String) : Exception(message)

    private class SeedVaultDeviceSigner(
        private val native: SeedVaultNative,
        private val session: Session,
    ) : DeviceSigner {
        override val identity: DeviceIdentity = DeviceIdentity(
            address = session.address,
            displayName = "Seed Vault",
            provider = "seed_vault",
        )

        override suspend fun sign(message: ByteArray): DeviceSignResult =
            when (val out = native.signMessage(session.authToken, session.derivationPathUri, message)) {
                is SignOutcome.Success -> DeviceSignResult.Success(out.signature)
                SignOutcome.NoSeedVault -> DeviceSignResult.NoSigner
                SignOutcome.Declined -> DeviceSignResult.Declined
                SignOutcome.Cancelled -> DeviceSignResult.Cancelled
                is SignOutcome.Failure -> DeviceSignResult.Failure(out.cause)
            }

        override fun vaultSigner(): VaultStore.SignMessage = VaultStore.SignMessage { challenge ->
            when (val out = kotlinx.coroutines.runBlocking(Dispatchers.IO) { sign(challenge) }) {
                is DeviceSignResult.Success -> VaultStore.SignResult.Success(out.signature)
                DeviceSignResult.NoSigner -> VaultStore.SignResult.NoWallet
                DeviceSignResult.Declined -> VaultStore.SignResult.Declined
                DeviceSignResult.Cancelled -> VaultStore.SignResult.Cancelled
                is DeviceSignResult.Failure -> throw out.cause
            }
        }
    }

    companion object {
        private const val TAG = "SeedVaultNative"
        private const val ACCESS_PERMISSION = "com.solanamobile.seedvault.ACCESS_SEED_VAULT"

        fun isAvailable(context: Context): Boolean = runCatching { SeedVault.isAvailable(context) }.getOrDefault(false)
    }
}

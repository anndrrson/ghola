package xyz.ghola.app.cloud

import android.app.Activity
import android.content.Context
import xyz.ghola.app.crypto.VaultStore

data class DeviceIdentity(
    val address: String,
    val displayName: String,
    val provider: String,
)

sealed class DeviceSignResult {
    data class Success(val signature: ByteArray) : DeviceSignResult()
    data object NoSigner : DeviceSignResult()
    data object Declined : DeviceSignResult()
    data object Cancelled : DeviceSignResult()
    data class Failure(val cause: Throwable) : DeviceSignResult()
}

interface DeviceSigner {
    val identity: DeviceIdentity
    suspend fun sign(message: ByteArray): DeviceSignResult
    fun vaultSigner(): VaultStore.SignMessage
}

object DeviceSignerProvider {
    fun isConfigured(context: Context): Boolean = TurnkeyAuthBridge.isConfigured(context)
    suspend fun signIn(activity: Activity): Result<DeviceSigner> = TurnkeyAuthBridge.signIn(activity)
    fun cached(context: Context): DeviceSigner? = TurnkeyAuthBridge.cached(context)
    suspend fun signOut(context: Context) = TurnkeyAuthBridge.signOut(context)
}

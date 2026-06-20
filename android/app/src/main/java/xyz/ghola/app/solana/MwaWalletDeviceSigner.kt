package xyz.ghola.app.solana

import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import xyz.ghola.app.cloud.DeviceIdentity
import xyz.ghola.app.cloud.DeviceSignResult
import xyz.ghola.app.cloud.DeviceSigner
import xyz.ghola.app.crypto.VaultStore

class MwaWalletDeviceSigner(
    private val sender: ActivityResultSender,
    override val identity: DeviceIdentity,
    private val authTokenProvider: () -> String?,
) : DeviceSigner {
    override suspend fun sign(message: ByteArray): DeviceSignResult =
        when (
            val out = MWAConnect.signMessageDetached(
                sender = sender,
                walletAddressBase58 = identity.address,
                message = message,
                authToken = authTokenProvider(),
            )
        ) {
            is MWAConnect.SignOutcome.Success -> DeviceSignResult.Success(out.signature)
            MWAConnect.SignOutcome.NoWallet -> DeviceSignResult.NoSigner
            MWAConnect.SignOutcome.Declined -> DeviceSignResult.Declined
            MWAConnect.SignOutcome.Cancelled -> DeviceSignResult.Cancelled
            is MWAConnect.SignOutcome.Failure -> DeviceSignResult.Failure(out.cause)
        }

    override fun vaultSigner(): VaultStore.SignMessage =
        VaultStore.SignMessage { challenge ->
            when (val out = runBlocking(Dispatchers.IO) { sign(challenge) }) {
                is DeviceSignResult.Success -> VaultStore.SignResult.Success(out.signature)
                DeviceSignResult.NoSigner -> VaultStore.SignResult.NoWallet
                DeviceSignResult.Declined -> VaultStore.SignResult.Declined
                DeviceSignResult.Cancelled -> VaultStore.SignResult.Cancelled
                is DeviceSignResult.Failure -> throw out.cause
            }
        }
}

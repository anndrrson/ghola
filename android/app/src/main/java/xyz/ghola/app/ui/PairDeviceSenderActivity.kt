package xyz.ghola.app.ui

import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.button.MaterialButton
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import xyz.ghola.app.BuildConfig
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.DeviceSignResult
import xyz.ghola.app.cloud.DeviceSignerProvider
import xyz.ghola.app.crypto.Envelope
import xyz.ghola.app.crypto.PairDevice
import xyz.ghola.app.crypto.VaultStore
import xyz.ghola.app.crypto.VaultStoreHolder
import xyz.ghola.app.crypto.mwaSignerForVault
import xyz.ghola.app.solana.Base58
import xyz.ghola.app.solana.MWAConnect

/**
 * Pair Device — sender side. Uses the code from the new phone, asks the
 * user to confirm the receiver's expectedSenderDid matches their own
 * wallet, then seals all session DEKs into a sealed-envelope-v1 frame
 * signed by the wallet (one MWA popup), and POSTs to the cloud mailbox.
 */
class PairDeviceSenderActivity : AppCompatActivity() {

    private lateinit var storage: SecureStorage
    private lateinit var statusView: TextView
    private lateinit var scanButton: MaterialButton
    private lateinit var pasteButton: MaterialButton
    private lateinit var confirmPanel: LinearLayout
    private lateinit var receiverDidLine: TextView
    private lateinit var walletDidLine: TextView
    private lateinit var confirmSendButton: MaterialButton
    private lateinit var cancelPairButton: MaterialButton
    private val activityResultSender = ActivityResultSender(this)
    private var vault: VaultStore? = null
    private var pendingDescriptor: PairDevice.HandshakeDescriptor? = null
    private var pendingSolanaAddress: String? = null
    private var pendingWalletDid: String? = null

    private val qrLauncher = registerForActivityResult(ScanContract()) { result ->
        val raw = result.contents
        if (raw == null) {
            statusView.text = "Scan cancelled"
            return@registerForActivityResult
        }
        onScanned(raw)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        storage = SecureStorage(this)

        setContentView(R.layout.activity_pair_device_sender)
        statusView = findViewById(R.id.pairSenderStatus)
        scanButton = findViewById(R.id.scanPairQrButton)
        pasteButton = findViewById(R.id.pastePairCodeButton)
        confirmPanel = findViewById(R.id.pairConfirmPanel)
        receiverDidLine = findViewById(R.id.receiverDidLine)
        walletDidLine = findViewById(R.id.walletDidLine)
        confirmSendButton = findViewById(R.id.confirmSendButton)
        cancelPairButton = findViewById(R.id.cancelPairButton)

        pasteButton.setOnClickListener { pastePairingCode() }
        scanButton.visibility = if (BuildConfig.GHOLA_CAMERA_QR_ENABLED) {
            View.VISIBLE
        } else {
            View.GONE
        }
        scanButton.setOnClickListener { launchScan() }
        confirmSendButton.setOnClickListener { sendPendingPairing() }
        cancelPairButton.setOnClickListener {
            clearPendingPairing()
            statusView.text = "Paste the code from your new phone. Ghola will encrypt your chats and send them there."
        }
        BottomNavHelper.attach(this, R.id.tab_messages, findViewById<BottomNavigationView>(R.id.bottomNav))
    }

    private fun pastePairingCode() {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val raw = clipboard.primaryClip
            ?.takeIf { it.itemCount > 0 }
            ?.getItemAt(0)
            ?.coerceToText(this)
            ?.toString()
            ?.trim()
        if (raw.isNullOrBlank()) {
            statusView.text = "No receive code found on clipboard."
            return
        }
        onScanned(raw)
    }

    private fun launchScan() {
        val opts = ScanOptions().apply {
            setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            setPrompt("Scan the new phone's code")
            setBeepEnabled(false)
            setOrientationLocked(true)
        }
        qrLauncher.launch(opts)
    }

    private fun onScanned(raw: String) {
        val descriptor = try {
            PairDevice.HandshakeDescriptor.fromJson(raw)
        } catch (e: Exception) {
            statusView.text = "That code does not look like a Ghola receive code: ${e.message ?: "parse error"}"
            return
        }

        val solanaAddress = storage.getSolanaAddress()
        if (solanaAddress.isNullOrBlank()) {
            statusView.text = "Connect your wallet first."
            return
        }
        val pubBytes = try { Base58.decode(solanaAddress) } catch (e: Exception) {
            statusView.text = "Wallet address invalid"; return
        }
        if (pubBytes.size != 32) {
            statusView.text = "Wallet address must be a 32-byte Ed25519 pubkey"; return
        }
        val ourDid = Envelope.didKeyFromVerifying(pubBytes)

        pendingDescriptor = descriptor
        pendingSolanaAddress = solanaAddress
        pendingWalletDid = ourDid
        receiverDidLine.text = "New phone expects\n${descriptor.expectedSenderDid}"
        walletDidLine.text = "This phone wallet\n$ourDid"
        confirmPanel.visibility = LinearLayout.VISIBLE
        statusView.text = if (descriptor.expectedSenderDid == ourDid) {
            "This code belongs to your wallet. Send chats to the new phone."
        } else {
            "Wallet mismatch. Do not send unless this is expected."
        }
    }

    private fun sendPendingPairing() {
        val descriptor = pendingDescriptor ?: return
        val solanaAddress = pendingSolanaAddress ?: return
        val ourDid = pendingWalletDid ?: return
        startSend(descriptor, solanaAddress, ourDid)
    }

    private fun clearPendingPairing() {
        pendingDescriptor = null
        pendingSolanaAddress = null
        pendingWalletDid = null
        receiverDidLine.text = ""
        walletDidLine.text = ""
        confirmPanel.visibility = LinearLayout.GONE
    }

    private fun startSend(
        descriptor: PairDevice.HandshakeDescriptor,
        solanaAddress: String,
        ourDid: String,
    ) {
        statusView.text = "Approve with ${walletLabel()} to send chats."
        scanButton.isEnabled = false
        pasteButton.isEnabled = false
        confirmSendButton.isEnabled = false
        cancelPairButton.isEnabled = false
        val v = VaultStoreHolder.get(this, ourDid)
        vault = v

        lifecycleScope.launch {
            runCatching {
                val signer = if (v.isUnlocked()) {
                    null
                } else {
                    ApprovalGate.request(
                        context = this@PairDeviceSenderActivity,
                        reason = ApprovalGate.Reason.PAIR_DEVICE,
                        caller = "PairDeviceSenderActivity.startSend.unlock",
                    ) {
                        if (BuildConfig.GHOLA_PLAY_STORE_BUILD) {
                            (DeviceSignerProvider.cached(this@PairDeviceSenderActivity)
                                ?: DeviceSignerProvider.signIn(this@PairDeviceSenderActivity).getOrThrow())
                                .vaultSigner()
                        } else {
                            mwaSignerForVault(
                                activityResultSender,
                                solanaAddress,
                                storage.getMwaAuthToken(),
                            )
                        }
                    }
                }
                if (signer != null) {
                    withContext(Dispatchers.IO) { v.unlock(signer) }
                }
                statusView.text = "Sending encrypted chats..."
                // The handshake envelope must be signed by the wallet
                // (not the cached chat-sign seed) so the receiver can
                // verify against the wallet DID it pinned in the
                // descriptor. PairDevice.sendHandshake invokes this
                // signer once during seal(); that's the single MWA popup
                // the user sees in this flow.
                val walletSigner = Envelope.Ed25519BodySigner { msg ->
                    if (BuildConfig.GHOLA_PLAY_STORE_BUILD) {
                        val turnkeySigner = DeviceSignerProvider.cached(this@PairDeviceSenderActivity)
                            ?: error("Turnkey signer unavailable")
                        when (val sig = kotlinx.coroutines.runBlocking(Dispatchers.IO) { turnkeySigner.sign(msg) }) {
                            is DeviceSignResult.Success -> sig.signature
                            else -> error("Turnkey sign failed: $sig")
                        }
                    } else {
                        val outcome = kotlinx.coroutines.runBlocking(Dispatchers.IO) {
                            ApprovalGate.request(
                                context = this@PairDeviceSenderActivity,
                                reason = ApprovalGate.Reason.PAIR_DEVICE,
                                caller = "PairDeviceSenderActivity.startSend.walletEnvelope",
                            ) {
                                signWithNativeWalletFirst(solanaAddress, msg)
                            }
                        }
                        when (val sig = outcome) {
                            is MWAConnect.SignOutcome.Success -> sig.signature
                            else -> error("wallet sign failed: $sig")
                        }
                    }
                }
                withContext(Dispatchers.IO) {
                    PairDevice.sendHandshake(
                        baseUrl = storage.getCloudBaseUrl(),
                        descriptor = descriptor,
                        vault = v,
                        senderWalletDid = ourDid,
                        walletSigner = walletSigner,
                    )
                }
            }.onSuccess { count ->
                Toast.makeText(this@PairDeviceSenderActivity, "Sent $count session(s)", Toast.LENGTH_LONG).show()
                finish()
            }.onFailure { err ->
                statusView.text = "Send failed: ${err.message ?: "unknown"}"
                scanButton.isEnabled = true
                pasteButton.isEnabled = true
                confirmSendButton.isEnabled = true
                cancelPairButton.isEnabled = true
            }
        }
    }

    private suspend fun signWithNativeWalletFirst(
        walletAddress: String,
        message: ByteArray,
    ): MWAConnect.SignOutcome {
        return MWAConnect.signMessageDetached(
            activityResultSender,
            walletAddress,
            message,
            storage.getMwaAuthToken(),
        )
    }

    override fun onDestroy() {
        super.onDestroy()
    }

    private fun walletLabel(): String =
        if (BuildConfig.GHOLA_SEEKER_BUILD) "Seeker Wallet" else "your wallet"
}

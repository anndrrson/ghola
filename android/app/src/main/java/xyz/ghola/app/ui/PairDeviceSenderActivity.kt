package xyz.ghola.app.ui

import android.app.AlertDialog
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup.LayoutParams
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.crypto.Envelope
import xyz.ghola.app.crypto.PairDevice
import xyz.ghola.app.crypto.VaultStore
import xyz.ghola.app.crypto.mwaSignerForVault
import xyz.ghola.app.solana.Base58
import xyz.ghola.app.solana.MWAConnect

/**
 * Pair Device — sender side. Scans the QR from the receiver, asks the
 * user to confirm the receiver's expectedSenderDid matches their own
 * wallet, then seals all session DEKs into a sealed-envelope-v1 frame
 * signed by the wallet (one MWA popup), and POSTs to the cloud mailbox.
 */
class PairDeviceSenderActivity : AppCompatActivity() {

    private lateinit var storage: SecureStorage
    private lateinit var statusView: TextView
    private val activityResultSender = ActivityResultSender(this)
    private var vault: VaultStore? = null

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

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(32, 48, 32, 48)
            layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
        }
        val title = TextView(this).apply {
            text = "Send sessions to a new device"
            textSize = 20f
            setTextColor(Color.WHITE)
        }
        statusView = TextView(this).apply {
            text = "Tap Scan, then point your camera at the new device's QR."
            textSize = 14f
            setTextColor(Color.LTGRAY)
            setPadding(0, 16, 0, 16)
        }
        val scanButton = Button(this).apply {
            text = "Scan QR"
            setOnClickListener { launchScan() }
        }
        root.addView(title)
        root.addView(statusView)
        root.addView(scanButton)
        setContentView(root)
    }

    private fun launchScan() {
        val opts = ScanOptions().apply {
            setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            setPrompt("Scan the receiving device's QR")
            setBeepEnabled(false)
            setOrientationLocked(true)
        }
        qrLauncher.launch(opts)
    }

    private fun onScanned(raw: String) {
        val descriptor = try {
            PairDevice.HandshakeDescriptor.fromJson(raw)
        } catch (e: Exception) {
            statusView.text = "Invalid QR: ${e.message ?: "parse error"}"
            return
        }

        val solanaAddress = storage.getSolanaAddress()
        if (solanaAddress.isNullOrBlank()) {
            statusView.text = "Connect your wallet first (Wallet tab)."
            return
        }
        val pubBytes = try { Base58.decode(solanaAddress) } catch (e: Exception) {
            statusView.text = "Wallet address invalid"; return
        }
        if (pubBytes.size != 32) {
            statusView.text = "Wallet address must be a 32-byte Ed25519 pubkey"; return
        }
        val ourDid = Envelope.didKeyFromVerifying(pubBytes)

        // Show the receiver's expected DID alongside our own so the user
        // can visually verify they match before any sealing happens. This
        // is the only step where the cloud cannot impersonate.
        AlertDialog.Builder(this)
            .setTitle("Confirm receiver wallet")
            .setMessage(
                "The new device says it expects:\n${descriptor.expectedSenderDid}\n\n" +
                    "Your wallet DID is:\n$ourDid\n\n" +
                    "If these don't match, cancel and try again.",
            )
            .setPositiveButton("Send") { _, _ -> startSend(descriptor, solanaAddress, ourDid) }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun startSend(
        descriptor: PairDevice.HandshakeDescriptor,
        solanaAddress: String,
        ourDid: String,
    ) {
        statusView.text = "Unlocking vault…"
        val v = VaultStore.create(this, ourDid)
        vault = v

        lifecycleScope.launch {
            runCatching {
                val signer = mwaSignerForVault(activityResultSender, solanaAddress)
                withContext(Dispatchers.IO) { v.unlock(signer) }
                statusView.text = "Tap your wallet to authorize the transfer…"
                // The handshake envelope must be signed by the wallet
                // (not the cached chat-sign seed) so the receiver can
                // verify against the wallet DID it pinned in the
                // descriptor. PairDevice.sendHandshake invokes this
                // signer once during seal(); that's the single MWA popup
                // the user sees in this flow.
                val walletSigner = Envelope.Ed25519BodySigner { msg ->
                    val sig = kotlinx.coroutines.runBlocking(Dispatchers.IO) {
                        MWAConnect.signMessageDetached(activityResultSender, solanaAddress, msg)
                    }
                    when (sig) {
                        is MWAConnect.SignOutcome.Success -> sig.signature
                        else -> error("wallet sign failed: $sig")
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
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        vault?.lock()
    }
}

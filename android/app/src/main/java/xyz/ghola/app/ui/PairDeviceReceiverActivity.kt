package xyz.ghola.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.button.MaterialButton
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import xyz.ghola.app.BuildConfig
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.DeviceSignerProvider
import xyz.ghola.app.crypto.Envelope
import xyz.ghola.app.crypto.PairDevice
import xyz.ghola.app.crypto.VaultStore
import xyz.ghola.app.crypto.VaultStoreHolder
import xyz.ghola.app.crypto.mwaSignerForVault
import xyz.ghola.app.solana.Base58

/**
 * Pair Device — receiver side. The user opens this on a new phone that
 * needs to inherit the existing wallet's session DEKs. We:
 *
 *   1. Unlock the vault for the user's DID (one MWA wallet sign).
 *   2. Generate an ephemeral X25519 keypair + mailbox id.
 *   3. Render the descriptor JSON as a QR code on screen.
 *   4. Poll `/api/devices/handshake/<id>`. On receipt, verify sender DID
 *      and import every DEK into the local vault.
 */
class PairDeviceReceiverActivity : AppCompatActivity() {

    private lateinit var storage: SecureStorage
    private lateinit var qrView: ImageView
    private lateinit var qrFrame: FrameLayout
    private lateinit var statusView: TextView
    private lateinit var hintView: TextView
    private lateinit var createPairCodeButton: MaterialButton
    private lateinit var pairCodeLine: TextView
    private lateinit var sharePairCodeButton: MaterialButton
    private lateinit var copyPairCodeButton: MaterialButton
    private lateinit var showPairQrButton: MaterialButton
    private lateinit var pairCodeActions: LinearLayout
    private val activityResultSender = ActivityResultSender(this)
    private var vault: VaultStore? = null
    private var receiver: PairDevice.ReceiverHandshake? = null
    private var pairingDescriptorJson: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        storage = SecureStorage(this)

        setContentView(R.layout.activity_pair_device_receiver)
        statusView = findViewById(R.id.pairReceiverStatus)
        hintView = findViewById(R.id.pairReceiverHint)
        qrView = findViewById(R.id.pairQrImage)
        qrFrame = findViewById(R.id.pairQrFrame)
        createPairCodeButton = findViewById(R.id.createPairCodeButton)
        pairCodeLine = findViewById(R.id.pairCodeLine)
        sharePairCodeButton = findViewById(R.id.sharePairCodeButton)
        copyPairCodeButton = findViewById(R.id.copyPairCodeButton)
        showPairQrButton = findViewById(R.id.showPairQrButton)
        pairCodeActions = findViewById(R.id.pairCodeActions)
        createPairCodeButton.setOnClickListener { startReceiverFlow() }
        sharePairCodeButton.setOnClickListener { sharePairingCode() }
        copyPairCodeButton.setOnClickListener { copyPairingCode() }
        showPairQrButton.setOnClickListener {
            pairingDescriptorJson?.let { renderQr(it) }
        }
        BottomNavHelper.attach(this, R.id.tab_messages, findViewById<BottomNavigationView>(R.id.bottomNav))
    }

    private fun startReceiverFlow() {
        val solanaAddress = storage.getSolanaAddress()
        if (solanaAddress.isNullOrBlank()) {
            statusView.text = "Connect your wallet first (Wallet tab)."
            return
        }
        val pubBytes = try {
            Base58.decode(solanaAddress)
        } catch (e: Exception) {
            statusView.text = "Wallet address invalid; reconnect in Wallet."
            return
        }
        if (pubBytes.size != 32) {
            statusView.text = "Wallet address must be a 32-byte Ed25519 pubkey."
            return
        }
        val userDid = Envelope.didKeyFromVerifying(pubBytes)
        val v = VaultStoreHolder.get(this, userDid)
        vault = v

        statusView.text = "Approve with ${walletLabel()} to create a receive code."
        createPairCodeButton.isEnabled = false
        lifecycleScope.launch {
            runCatching {
                val signer = if (v.isUnlocked()) {
                    null
                } else {
                    ApprovalGate.request(
                        context = this@PairDeviceReceiverActivity,
                        reason = ApprovalGate.Reason.PAIR_DEVICE,
                        caller = "PairDeviceReceiverActivity.startReceiverFlow",
                    ) {
                        if (BuildConfig.GHOLA_PLAY_STORE_BUILD) {
                            (DeviceSignerProvider.cached(this@PairDeviceReceiverActivity)
                                ?: DeviceSignerProvider.signIn(this@PairDeviceReceiverActivity).getOrThrow())
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
            }.onSuccess {
                val handshake = PairDevice.createReceiverHandshake(userDid)
                receiver = handshake
                val descriptorJson = handshake.descriptor.toJson()
                pairingDescriptorJson = descriptorJson
                renderPairingCode(descriptorJson)
                statusView.text = "Code ready. Send it to your old phone."
                hintView.text = "On the phone that already has your chats, open Messages > Send Chats, then paste this code. Keep this screen open."
                createPairCodeButton.visibility = View.GONE
                runReceiverPoll(handshake, v)
            }.onFailure { err ->
                statusView.text = "Vault unlock failed: ${err.message ?: "unknown"}"
                createPairCodeButton.isEnabled = true
            }
        }
    }

    private fun runReceiverPoll(handshake: PairDevice.ReceiverHandshake, vault: VaultStore) {
        lifecycleScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    PairDevice.awaitHandshake(
                        baseUrl = storage.getCloudBaseUrl(),
                        receiver = handshake,
                        vault = vault,
                    )
                }
            }.onSuccess { result ->
                handshake.zeroize()
                Toast.makeText(
                    this@PairDeviceReceiverActivity,
                    "Imported ${result.imported} session(s)",
                    Toast.LENGTH_LONG,
                ).show()
                finish()
            }.onFailure { err ->
                handshake.zeroize()
                statusView.text = "Pair failed: ${err.message ?: "unknown"}"
            }
        }
    }

    private fun renderQr(content: String) {
        val size = 640
        val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, size, size)
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        for (x in 0 until size) for (y in 0 until size) {
            bmp.setPixel(x, y, if (matrix.get(x, y)) Color.BLACK else Color.WHITE)
        }
        qrView.setImageBitmap(bmp)
        qrFrame.visibility = View.VISIBLE
        showPairQrButton.text = "HIDE QR"
        showPairQrButton.setOnClickListener {
            qrFrame.visibility = View.GONE
            showPairQrButton.text = "SHOW QR"
            showPairQrButton.setOnClickListener { pairingDescriptorJson?.let { renderQr(it) } }
        }
    }

    private fun renderPairingCode(content: String) {
        pairCodeLine.text = previewPairingCode(content)
        pairCodeLine.visibility = View.VISIBLE
        sharePairCodeButton.visibility = View.VISIBLE
        pairCodeActions.visibility = View.VISIBLE
    }

    private fun copyPairingCode() {
        val content = pairingDescriptorJson ?: return
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Ghola receive code", content))
        Toast.makeText(this, "Receive code copied", Toast.LENGTH_SHORT).show()
    }

    private fun sharePairingCode() {
        val content = pairingDescriptorJson ?: return
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "Ghola receive code")
            putExtra(Intent.EXTRA_TEXT, content)
        }
        startActivity(Intent.createChooser(send, "Send code to old phone"))
    }

    private fun previewPairingCode(content: String): String {
        val compact = content.replace("\\s+".toRegex(), "")
        return if (compact.length <= 96) {
            compact
        } else {
            "${compact.take(56)}\n...\n${compact.takeLast(40)}"
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        pairingDescriptorJson = null
        receiver?.zeroize()
    }

    private fun walletLabel(): String =
        if (BuildConfig.GHOLA_SEEKER_BUILD) "Seeker Wallet" else "your wallet"
}

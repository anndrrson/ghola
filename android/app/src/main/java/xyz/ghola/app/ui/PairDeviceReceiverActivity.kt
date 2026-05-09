package xyz.ghola.app.ui

import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
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

/**
 * Pair Device — receiver side. The user opens this on a NEW device that
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
    private lateinit var statusView: TextView
    private val activityResultSender = ActivityResultSender(this)
    private var vault: VaultStore? = null
    private var receiver: PairDevice.ReceiverHandshake? = null

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
            text = "Pair this device"
            textSize = 20f
            setTextColor(Color.WHITE)
        }
        statusView = TextView(this).apply {
            text = "Connecting…"
            textSize = 14f
            setTextColor(Color.LTGRAY)
            setPadding(0, 16, 0, 16)
        }
        qrView = ImageView(this).apply {
            layoutParams = LinearLayout.LayoutParams(640, 640).apply { topMargin = 16 }
            visibility = View.GONE
        }
        val instructions = TextView(this).apply {
            text = "On your other device, scan this QR. Verify the sender DID matches your wallet before approving."
            textSize = 13f
            setTextColor(Color.LTGRAY)
            setPadding(0, 24, 0, 0)
        }
        root.addView(title)
        root.addView(statusView)
        root.addView(qrView)
        root.addView(instructions)
        setContentView(root)

        startReceiverFlow()
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
        val v = VaultStore.create(this, userDid)
        vault = v

        statusView.text = "Tap your wallet to unlock the vault…"
        lifecycleScope.launch {
            runCatching {
                val signer = mwaSignerForVault(activityResultSender, solanaAddress)
                withContext(Dispatchers.IO) { v.unlock(signer) }
            }.onSuccess {
                val handshake = PairDevice.createReceiverHandshake(userDid)
                receiver = handshake
                renderQr(handshake.descriptor.toJson())
                statusView.text = "Waiting for the other device to send…"
                runReceiverPoll(handshake, v)
            }.onFailure { err ->
                statusView.text = "Vault unlock failed: ${err.message ?: "unknown"}"
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
        qrView.visibility = View.VISIBLE
    }

    override fun onDestroy() {
        super.onDestroy()
        receiver?.zeroize()
        vault?.lock()
    }
}

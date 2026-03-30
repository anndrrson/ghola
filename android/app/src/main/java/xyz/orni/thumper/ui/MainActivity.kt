package xyz.orni.thumper.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject
import xyz.orni.thumper.R
import xyz.orni.thumper.network.DeviceKeyManager
import xyz.orni.thumper.service.ThumperAccessibilityService

class MainActivity : AppCompatActivity() {

    private lateinit var statusText: TextView
    private lateinit var relayUrlInput: EditText
    private lateinit var connectButton: Button
    private lateinit var enableA11yButton: Button
    private lateinit var scanQrButton: Button
    private lateinit var deviceInfoText: TextView

    private lateinit var keyManager: DeviceKeyManager

    private val cameraPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            launchQrScanner()
        } else {
            Toast.makeText(this, "Camera permission required for QR scanning", Toast.LENGTH_SHORT).show()
        }
    }

    private val qrScanLauncher = registerForActivityResult(ScanContract()) { result ->
        if (result.contents != null) {
            handleQrResult(result.contents)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        keyManager = DeviceKeyManager(this)

        statusText = findViewById(R.id.statusText)
        relayUrlInput = findViewById(R.id.relayUrlInput)
        connectButton = findViewById(R.id.connectButton)
        enableA11yButton = findViewById(R.id.enableA11yButton)
        scanQrButton = findViewById(R.id.scanQrButton)
        deviceInfoText = findViewById(R.id.deviceInfoText)

        // Load saved relay URL
        val prefs = getSharedPreferences("thumper", MODE_PRIVATE)
        relayUrlInput.setText(prefs.getString("relay_url", "ws://192.168.1.100:8080/ws"))

        enableA11yButton.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }

        scanQrButton.setOnClickListener {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED
            ) {
                launchQrScanner()
            } else {
                cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
            }
        }

        connectButton.setOnClickListener {
            val url = relayUrlInput.text.toString().trim()
            if (url.isNotEmpty()) {
                prefs.edit().putString("relay_url", url).apply()

                val service = ThumperAccessibilityService.instance
                if (service != null) {
                    service.connectToRelay(url)
                    updateStatus()
                } else {
                    statusText.text = "Accessibility service not enabled"
                }
            }
        }

        updateDeviceInfo()
    }

    override fun onResume() {
        super.onResume()
        updateStatus()
    }

    private fun launchQrScanner() {
        val options = ScanOptions().apply {
            setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            setPrompt("Scan QR code from 'thumper qr'")
            setBeepEnabled(false)
            setOrientationLocked(true)
        }
        qrScanLauncher.launch(options)
    }

    private fun handleQrResult(contents: String) {
        try {
            val json = JSONObject(contents)
            val relayUrl = json.optString("relay_url", "")
            val mcpPubkey = json.optString("mcp_pubkey", "")

            if (relayUrl.isNotEmpty()) {
                relayUrlInput.setText(relayUrl)

                val prefs = getSharedPreferences("thumper", MODE_PRIVATE)
                prefs.edit().apply {
                    putString("relay_url", relayUrl)
                    if (mcpPubkey.isNotEmpty()) {
                        putString("mcp_pubkey", mcpPubkey)
                    }
                    apply()
                }

                Toast.makeText(this, "Configuration applied from QR code", Toast.LENGTH_SHORT).show()
                updateDeviceInfo()

                // Auto-connect if accessibility service is enabled
                val service = ThumperAccessibilityService.instance
                if (service != null) {
                    service.connectToRelay(relayUrl)
                    updateStatus()
                }
            } else {
                Toast.makeText(this, "QR code missing relay URL", Toast.LENGTH_SHORT).show()
            }
        } catch (e: Exception) {
            Toast.makeText(this, "Invalid QR code: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    private fun updateStatus() {
        val service = ThumperAccessibilityService.instance
        val a11yEnabled = service != null
        val relayConnected = service?.isRelayConnected() ?: false

        statusText.text = buildString {
            append("Accessibility Service: ")
            appendLine(if (a11yEnabled) "ENABLED" else "DISABLED")
            append("Relay Connection: ")
            appendLine(if (relayConnected) "CONNECTED" else "DISCONNECTED")
        }

        enableA11yButton.isEnabled = !a11yEnabled
        connectButton.isEnabled = a11yEnabled
    }

    private fun updateDeviceInfo() {
        val prefs = getSharedPreferences("thumper", MODE_PRIVATE)
        val devicePubkey = keyManager.getDevicePubkey()
        val mcpPubkey = prefs.getString("mcp_pubkey", null)

        deviceInfoText.text = buildString {
            appendLine("Device Pubkey: $devicePubkey")
            if (mcpPubkey != null) {
                appendLine("MCP Pubkey:    $mcpPubkey")
            }
            appendLine()
            appendLine("Set this as device_pubkey in your")
            append("thumper config on desktop.")
        }
    }
}

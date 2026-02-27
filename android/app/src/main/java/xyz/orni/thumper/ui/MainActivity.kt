package xyz.orni.thumper.ui

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import xyz.orni.thumper.R
import xyz.orni.thumper.service.ThumperAccessibilityService

class MainActivity : AppCompatActivity() {

    private lateinit var statusText: TextView
    private lateinit var relayUrlInput: EditText
    private lateinit var connectButton: Button
    private lateinit var enableA11yButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusText = findViewById(R.id.statusText)
        relayUrlInput = findViewById(R.id.relayUrlInput)
        connectButton = findViewById(R.id.connectButton)
        enableA11yButton = findViewById(R.id.enableA11yButton)

        // Load saved relay URL
        val prefs = getSharedPreferences("thumper", MODE_PRIVATE)
        relayUrlInput.setText(prefs.getString("relay_url", "ws://192.168.1.100:8080/ws"))

        enableA11yButton.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
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
    }

    override fun onResume() {
        super.onResume()
        updateStatus()
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
}

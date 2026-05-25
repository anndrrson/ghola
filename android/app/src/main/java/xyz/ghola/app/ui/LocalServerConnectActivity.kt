package xyz.ghola.app.ui

import android.os.Bundle
import android.view.Gravity
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.LocalHomeClient
import xyz.ghola.app.network.LocalGholaServer
import xyz.ghola.app.network.LocalServerBrowser

class LocalServerConnectActivity : AppCompatActivity() {
    private lateinit var storage: SecureStorage
    private lateinit var browser: LocalServerBrowser
    private lateinit var list: LinearLayout
    private lateinit var status: TextView
    private var selected: LocalGholaServer? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        storage = SecureStorage(this)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 48, 32, 32)
            setBackgroundColor(0xFF000000.toInt())
        }
        status = TextView(this).apply {
            text = if (storage.isGholaHomeLocalMode()) {
                "Connected to ${storage.getLocalServerName() ?: "Ghola Home"}"
            } else {
                "Searching for Ghola Home on this WiFi..."
            }
            setTextColor(0xFFEEF1F8.toInt())
            textSize = 20f
            setPadding(0, 0, 0, 24)
        }
        root.addView(status)

        if (storage.isGholaHomeLocalMode()) {
            root.addView(Button(this).apply {
                text = "Disconnect local server"
                setOnClickListener {
                    LocalHomeClient(this@LocalServerConnectActivity).disconnect()
                    recreate()
                }
            })
        }

        list = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        root.addView(list)
        root.addView(ProgressBar(this).apply {
            isIndeterminate = true
            setPadding(0, 24, 0, 0)
        })
        setContentView(root)

        browser = LocalServerBrowser(this) { servers ->
            runOnUiThread { renderServers(servers) }
        }
    }

    override fun onStart() {
        super.onStart()
        browser.start()
    }

    override fun onStop() {
        browser.stop()
        super.onStop()
    }

    private fun renderServers(servers: List<LocalGholaServer>) {
        list.removeAllViews()
        if (servers.isEmpty()) {
            status.text = if (storage.isGholaHomeLocalMode()) status.text else
                "Searching for Ghola Home on this WiFi..."
            return
        }
        status.text = "Ghola Home servers"
        for (server in servers) {
            val label = buildString {
                append(server.name).append('\n').append(server.baseUrl)
                if (server.models.isNotEmpty()) append("\n").append(server.models.joinToString(", "))
            }
            list.addView(Button(this).apply {
                text = label
                gravity = Gravity.START or Gravity.CENTER_VERTICAL
                setOnClickListener {
                    selected = server
                    showPinEntry(server)
                }
            })
        }
    }

    private fun showPinEntry(server: LocalGholaServer) {
        list.removeAllViews()
        status.text = "Pair ${server.name}"
        val input = EditText(this).apply {
            hint = "PIN"
            textSize = 28f
            gravity = Gravity.CENTER
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
            imeOptions = EditorInfo.IME_ACTION_DONE
        }
        list.addView(input)
        list.addView(Button(this).apply {
            text = "Connect"
            setOnClickListener { pair(server, input.text.toString()) }
        })
        list.addView(Button(this).apply {
            text = "Back"
            setOnClickListener { browser.start() }
        })
    }

    private fun pair(server: LocalGholaServer, pin: String) {
        if (pin.length != 4) {
            Toast.makeText(this, "Enter the 4-digit PIN shown on Ghola Home", Toast.LENGTH_SHORT).show()
            return
        }
        status.text = "Pairing..."
        Thread {
            val result = LocalHomeClient(this).pair(server.baseUrl, pin)
            runOnUiThread {
                result.fold(
                    onSuccess = { paired ->
                        Toast.makeText(this, "Connected to ${paired.serverName}", Toast.LENGTH_LONG).show()
                        // Show the server's key fingerprint so the user can
                        // confirm (out of band) they paired with their own
                        // server and not a LAN impostor (M finding).
                        status.text = if (paired.serverFingerprint.isNotBlank()) {
                            "Connected to ${paired.serverName}\nVerify this code matches Ghola Home:\n${paired.serverFingerprint}"
                        } else {
                            "Connected to ${paired.serverName}\n(no server fingerprint — update Ghola Home to verify identity)"
                        }
                        recreate()
                    },
                    onFailure = { err ->
                        status.text = "Pairing failed"
                        Toast.makeText(this, err.message ?: "Wrong PIN or connection failed", Toast.LENGTH_LONG).show()
                    },
                )
            }
        }.start()
    }
}

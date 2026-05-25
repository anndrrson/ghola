package xyz.ghola.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.button.MaterialButton
import xyz.ghola.app.BuildConfig
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.NativeMessagingRelayClient
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

class MessagesActivity : AppCompatActivity() {
    private lateinit var storage: SecureStorage
    private lateinit var statusTitle: TextView
    private lateinit var statusBody: TextView
    private lateinit var walletLine: TextView
    private lateinit var inbox: LinearLayout
    private lateinit var refreshButton: MaterialButton
    private lateinit var newMessageButton: MaterialButton
    private lateinit var copyInviteButton: MaterialButton

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_messages)
        storage = SecureStorage(this)

        statusTitle = findViewById(R.id.messageStatusTitle)
        statusBody = findViewById(R.id.messageStatusBody)
        walletLine = findViewById(R.id.messageWalletLine)
        inbox = findViewById(R.id.inboxContainer)
        refreshButton = findViewById(R.id.refreshInboxButton)
        newMessageButton = findViewById(R.id.newMessageButton)
        copyInviteButton = findViewById(R.id.copyInviteButton)

        newMessageButton.setOnClickListener {
            startActivity(Intent(this, NewMessageActivity::class.java))
        }
        copyInviteButton.setOnClickListener { copyInviteLink() }
        refreshButton.setOnClickListener { refreshInbox() }

        val nav = findViewById<BottomNavigationView>(R.id.bottomNav)
        BottomNavHelper.attach(this, R.id.tab_messages, nav)
    }

    override fun onResume() {
        super.onResume()
        renderStatus()
        renderEmptyInbox()
    }

    private fun renderStatus() {
        val address = storage.getSolanaAddress()
        val hasAuth = !storage.getCloudAuthToken().isNullOrBlank()
        if (address.isNullOrBlank()) {
            statusTitle.text = "Connect ${walletLabelTitle()}"
            statusBody.text = "Sign in to see your Ghola chats."
            statusBody.visibility = View.VISIBLE
            walletLine.visibility = View.GONE
            refreshButton.isEnabled = false
            refreshButton.alpha = 0.45f
            return
        }

        statusTitle.text = "Messages"
        if (hasAuth) {
            statusBody.text = ""
            statusBody.visibility = View.GONE
        } else {
            statusBody.text = "Finish wallet sign-in."
            statusBody.visibility = View.VISIBLE
        }
        walletLine.text = ""
        walletLine.visibility = View.GONE
        refreshButton.isEnabled = hasAuth
        refreshButton.alpha = if (hasAuth) 1f else 0.45f
    }

    private fun copyInviteLink() {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Ghola invite link", inviteLink()))
        Toast.makeText(this, "Invite link copied", Toast.LENGTH_SHORT).show()
    }

    private fun inviteLink(): String {
        val wallet = storage.getSolanaAddress()?.trim().orEmpty()
        if (wallet.isBlank()) return "https://ghola.xyz/invite"
        val encoded = URLEncoder.encode(wallet, StandardCharsets.UTF_8.name())
        return "https://ghola.xyz/invite?from=$encoded"
    }

    private fun refreshInbox() {
        inbox.removeAllViews()
        inbox.addView(inboxRow("Syncing", "Checking for new chats."))
        refreshButton.isEnabled = false
        Thread {
            val result = runCatching {
                NativeMessagingRelayClient(
                    storage.getThumperApiBaseUrl(),
                    tokenProvider = { storage.getCloudAuthToken() },
                ).sync()
            }
            runOnUiThread {
                refreshButton.isEnabled = !storage.getCloudAuthToken().isNullOrBlank()
                inbox.removeAllViews()
                result.fold(
                    onSuccess = { rows ->
                        if (rows.length() == 0) {
                            renderEmptyInbox()
                        } else {
                            for (i in 0 until rows.length()) {
                                val row = rows.optJSONObject(i) ?: continue
                                val kind = row.optString("kind", "Session package")
                                    .replace('_', ' ')
                                    .replaceFirstChar { it.uppercase() }
                                val sender = row.optString("sender_did", "")
                                    .takeIf { it.isNotBlank() }
                                    ?.let { "from ${mask(it)}" }
                                    ?: "sender hidden"
                                val createdAt = row.optString("created_at", "").takeIf { it.isNotBlank() }
                                inbox.addView(inboxRow(kind, listOfNotNull(sender, createdAt).joinToString(" · ")))
                            }
                        }
                    },
                    onFailure = { err ->
                        inbox.addView(inboxRow("Could not sync inbox", cleanError(err.message)))
                        Toast.makeText(this, "Inbox sync failed", Toast.LENGTH_SHORT).show()
                    },
                )
            }
        }.start()
    }

    private fun renderEmptyInbox() {
        inbox.removeAllViews()
        val body = if (storage.getCloudAuthToken().isNullOrBlank()) {
            "Sign in to see your chats."
        } else {
            "No messages yet."
        }
        inbox.addView(inboxRow("No messages", body))
    }

    private fun inboxRow(title: String, body: String): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(18), 0, dp(18))
        }
        row.addView(TextView(this).apply {
            text = title
            setTextColor(0xFFEEF1F8.toInt())
            textSize = 15f
            typeface = resources.getFont(R.font.geist)
            includeFontPadding = false
        })
        row.addView(TextView(this).apply {
            text = body
            setTextColor(0xFF8B95A8.toInt())
            textSize = 13f
            typeface = resources.getFont(R.font.geist)
            setPadding(0, dp(8), 0, 0)
        })
        row.addView(View(this).apply {
            setBackgroundColor(0xFF1E2A3A.toInt())
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(1),
            ).apply {
                topMargin = dp(18)
            }
        })
        return row
    }

    private fun mask(raw: String): String {
        val value = raw.trim()
        if (value.length <= 16) return value
        return "${value.take(6)}...${value.takeLast(6)}"
    }

    private fun cleanError(raw: String?): String {
        val message = raw.orEmpty()
        return when {
            message.contains("wallet sign-in required", ignoreCase = true) ->
                "Sign in with ${walletLabelTitle()} before syncing messages."
            message.contains("401") ->
                "Your wallet session needs to be refreshed from the Wallet tab."
            message.contains("404") ->
                "The relay endpoint is not available from this build."
            message.isBlank() ->
                "The relay did not return a readable error."
            else ->
                message.lineSequence().firstOrNull()?.take(140) ?: "The relay did not return a readable error."
        }
    }

    private fun walletLabelTitle(): String =
        if (BuildConfig.GHOLA_SEEKER_BUILD) "Seeker Wallet" else "Wallet"

    private fun dp(value: Int): Int {
        return (value * resources.displayMetrics.density).toInt()
    }
}

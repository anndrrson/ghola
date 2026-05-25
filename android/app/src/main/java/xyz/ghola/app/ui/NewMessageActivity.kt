package xyz.ghola.app.ui

import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.button.MaterialButton
import org.json.JSONArray
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.NativeMessagingRelayClient
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

class NewMessageActivity : AppCompatActivity() {
    private lateinit var storage: SecureStorage
    private lateinit var recipientInput: EditText
    private lateinit var messageInput: EditText
    private lateinit var recipientModeLine: TextView
    private lateinit var recipientStatus: TextView
    private lateinit var composeStatus: TextView
    private lateinit var peopleHeader: TextView
    private lateinit var peopleContainer: LinearLayout
    private lateinit var startMessageButton: MaterialButton
    private val knownRecipients = linkedSetOf<String>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_new_message)
        storage = SecureStorage(this)

        recipientInput = findViewById(R.id.recipientInput)
        messageInput = findViewById(R.id.messageInput)
        recipientModeLine = findViewById(R.id.recipientModeLine)
        recipientStatus = findViewById(R.id.recipientStatus)
        composeStatus = findViewById(R.id.composeStatus)
        peopleHeader = findViewById(R.id.peopleHeader)
        peopleContainer = findViewById(R.id.peopleContainer)
        startMessageButton = findViewById(R.id.startMessageButton)

        findViewById<View>(R.id.crumbMessages).setOnClickListener { finish() }
        startMessageButton.setOnClickListener { startMessage() }
        findViewById<MaterialButton>(R.id.inviteFromComposeButton).setOnClickListener { shareInvite() }
        recipientInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                updateComposeState()
            }
            override fun afterTextChanged(s: Editable?) = Unit
        })
        messageInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                updateComposeState()
            }
            override fun afterTextChanged(s: Editable?) = Unit
        })

        BottomNavHelper.attach(this, R.id.tab_messages, findViewById<BottomNavigationView>(R.id.bottomNav))
        updateComposeState()
    }

    override fun onResume() {
        super.onResume()
        loadPeople()
    }

    private fun loadPeople() {
        hidePeople()

        val token = storage.getCloudAuthToken()
        if (token.isNullOrBlank()) {
            composeStatus.text = ""
            return
        }

        composeStatus.text = ""
        Thread {
            val result = runCatching {
                NativeMessagingRelayClient(
                    storage.getThumperApiBaseUrl(),
                    tokenProvider = { storage.getCloudAuthToken() },
                ).sync(limit = 100)
            }
            runOnUiThread {
                peopleContainer.removeAllViews()
                result.fold(
                    onSuccess = { rows -> renderPeople(rows) },
                    onFailure = { hidePeople() },
                )
            }
        }.start()
    }

    private fun renderPeople(rows: JSONArray) {
        val seen = linkedSetOf<String>()
        for (i in 0 until rows.length()) {
            val did = rows.optJSONObject(i)
                ?.optString("sender_did", "")
                ?.trim()
                .orEmpty()
            if (did.isNotBlank()) seen += did
        }
        knownRecipients.clear()
        knownRecipients.addAll(seen)
        updateComposeState()

        if (seen.isEmpty()) {
            hidePeople()
            return
        }

        peopleHeader.visibility = View.VISIBLE
        peopleContainer.visibility = View.VISIBLE
        for (did in seen.take(12)) {
            peopleContainer.addView(
                personRow(
                    title = mask(did),
                    body = "Recent",
                    recipient = did,
                ),
            )
        }
    }

    private fun hidePeople() {
        knownRecipients.clear()
        peopleHeader.visibility = View.GONE
        peopleContainer.visibility = View.GONE
        peopleContainer.removeAllViews()
        updateComposeState()
    }

    private fun startMessage() {
        val recipient = recipientInput.text?.toString().orEmpty().trim()
        val body = messageInput.text?.toString().orEmpty().trim()
        if (recipient.isBlank()) {
            Toast.makeText(this, "Choose someone or enter a wallet/DID", Toast.LENGTH_SHORT).show()
            return
        }
        if (body.isBlank()) {
            Toast.makeText(this, "Write a message first", Toast.LENGTH_SHORT).show()
            return
        }

        // Until Android registers and resolves native message prekeys end-to-end,
        // this keeps the user in a familiar messaging flow instead of a dead end.
        val text = "$body\n\nMessage me on Ghola: ${inviteLink()}"
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "Ghola message")
            putExtra(Intent.EXTRA_TEXT, text)
        }
        startActivity(Intent.createChooser(send, "Send message"))
    }

    private fun updateRecipientStatus(raw: String) {
        val value = raw.trim()
        val state = recipientState(value)
        val showRecipientSignal = state != RecipientState.Empty && state != RecipientState.Searching
        recipientModeLine.visibility = if (showRecipientSignal) View.VISIBLE else View.GONE
        recipientStatus.visibility = if (showRecipientSignal) View.VISIBLE else View.GONE
        recipientModeLine.text = when (state) {
            RecipientState.Empty -> "TO"
            RecipientState.Searching -> "SEARCHING"
            RecipientState.Recent -> "CONTACT"
            RecipientState.Did -> "DID"
            RecipientState.InviteLink -> "INVITE"
            RecipientState.Wallet -> "WALLET"
            RecipientState.Unknown -> "NOT FOUND"
        }
        recipientModeLine.setTextColor(
            when (state) {
                RecipientState.Unknown -> 0xFFFFB86B.toInt()
                RecipientState.Empty, RecipientState.Searching -> 0xFF4A5568.toInt()
                else -> 0xFF3DA8FF.toInt()
            },
        )
        recipientStatus.setTextColor(
            when (state) {
                RecipientState.Unknown -> 0xFF8B95A8.toInt()
                RecipientState.Empty, RecipientState.Searching -> 0xFF4A5568.toInt()
                else -> 0xFF8B95A8.toInt()
            },
        )
        recipientStatus.text = when (state) {
            RecipientState.Empty ->
                "Name, handle, wallet, or DID."
            RecipientState.Searching ->
                "Searching..."
            RecipientState.Recent ->
                "Matched."
            RecipientState.Did ->
                "DID recognized."
            RecipientState.InviteLink ->
                "Invite recognized."
            RecipientState.Wallet ->
                "Wallet recognized."
            RecipientState.Unknown ->
                "Not found. Invite?"
        }
    }

    private fun updateComposeState() {
        val recipient = recipientInput.text?.toString().orEmpty().trim()
        val message = messageInput.text?.toString().orEmpty().trim()
        updateRecipientStatus(recipient)

        val recipientReady = recipient.isNotBlank() && recipientState(recipient) != RecipientState.Searching
        val messageReady = message.isNotBlank()
        val ready = recipientReady && messageReady
        startMessageButton.isEnabled = ready
        startMessageButton.alpha = if (ready) 1f else 0.45f
        startMessageButton.text = when {
            recipientState(recipient) == RecipientState.Unknown -> "SEND INVITE"
            else -> "SEND"
        }
    }

    private fun recipientState(value: String): RecipientState = when {
        value.isBlank() -> RecipientState.Empty
        knownRecipients.any { it.equals(value, ignoreCase = true) } -> RecipientState.Recent
        value.startsWith("did:key:z") -> RecipientState.Did
        value.startsWith("https://ghola.xyz/invite", ignoreCase = true) -> RecipientState.InviteLink
        looksLikeSolanaWallet(value) -> RecipientState.Wallet
        value.length < 3 -> RecipientState.Searching
        else -> RecipientState.Unknown
    }

    private enum class RecipientState {
        Empty,
        Searching,
        Recent,
        Did,
        InviteLink,
        Wallet,
        Unknown,
    }

    private fun shareInvite() {
        val text = "Message me on Ghola: ${inviteLink()}"
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "Message me on Ghola")
            putExtra(Intent.EXTRA_TEXT, text)
        }
        startActivity(Intent.createChooser(send, "Invite someone"))
    }

    private fun personRow(title: String, body: String, recipient: String?): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(18), 0, dp(18))
            if (recipient != null) {
                isClickable = true
                isFocusable = true
                setOnClickListener {
                    recipientInput.setText(recipient)
                    recipientInput.setSelection(recipientInput.text.length)
                    composeStatus.text = ""
                }
            }
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

    private fun inviteLink(): String {
        val wallet = storage.getSolanaAddress()?.trim().orEmpty()
        if (wallet.isBlank()) return "https://ghola.xyz/invite"
        val encoded = URLEncoder.encode(wallet, StandardCharsets.UTF_8.name())
        return "https://ghola.xyz/invite?from=$encoded"
    }

    private fun mask(raw: String): String {
        val value = raw.trim()
        if (value.length <= 16) return value
        return "${value.take(6)}...${value.takeLast(6)}"
    }

    private fun looksLikeSolanaWallet(value: String): Boolean {
        if (value.length !in 32..44) return false
        return value.all { ch ->
            ch in '1'..'9' ||
                ch in 'A'..'H' ||
                ch in 'J'..'N' ||
                ch in 'P'..'Z' ||
                ch in 'a'..'k' ||
                ch in 'm'..'z'
        }
    }

    private fun dp(value: Int): Int {
        return (value * resources.displayMetrics.density).toInt()
    }
}

package xyz.ghola.app.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.View
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.android.material.card.MaterialCardView
import xyz.ghola.app.BuildConfig
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.CloudAuthManager
import xyz.ghola.app.cloud.TaskClassifier
import xyz.ghola.app.cloud.ThumperCloudClient
import xyz.ghola.app.demo.DemoScript
import xyz.ghola.app.service.VoiceInputService

/**
 * New home screen for Ghola's trading-agent command center.
 * Shows balance, active tasks, trading shortcuts, and the blue action orb.
 */
class HomeActivity : AppCompatActivity(), VoiceInputService.VoiceListener {

    companion object {
        private const val TAG = "HomeActivity"
        private const val REQUEST_AUDIO_PERMISSION = 100
    }

    private lateinit var secureStorage: SecureStorage
    private var voiceService: VoiceInputService? = null
    private lateinit var greetingText: TextView
    private lateinit var activeTasksContainer: LinearLayout
    private lateinit var quickActionsContainer: View
    private lateinit var micFab: ImageButton
    private lateinit var voiceStatusText: TextView
    private lateinit var homeWalletButton: TextView

    private var cloudClient: ThumperCloudClient? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_home)

        secureStorage = SecureStorage(this)
        if (BuildConfig.GHOLA_VOICE_INPUT_ENABLED) {
            voiceService = VoiceInputService(this).also { it.initialize(this) }
        }

        greetingText = findViewById(R.id.greetingText)
        activeTasksContainer = findViewById(R.id.activeTasksContainer)
        quickActionsContainer = findViewById(R.id.quickActionsContainer)
        micFab = findViewById(R.id.micFab)
        voiceStatusText = findViewById(R.id.voiceStatusText)
        homeWalletButton = findViewById(R.id.homeWalletButton)

        findViewById<View>(R.id.micOrbContainer).visibility =
            if (BuildConfig.GHOLA_VOICE_INPUT_ENABLED) View.VISIBLE else View.GONE
        micFab.setImageResource(
            if (BuildConfig.GHOLA_VOICE_INPUT_ENABLED) {
                android.R.drawable.ic_btn_speak_now
            } else {
                android.R.drawable.ic_menu_send
            }
        )
        micFab.setOnClickListener {
            if (BuildConfig.GHOLA_VOICE_INPUT_ENABLED) {
                toggleVoiceInput()
            } else {
                startActivity(Intent(this, ChatActivity::class.java))
            }
        }

        // Quick-action tiles → secondary surfaces. Markets/Agents/Activity live
        // in the bottom nav, so these are the destinations that don't.
        findViewById<MaterialCardView>(R.id.actionCall).setOnClickListener {
            startActivity(Intent(this, WalletActivity::class.java))
        }
        findViewById<MaterialCardView>(R.id.actionDevice).setOnClickListener {
            startActivity(Intent(this, MessagesActivity::class.java))
        }
        findViewById<MaterialCardView>(R.id.actionChat).setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
        // Hero primary CTA → markets/trade terminal.
        findViewById<View>(R.id.launchTerminalButton).setOnClickListener {
            startMarketChart("trade")
        }

        // Settings button in greeting area
        findViewById<View>(R.id.profileButton).setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
        homeWalletButton.setOnClickListener {
            startActivity(Intent(this, WalletActivity::class.java))
        }

        // Phase M6: Bottom navigation
        val bottomNav = findViewById<com.google.android.material.bottomnavigation.BottomNavigationView>(R.id.bottomNav)
        BottomNavHelper.attach(this, R.id.tab_assistant, bottomNav)
    }

    override fun onResume() {
        super.onResume()
        if (!secureStorage.hasCloudAuth()) {
            startActivity(Intent(this, OnboardingActivity::class.java))
            return
        }
        updateGreeting()
        updateWalletEntry()
        initCloudClient()
        refreshActiveTasks()
    }

    override fun onDestroy() {
        super.onDestroy()
        voiceService?.destroy()
    }

    private fun updateGreeting() {
        val name = secureStorage.getUserDisplayName()
        val hour = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY)
        val timeGreeting = when {
            hour < 12 -> "Good morning"
            hour < 17 -> "Good afternoon"
            else -> "Good evening"
        }
        greetingText.text = if (name != null) {
            "$timeGreeting, $name"
        } else {
            "$timeGreeting"
        }
    }

    private fun updateWalletEntry() {
        val address = secureStorage.getSolanaAddress()
        homeWalletButton.text = if (address.isNullOrBlank()) {
            "CONNECT WALLET"
        } else {
            "WALLET ${mask(address)}"
        }
    }

    private fun initCloudClient() {
        if (secureStorage.hasCloudAuth()) {
            cloudClient = ThumperCloudClient(
                secureStorage.getCloudBaseUrl(),
                secureStorage.getCloudAuthToken()!!
            )
        }
    }

    private fun refreshActiveTasks() {
        activeTasksContainer.removeAllViews()

        val client = cloudClient ?: return

        Thread {
            val tasks = client.listTasks(status = "in_progress", limit = 5)
            runOnUiThread {
                if (tasks != null && tasks.length() > 0) {
                    for (i in 0 until tasks.length()) {
                        val task = tasks.getJSONObject(i)
                        addTaskCard(
                            task.optString("task_type", "task"),
                            task.optString("status", "pending"),
                            task.optString("id")
                        )
                    }
                } else {
                    activeTasksContainer.addView(buildEmptyTasksView())
                }
            }
        }.start()
    }

    private fun addTaskCard(taskType: String, status: String, taskId: String) {
        val card = layoutInflater.inflate(R.layout.item_task_card, activeTasksContainer, false)
        card.findViewById<TextView>(R.id.taskTitle).text = formatTaskType(taskType)
        card.findViewById<TextView>(R.id.taskStatus).text = status.replace("_", " ")
        card.setOnClickListener {
            val intent = Intent(this, TaskDetailActivity::class.java)
            intent.putExtra("task_id", taskId)
            startActivity(intent)
        }
        activeTasksContainer.addView(card)
    }

    /** Styled empty-state card for the Recent activity section. */
    private fun buildEmptyTasksView(): View {
        val density = resources.displayMetrics.density
        fun dp(v: Int) = (v * density).toInt()

        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = ContextCompat.getDrawable(this@HomeActivity, R.drawable.bg_pill_trust)
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }
        val title = TextView(this).apply {
            text = getString(R.string.home_empty_tasks)
            setTextColor(ContextCompat.getColor(this@HomeActivity, R.color.ghola_text_secondary))
            textSize = 14f
        }
        val subtitle = TextView(this).apply {
            text = getString(R.string.home_empty_tasks_sub)
            setTextColor(ContextCompat.getColor(this@HomeActivity, R.color.ghola_text_muted))
            textSize = 12.5f
            setPadding(0, dp(4), 0, 0)
        }
        container.addView(title)
        container.addView(subtitle)
        return container
    }

    private fun formatTaskType(type: String): String = when (type) {
        "call" -> "Phone Call"
        "email" -> "Email"
        "calendar" -> "Calendar"
        "market_analysis" -> "Market Brief"
        "trade_plan" -> "Trade Plan"
        "agent_task" -> "Agent Task"
        "device_action" -> "Device Action"
        else -> type.replaceFirstChar { it.uppercase() }
    }

    private fun mask(raw: String): String {
        val value = raw.trim()
        if (value.length <= 16) return value
        return "${value.take(6)}...${value.takeLast(6)}"
    }

    private fun startChatWith(prefill: String, quickAction: String? = null) {
        val intent = Intent(this, ChatActivity::class.java)
        intent.putExtra("prefill_message", prefill)
        if (quickAction != null) intent.putExtra("quick_action", quickAction)
        startActivity(intent)
    }

    private fun startMarketChart(action: String) {
        val intent = Intent(this, MarketChartActivity::class.java)
        intent.putExtra(MarketChartActivity.EXTRA_ACTION, action)
        startActivity(intent)
    }

    // --- Voice Input ---

    private fun toggleVoiceInput() {
        val voice = voiceService ?: run {
            Toast.makeText(this, "Voice input is not enabled in this build", Toast.LENGTH_SHORT).show()
            return
        }

        if (!voice.isAvailable()) {
            Toast.makeText(this, "Voice input not available on this device", Toast.LENGTH_SHORT).show()
            return
        }

        // Check audio permission
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.RECORD_AUDIO),
                REQUEST_AUDIO_PERMISSION
            )
            return
        }

        if (voice.isCurrentlyListening()) {
            voice.stopListening()
        } else {
            voice.startListening()
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_AUDIO_PERMISSION &&
            grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            voiceService?.startListening()
        }
    }

    // VoiceListener implementation

    override fun onPartialResult(text: String) {
        voiceStatusText.text = text
        voiceStatusText.visibility = View.VISIBLE
    }

    override fun onFinalResult(text: String) {
        voiceStatusText.visibility = View.GONE

        // Demo-mode voice routing: every phrase the presenter might utter
        // maps to a local action (open url, switch tab, pull notifications).
        // If DemoScript handles it, skip the normal cloud-classification path
        // entirely — no backend dependency, no LLM, no risk of live failure.
        if (DemoScript.handle(this, text)) return

        // Classify and route (fallback for anything DemoScript didn't match)
        val classification = TaskClassifier.classify(text, secureStorage.hasCloudAuth())
        when (classification.route) {
            TaskClassifier.TaskRoute.CLOUD_CALL,
            TaskClassifier.TaskRoute.CLOUD_EMAIL,
            TaskClassifier.TaskRoute.CLOUD_CALENDAR -> {
                // Route to cloud via ChatActivity with prefill
                startChatWith(text)
            }
            TaskClassifier.TaskRoute.DEVICE,
            TaskClassifier.TaskRoute.CHAT -> {
                // Route to device agent
                val intent = Intent(this, ChatActivity::class.java)
                intent.putExtra("prefill_message", text)
                startActivity(intent)
            }
        }
    }

    override fun onError(errorCode: Int, message: String) {
        voiceStatusText.visibility = View.GONE
        if (errorCode != android.speech.SpeechRecognizer.ERROR_NO_MATCH) {
            Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
        }
    }

    override fun onListeningStarted() {
        micFab.setImageResource(android.R.drawable.ic_btn_speak_now)
        voiceStatusText.text = "Listening..."
        voiceStatusText.visibility = View.VISIBLE
    }

    override fun onListeningStopped() {
        micFab.setImageResource(android.R.drawable.ic_menu_send)
        voiceStatusText.visibility = View.GONE
    }
}

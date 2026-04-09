package xyz.ghola.app.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.android.material.card.MaterialCardView
import com.google.android.material.floatingactionbutton.FloatingActionButton
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.CloudAuthManager
import xyz.ghola.app.cloud.TaskClassifier
import xyz.ghola.app.cloud.ThumperCloudClient
import xyz.ghola.app.demo.DemoScript
import xyz.ghola.app.service.VoiceInputService
import xyz.ghola.app.util.AccessibilityUtil

/**
 * New home screen for Thumper — the AI personal assistant.
 * Shows greeting, active tasks, quick actions, and mic FAB.
 * Routes to ChatActivity for device control or cloud for calls/emails.
 */
class HomeActivity : AppCompatActivity(), VoiceInputService.VoiceListener {

    companion object {
        private const val TAG = "HomeActivity"
        private const val REQUEST_AUDIO_PERMISSION = 100
    }

    private lateinit var secureStorage: SecureStorage
    private lateinit var voiceService: VoiceInputService
    private lateinit var greetingText: TextView
    private lateinit var activeTasksContainer: LinearLayout
    private lateinit var quickActionsContainer: LinearLayout
    private lateinit var micFab: FloatingActionButton
    private lateinit var voiceStatusText: TextView

    private var cloudClient: ThumperCloudClient? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        secureStorage = SecureStorage(this)

        // Op-Better #4: one-shot first-run sequencer. If this is the very
        // first launch after install, hand off to FirstRunActivity before
        // inflating the home layout at all. FirstRunActivity finishes back
        // into HomeActivity with the flag set to true.
        if (!secureStorage.isFirstRunCompleted()) {
            val intent = Intent(this, FirstRunActivity::class.java)
            startActivity(intent)
            finish()
            return
        }

        setContentView(R.layout.activity_home)

        voiceService = VoiceInputService(this)
        voiceService.initialize(this)

        greetingText = findViewById(R.id.greetingText)
        activeTasksContainer = findViewById(R.id.activeTasksContainer)
        quickActionsContainer = findViewById(R.id.quickActionsContainer)
        micFab = findViewById(R.id.micFab)
        voiceStatusText = findViewById(R.id.voiceStatusText)

        // Mic FAB
        // Mic + Device card both NEED accessibility (they drive other apps).
        // Call / Email / Chat go through cloud LLM + don't touch other apps,
        // so they don't need the accessibility gate.
        micFab.setOnClickListener {
            if (ensureAccessibilityOrPrompt()) toggleVoiceInput()
        }

        // Quick action buttons
        findViewById<MaterialCardView>(R.id.actionCall).setOnClickListener {
            startChatWith("I need to make a phone call")
        }
        findViewById<MaterialCardView>(R.id.actionEmail).setOnClickListener {
            startChatWith("I need to send an email")
        }
        findViewById<MaterialCardView>(R.id.actionDevice).setOnClickListener {
            if (ensureAccessibilityOrPrompt()) {
                startActivity(Intent(this, ChatActivity::class.java))
            }
        }
        // Phase M6: bottom nav now handles Agents tab. actionChat reverts
        // to opening ChatActivity (its original behavior pre-M5).
        findViewById<MaterialCardView>(R.id.actionChat).setOnClickListener {
            startActivity(Intent(this, ChatActivity::class.java))
        }

        // Settings button in greeting area
        findViewById<View>(R.id.profileButton).setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }

        // Phase M6: Bottom navigation
        val bottomNav = findViewById<com.google.android.material.bottomnavigation.BottomNavigationView>(R.id.bottomNav)
        BottomNavHelper.attach(this, R.id.tab_assistant, bottomNav)
    }

    override fun onResume() {
        super.onResume()
        updateGreeting()
        refreshActiveTasks()
        initCloudClient()
        // Op-Better #2: accessibility prompt no longer fires here.
        // The home screen should NEVER bug the user on launch — we only
        // ask for accessibility at the exact moment the user tries to
        // drive another app. See `ensureAccessibilityOrPrompt()`.
    }

    /**
     * Op-Better #2: lazy accessibility gate.
     *
     * Call this at the top of any action that actually needs the
     * accessibility service (tap mic, tap Device card, tap "open X"
     * chat suggestion). Returns true if the service is already enabled
     * — the caller should proceed normally. Returns false if the
     * service is missing — the caller should stop and the onboarding
     * activity is launched instead.
     *
     * This replaces the old `maybePromptForAccessibility()` that fired
     * on every onResume and annoyed users who were just browsing.
     */
    private fun ensureAccessibilityOrPrompt(): Boolean {
        if (AccessibilityUtil.isServiceEnabled(this)) return true
        startActivity(Intent(this, AccessibilityOnboardingActivity::class.java))
        return false
    }

    override fun onDestroy() {
        super.onDestroy()
        // Guard against the first-run early-return path, where onCreate
        // finishes before `voiceService` gets initialized. Touching an
        // uninitialized lateinit property throws.
        if (::voiceService.isInitialized) {
            voiceService.destroy()
        }
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
                    val emptyText = TextView(this).apply {
                        text = "No active tasks"
                        setTextColor(0xFF999999.toInt())
                        setPadding(16, 8, 16, 8)
                    }
                    activeTasksContainer.addView(emptyText)
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

    private fun formatTaskType(type: String): String = when (type) {
        "call" -> "Phone Call"
        "email" -> "Email"
        "calendar" -> "Calendar"
        "device_action" -> "Device Action"
        else -> type.replaceFirstChar { it.uppercase() }
    }

    private fun startChatWith(prefill: String) {
        val intent = Intent(this, ChatActivity::class.java)
        intent.putExtra("prefill_message", prefill)
        startActivity(intent)
    }

    // --- Voice Input ---

    private fun toggleVoiceInput() {
        if (!voiceService.isAvailable()) {
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

        if (voiceService.isCurrentlyListening()) {
            voiceService.stopListening()
        } else {
            voiceService.startListening()
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_AUDIO_PERMISSION &&
            grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            voiceService.startListening()
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
                intent.putExtra("auto_send", true)
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
        micFab.setImageResource(android.R.drawable.ic_btn_speak_now)
        voiceStatusText.visibility = View.GONE
    }
}

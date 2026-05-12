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
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.AppForegroundCoordinator
import xyz.ghola.app.cloud.CloudAuthManager
import xyz.ghola.app.cloud.TaskClassifier
import xyz.ghola.app.cloud.ThumperCloudClient
import xyz.ghola.app.demo.DemoScript
import xyz.ghola.app.service.VoiceInputService

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
        setContentView(R.layout.activity_home)

        secureStorage = SecureStorage(this)
        voiceService = VoiceInputService(this)
        voiceService.initialize(this)

        greetingText = findViewById(R.id.greetingText)
        activeTasksContainer = findViewById(R.id.activeTasksContainer)
        quickActionsContainer = findViewById(R.id.quickActionsContainer)
        micFab = findViewById(R.id.micFab)
        voiceStatusText = findViewById(R.id.voiceStatusText)

        // Mic FAB
        micFab.setOnClickListener { toggleVoiceInput() }

        // Quick action buttons.
        //
        // Call/Email require cloud auth (Bland AI / Gmail OAuth). If the
        // user's wallet sign-in is missing or expired, we toast + bounce them
        // to OnboardingActivity at the SIWS step instead of letting the tap
        // silently no-op (the v0.4 user-reported "tile doesn't work" bug).
        findViewById<MaterialCardView>(R.id.actionCall).setOnClickListener {
            if (requireCloudAuthOrBounce(getString(R.string.cloud_required_for_call))) {
                startChatWith("I need to make a phone call", autoSend = true, forceCloudRoute = "call")
            }
        }
        findViewById<MaterialCardView>(R.id.actionEmail).setOnClickListener {
            if (requireCloudAuthOrBounce(getString(R.string.cloud_required_for_email))) {
                startChatWith("I need to send an email", autoSend = true, forceCloudRoute = "email")
            }
        }
        // Device + Chat tiles don't need cloud auth — they route to the
        // local agent / device-control surface.
        findViewById<MaterialCardView>(R.id.actionDevice).setOnClickListener {
            startActivity(Intent(this, ChatActivity::class.java))
        }
        findViewById<MaterialCardView>(R.id.actionChat).setOnClickListener {
            startActivity(Intent(this, ChatActivity::class.java))
        }

        // Settings button in greeting area
        findViewById<View>(R.id.profileButton).setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
        // v0.6 dev shortcut: long-press the profile icon to run the Phase A.3
        // parity check directly, bypassing the Settings → radio → long-press
        // path. Reads the GGUF from whichever location it actually exists in.
        findViewById<View>(R.id.profileButton).setOnLongClickListener {
            runParityCheckDirect()
            true
        }

        // Phase M6: Bottom navigation
        val bottomNav = findViewById<com.google.android.material.bottomnavigation.BottomNavigationView>(R.id.bottomNav)
        BottomNavHelper.attach(this, R.id.tab_assistant, bottomNav)
    }

    /**
     * Phase A.3 parity check direct invocation. Looks for the GGUF in the
     * standard external location first (where ModelManager expects it) and
     * falls back to the internal files dir (where adb push via run-as
     * lands it during dev).
     */
    private fun runParityCheckDirect() {
        // Let the dev pick scale — fast iteration vs ship gate.
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Parity check scale")
            .setItems(arrayOf(
                "Quick (3 tokens, ~30s)",
                "Standard (10 tokens, ~90s)",
                "Full (20 tokens, ~3 min)",
            )) { _, which ->
                val n = when (which) { 0 -> 3; 1 -> 10; else -> 20 }
                doParityCheck(n)
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun doParityCheck(maxTokens: Int) {
        val externalPath = java.io.File(
            getExternalFilesDir(null),
            "models/qwen2.5-1.5b-instruct-q8_0.gguf",
        )
        val internalPath = java.io.File(
            filesDir,
            "models/qwen2.5-1.5b-instruct-q8_0.gguf",
        )
        val gguf = when {
            externalPath.exists() && externalPath.length() > 0 -> externalPath
            internalPath.exists() && internalPath.length() > 0 -> internalPath
            else -> {
                Toast.makeText(this, "GGUF not found in either external or internal storage", Toast.LENGTH_LONG).show()
                return
            }
        }
        val sizeMb = gguf.length() / 1024 / 1024
        val prompt = "<|im_start|>user\nWrite one sentence about Solana.<|im_end|>\n<|im_start|>assistant\n"

        val progress = androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Parity check ($maxTokens tokens)")
            .setMessage("Running greedy decode on both paths…\nGGUF: ${gguf.name} (${sizeMb} MB)")
            .setCancelable(false)
            .show()

        lifecycleScope.launch {
            val matched = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                runCatching {
                    xyz.ghola.app.ai.llama.LlamaCpp().parityCheck(gguf.absolutePath, prompt, maxTokens)
                }.getOrElse {
                    android.util.Log.e(TAG, "parityCheck raised", it)
                    -1
                }
            }
            progress.dismiss()
            val warnFloor = (maxTokens * 0.9f).toInt() // ≥90% = WARN tier, else FAIL
            val verdict = when {
                matched < 0 -> "ERROR — see logcat (LlamaCpp tag)"
                matched == maxTokens -> "PASS — forward is correct, Phase C is safe to run"
                matched >= warnFloor -> "WARN — $matched/$maxTokens; minor numerical drift, check logcat"
                matched == 0 -> "FAIL @ token 0 — bug in tok_embed or first attention block"
                else -> "FAIL @ token $matched — bug in a deeper layer"
            }
            androidx.appcompat.app.AlertDialog.Builder(this@HomeActivity)
                .setTitle("Parity check: $matched/$maxTokens")
                .setMessage(verdict)
                .setPositiveButton("OK", null)
                .show()
        }
    }

    override fun onResume() {
        super.onResume()
        // Single decision point for "do we have valid auth?" — runs a silent
        // refresh if needed, falls back to false if no recovery path. This
        // replaces the old `hasCloudAuth()` check which reported expired
        // tokens as valid.
        lifecycleScope.launch {
            val valid = AppForegroundCoordinator.ensureAuthValid(this@HomeActivity)
            if (!valid) {
                startActivity(
                    Intent(this@HomeActivity, OnboardingActivity::class.java).apply {
                        putExtra(OnboardingActivity.EXTRA_STEP, OnboardingActivity.STEP_SIWS)
                    }
                )
                finish()
                return@launch
            }
            updateGreeting()
            refreshActiveTasks()
            initCloudClient()
        }
    }

    /**
     * Returns true if we have valid cloud auth. Otherwise toasts the provided
     * reason and routes the user back through onboarding (landing on the
     * wallet sign-in step). Used by the Call/Email tiles to prevent silent
     * no-ops on fresh/stale installs.
     */
    private fun requireCloudAuthOrBounce(reason: String): Boolean {
        if (secureStorage.hasCloudAuth()) return true
        Toast.makeText(this, reason, Toast.LENGTH_LONG).show()
        startActivity(
            Intent(this, OnboardingActivity::class.java).apply {
                putExtra(OnboardingActivity.EXTRA_STEP, OnboardingActivity.STEP_SIWS)
            }
        )
        return false
    }

    override fun onDestroy() {
        super.onDestroy()
        voiceService.destroy()
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

    private fun startChatWith(
        prefill: String,
        autoSend: Boolean = false,
        forceCloudRoute: String? = null
    ) {
        val intent = Intent(this, ChatActivity::class.java)
        intent.putExtra("prefill_message", prefill)
        intent.putExtra("auto_send", autoSend)
        if (forceCloudRoute != null) {
            intent.putExtra("force_cloud_route", forceCloudRoute)
        }
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

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
        // v0.6 dev shortcut: long-press the profile icon to open a chooser
        // for every Phase A→H gate. Bypasses Settings → radio → long-press.
        findViewById<View>(R.id.profileButton).setOnLongClickListener {
            showDevGauntletChooser()
            true
        }

        // Phase M6: Bottom navigation
        val bottomNav = findViewById<com.google.android.material.bottomnavigation.BottomNavigationView>(R.id.bottomNav)
        BottomNavHelper.attach(this, R.id.tab_assistant, bottomNav)
    }

    /**
     * v0.6 dev gauntlet — one menu for every Phase A→H gate. Each entry
     * runs on Dispatchers.IO and reports the verdict in a dialog.
     */
    private fun showDevGauntletChooser() {
        val entries = arrayOf(
            "▶ Run full gauntlet (auto)",
            "Parity check (Phase A.3)",
            "Banana test (Phase H.1)",
            "Ship/no-ship gates (Phase H)",
            "Clean test artifacts",
            "Show paths + storage",
            "Warm up inference",
        )
        // Build stamp surfaces in the dialog title so a quick long-press
        // confirms "yes, the latest commit is installed." Includes relative
        // "built Nm ago" so it's obvious if the install is stale.
        val ageMin = ((System.currentTimeMillis() -
                       xyz.ghola.app.BuildConfig.BUILD_STAMP.toLongOrNull().let { it ?: 0L })
                      / 60000L).coerceAtLeast(0L)
        val stampSuffix = " · ${xyz.ghola.app.BuildConfig.GIT_SHA} · ${ageMin}m"
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("v0.6 dev gauntlet$stampSuffix")
            .setItems(entries) { _, which ->
                when (which) {
                    0 -> runFullGauntlet()
                    1 -> runParityCheckDirect()
                    2 -> runBananaTestDirect()
                    3 -> runShipGatesDirect()
                    4 -> cleanTestArtifactsDirect()
                    5 -> showPathsDiag()
                    6 -> warmUpInference()
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun runBananaTestDirect() {
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Banana test")
            .setMessage("Train a fresh LoRA on 200 synthetic 'banana' pairs and verify the model overfits. ~5-10 min. Plug in to charge.")
            .setPositiveButton("Run") { _, _ ->
                val progress = androidx.appcompat.app.AlertDialog.Builder(this)
                    .setTitle("Banana test")
                    .setMessage("Starting…")
                    .setCancelable(false)
                    .show()
                lifecycleScope.launch {
                    val v = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                        runCatching {
                            xyz.ghola.app.ml.BananaTest.runOnce(
                                this@HomeActivity,
                                callback = object : xyz.ghola.app.ai.llama.LlamaFinetune.ProgressCallback {
                                    override fun onEpoch(epoch: Int, totalEpochs: Int, lossSoFar: Float) {
                                        runOnUiThread { progress.setMessage("Epoch $epoch/$totalEpochs — loss=${"%.4f".format(lossSoFar)}") }
                                    }
                                    override fun onStep(step: Int, totalSteps: Int, loss: Float) {
                                        if (step % 20 == 0) runOnUiThread { progress.setMessage("Step $step/$totalSteps — loss=${"%.4f".format(loss)}") }
                                    }
                                    override fun onComplete(adapterPath: String) { }
                                    override fun onError(message: String) { }
                                },
                            )
                        }.getOrElse {
                            xyz.ghola.app.ml.BananaTest.Verdict(
                                false, null, 0f, false, "exception: ${it.message}",
                            )
                        }
                    }
                    progress.dismiss()
                    val body = buildString {
                        append(v.message)
                        if (v.sampledOutput != null) {
                            append("\n\nSample:\n")
                            append(v.sampledOutput.take(200))
                        }
                    }
                    androidx.appcompat.app.AlertDialog.Builder(this@HomeActivity)
                        .setTitle(if (v.passes) "Banana test: PASS" else "Banana test: FAIL")
                        .setMessage(body)
                        .setPositiveButton("OK", null)
                        .show()
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun runShipGatesDirect() {
        val progress = androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Phase H gates")
            .setMessage("Running voice match + leakage + preference reports — ~20 min.")
            .setCancelable(false)
            .show()
        lifecycleScope.launch {
            val gates = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                runCatching { xyz.ghola.app.ml.VoiceMetric.phaseHGateReport(this@HomeActivity) }.getOrNull()
            }
            progress.dismiss()
            val body = if (gates == null) {
                "Gate evaluation failed — see logcat (VoiceMetric tag).\n\nIf 'no LoRA on disk' showed, run Banana test first."
            } else {
                buildString {
                    append("Gate 2 (voice match Δ): ").append(if (gates.voiceMatchPasses) "✅" else "❌")
                    gates.voiceMatchDelta?.let { append("  Δ=${"%.3f".format(it)}") }
                    append("\nGate 3 (leakage): ").append(if (gates.leakagePasses) "✅" else "❌")
                    append("\nGate 4 (A/B prefs): ").append(if (gates.preferencePasses) "✅" else "❌")
                    append("  n=${gates.preferenceN}")
                    append("\n\n").append(if (gates.passes) "SHIP ✅" else "BLOCK ❌")
                }
            }
            androidx.appcompat.app.AlertDialog.Builder(this@HomeActivity)
                .setTitle("Phase H result")
                .setMessage(body)
                .setPositiveButton("OK", null)
                .show()
        }
    }

    /** Storage diagnostic: where every relevant file lives + its size +
     *  whether it's readable. Surfaces the internal/external fallback
     *  resolution so you can see at a glance "yes, the GGUF is in
     *  internal because we side-loaded it via run-as". */
    private fun showPathsDiag() {
        val mm = xyz.ghola.app.ai.llama.ModelManager(this)
        fun describe(f: java.io.File): String {
            return if (!f.exists()) "MISSING"
            else "${mm.formatSize(f.length())} (${if (f.canRead()) "readable" else "unreadable"})"
        }
        val externalGguf = java.io.File(
            getExternalFilesDir(null), "models/qwen2.5-1.5b-instruct-q8_0.gguf"
        )
        val internalGguf = java.io.File(filesDir, "models/qwen2.5-1.5b-instruct-q8_0.gguf")
        val activeGguf = java.io.File(mm.getModelPath())
        val lora = mm.getLoraFile()
        val bananaLora = java.io.File(mm.getLoraFile().absolutePath + ".banana")
        val partial = java.io.File(mm.getLoraFile().absolutePath + ".partial")
        val centroid = mm.getCentroidFile()
        val jsonl = java.io.File(cacheDir, "finetune/train.jsonl")
        val bananaJsonl = java.io.File(cacheDir, "finetune/banana_test.jsonl")

        // Read VmRSS for live memory snapshot.
        val rssMb: Long = try {
            java.io.File("/proc/self/status").readLines()
                .firstOrNull { it.startsWith("VmRSS:") }
                ?.let { Regex("\\d+").find(it)?.value?.toLong()?.div(1024) ?: -1 }
                ?: -1
        } catch (_: Throwable) { -1L }

        // Free space on internal + external partitions.
        val intFree = filesDir.usableSpace / (1024L * 1024L)
        val extFree = (getExternalFilesDir(null)?.usableSpace ?: 0L) / (1024L * 1024L)

        val body = buildString {
            append("Build: ").append(xyz.ghola.app.BuildConfig.GIT_SHA).append("\n")
            append("RSS: ${rssMb} MB · free int=${intFree} MB ext=${extFree} MB\n\n")
            append("GGUF (external):\n  ${externalGguf.absolutePath}\n  ${describe(externalGguf)}\n\n")
            append("GGUF (internal):\n  ${internalGguf.absolutePath}\n  ${describe(internalGguf)}\n\n")
            append("ACTIVE GGUF:\n  ${activeGguf.absolutePath}\n\n")
            append("Voice LoRA:\n  ${describe(lora)}\n")
            append("Banana LoRA:\n  ${describe(bananaLora)}\n")
            append("Partial checkpoint:\n  ${describe(partial)}\n")
            append("Centroid:\n  ${describe(centroid)}\n\n")
            append("Train JSONL:\n  ${describe(jsonl)}\n")
            append("Banana JSONL:\n  ${describe(bananaJsonl)}\n")
        }
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Paths + storage")
            .setMessage(body)
            .setPositiveButton("OK", null)
            .show()
    }

    /** Auto-pipeline every gate. Runs parity@3 (~30s, gate A) → banana
     *  (~10 min, gate H.1) → ship gates (~20 min, gates H.2-4). Total
     *  runtime ~30 min; plug in to charge. Updates a single progress
     *  dialog with the current phase + best-effort verdict per phase.
     *
     *  Stops on first hard failure: parity FAIL aborts before banana
     *  (Phase C training would just produce garbage); banana FAIL aborts
     *  before ship gates (no LoRA to evaluate).
     */
    private fun runFullGauntlet() {
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Full gauntlet")
            .setMessage("Will run parity@3 → banana test → ship gates in sequence (~30 min total). Plug in to charge.")
            .setPositiveButton("Run") { _, _ -> launchFullGauntlet() }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun launchFullGauntlet() {
        val progress = androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Full gauntlet")
            .setMessage("Starting…")
            .setCancelable(false)
            .show()
        lifecycleScope.launch {
            val results = StringBuilder()

            // Phase A.3 parity @ 3
            runOnUiThread { progress.setMessage("Phase A.3 parity check (3 tokens)…") }
            val externalGguf = java.io.File(getExternalFilesDir(null), "models/qwen2.5-1.5b-instruct-q8_0.gguf")
            val internalGguf = java.io.File(filesDir, "models/qwen2.5-1.5b-instruct-q8_0.gguf")
            val gguf = if (externalGguf.exists() && externalGguf.length() > 0) externalGguf else internalGguf
            val parityPrompt = "<|im_start|>user\nWrite one sentence about Solana.<|im_end|>\n<|im_start|>assistant\n"
            val parityMatched = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                runCatching { xyz.ghola.app.ai.llama.LlamaCpp().parityCheck(gguf.absolutePath, parityPrompt, 3) }.getOrElse { -1 }
            }
            results.append("Parity (3 tok): ").append(if (parityMatched == 3) "✅ PASS" else "❌ $parityMatched/3").append("\n")
            if (parityMatched < 3) {
                progress.dismiss()
                showFinalGauntletDialog(results.toString(), passed = false, reason = "Parity failed — skipping banana + ship gates (Phase C would train garbage).")
                return@launch
            }

            // Phase H.1 banana
            runOnUiThread { progress.setMessage("Phase H.1 banana test (5-10 min)…") }
            val bananaVerdict = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                runCatching {
                    xyz.ghola.app.ml.BananaTest.runOnce(this@HomeActivity, callback = object : xyz.ghola.app.ai.llama.LlamaFinetune.ProgressCallback {
                        override fun onEpoch(epoch: Int, totalEpochs: Int, lossSoFar: Float) {
                            runOnUiThread { progress.setMessage("Banana epoch $epoch/$totalEpochs — loss=${"%.4f".format(lossSoFar)}") }
                        }
                        override fun onStep(step: Int, totalSteps: Int, loss: Float) {
                            if (step % 50 == 0) runOnUiThread { progress.setMessage("Banana step $step/$totalSteps — loss=${"%.4f".format(loss)}") }
                        }
                        override fun onComplete(adapterPath: String) { }
                        override fun onError(message: String) { }
                    })
                }.getOrElse { xyz.ghola.app.ml.BananaTest.Verdict(false, null, 0f, false, "exception: ${it.message}") }
            }
            results.append("Banana: ").append(if (bananaVerdict.passes) "✅ PASS" else "❌ ${(bananaVerdict.bananaFraction * 100).toInt()}%").append("\n")
            if (!bananaVerdict.passes) {
                progress.dismiss()
                showFinalGauntletDialog(results.toString(), passed = false, reason = "Banana failed — skipping ship gates (no LoRA to eval).")
                return@launch
            }

            // Phase H.2-4 ship gates — skip if only the banana LoRA exists
            // (no real voice LoRA yet, so the gates have nothing meaningful
            // to evaluate). Banana proves the chain; real ship gates need
            // PersonalFineTuneWorker to have run on actual sent emails.
            val mmCheck = xyz.ghola.app.ai.llama.ModelManager(this@HomeActivity)
            if (!mmCheck.isLoraReady()) {
                results.append("Ship gates: ⏭ skipped (no production LoRA — run PersonalFineTuneWorker against real corpus first)")
                progress.dismiss()
                showFinalGauntletDialog(results.toString(), passed = true, reason = "Banana passed. Ship-gates skipped: need a real (non-banana) voice LoRA before voice match / leakage / preference become meaningful.")
                return@launch
            }
            runOnUiThread { progress.setMessage("Phase H ship gates (~20 min)…") }
            val gates = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                runCatching { xyz.ghola.app.ml.VoiceMetric.phaseHGateReport(this@HomeActivity) }.getOrNull()
            }
            if (gates == null) {
                results.append("Ship gates: ⚠ eval failed")
            } else {
                results.append("Voice match: ").append(if (gates.voiceMatchPasses) "✅" else "❌")
                gates.voiceMatchDelta?.let { results.append(" Δ=${"%.3f".format(it)}") }
                results.append("\nLeakage: ").append(if (gates.leakagePasses) "✅" else "❌")
                results.append("\nA/B prefs: ").append(if (gates.preferencePasses) "✅" else "❌ n=${gates.preferenceN}")
            }
            progress.dismiss()
            showFinalGauntletDialog(
                results.toString(),
                passed = (gates?.passes == true),
                reason = if (gates?.passes == true) "All gates passed — SHIP." else "Some gates failed; see above.",
            )
        }
    }

    private fun showFinalGauntletDialog(report: String, passed: Boolean, reason: String) {
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle(if (passed) "Gauntlet: PASS ✅" else "Gauntlet: BLOCK ❌")
            .setMessage("$report\n\n$reason")
            .setPositiveButton("OK", null)
            .show()
    }

    /** Force LocalLlm to load the model + LoRA NOW so the next chat/test
     *  doesn't pay the 3-5s GGUF mmap cost. Useful right before a demo
     *  or before invoking the banana/parity tests. */
    private fun warmUpInference() {
        val progress = androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Warming up")
            .setMessage("Loading model + LoRA into memory…")
            .setCancelable(false)
            .show()
        lifecycleScope.launch {
            val t0 = System.currentTimeMillis()
            val result = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                runCatching {
                    val llm = xyz.ghola.app.email.LocalLlm.get(this@HomeActivity)
                    if (llm == null) "LocalLlm.get returned null"
                    else "ready (${xyz.ghola.app.ai.SecureStorage(this@HomeActivity).let { s ->
                        if (s.useLlamaCppRuntime()) "llama.cpp runtime" else "MediaPipe runtime"
                    }})"
                }.getOrElse { "error: ${it.message}" }
            }
            progress.dismiss()
            val dt = System.currentTimeMillis() - t0
            Toast.makeText(this@HomeActivity, "Warmup: $result · ${dt}ms", Toast.LENGTH_LONG).show()
        }
    }

    private fun cleanTestArtifactsDirect() {
        val mm = xyz.ghola.app.ai.llama.ModelManager(this)
        val candidates = listOf(
            java.io.File(mm.getLoraFile().absolutePath + ".banana"),
            java.io.File(mm.getLoraFile().absolutePath + ".partial"),
            java.io.File(cacheDir, "finetune/banana_test.jsonl"),
            java.io.File(cacheDir, "finetune/train.jsonl"),
        )
        val removed = candidates.filter { it.exists() }
        if (removed.isEmpty()) {
            Toast.makeText(this, "Nothing to clean", Toast.LENGTH_SHORT).show()
            return
        }
        removed.forEach { it.delete() }
        Toast.makeText(this, "Removed ${removed.size} file(s)", Toast.LENGTH_SHORT).show()
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

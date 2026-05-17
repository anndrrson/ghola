package xyz.ghola.app.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.MenuItem
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.textfield.TextInputEditText
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import xyz.ghola.app.R
import xyz.ghola.app.ai.ModelStatus
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.ai.litert.LiteRtModelManager
import xyz.ghola.app.ai.llama.ModelManager
import xyz.ghola.app.cloud.ThumperCloudClient
import xyz.ghola.app.service.ThumperAccessibilityService

class SettingsActivity : AppCompatActivity() {

    companion object {
        val MODEL_IDS = arrayOf(
            "claude-sonnet-4-5-20241022",
            "claude-opus-4-0-20250514",
            "claude-haiku-4-5-20251001"
        )
        val MODEL_NAMES = arrayOf(
            "Sonnet 4.5 (Recommended)",
            "Opus 4",
            "Haiku 4.5"
        )

        val QWEN_MODEL_IDS = arrayOf(
            "qwen-plus",
            "qwen-max"
        )
        val QWEN_MODEL_NAMES = arrayOf(
            "Qwen Plus (Recommended)",
            "Qwen Max"
        )
    }

    private lateinit var secureStorage: SecureStorage
    private lateinit var modelManager: ModelManager
    private lateinit var litertModelManager: LiteRtModelManager
    private val mainHandler = Handler(Looper.getMainLooper())

    // Backend selection
    private lateinit var backendRadioGroup: RadioGroup
    private lateinit var radioE2eCloud: RadioButton
    private lateinit var radioCloud: RadioButton
    private lateinit var radioQwenCloud: RadioButton
    private lateinit var radioLocal: RadioButton
    private lateinit var radioLitertNpu: RadioButton

    // Cloud section
    private lateinit var cloudSection: LinearLayout
    private lateinit var apiKeyInput: EditText
    private lateinit var modelSpinner: Spinner

    // Qwen cloud section
    private lateinit var qwenCloudSection: LinearLayout
    private lateinit var qwenApiKeyInput: EditText
    private lateinit var qwenModelSpinner: Spinner

    // Local section
    private lateinit var localSection: LinearLayout
    private lateinit var modelStatus: TextView
    private lateinit var downloadProgress: ProgressBar
    private lateinit var downloadPercent: TextView
    private lateinit var downloadButton: Button
    private lateinit var deleteModelButton: Button

    // LiteRT NPU section (Phase γ.3)
    private lateinit var litertNpuSection: LinearLayout
    private lateinit var litertNpuStatus: TextView
    private lateinit var litertNpuDownloadProgress: ProgressBar
    private lateinit var litertNpuDownloadPercent: TextView
    private lateinit var litertNpuDownloadButton: Button
    private lateinit var litertNpuDeleteButton: Button

    // HuggingFace Bearer token (Phase γ.4 / L3) — nested inside the NPU
    // section in the layout because the gated repo it unlocks is the
    // only download path that consumes it today.
    private lateinit var hfTokenInput: TextInputEditText
    private lateinit var hfTokenSaveButton: Button
    private lateinit var hfTokenClearButton: Button
    private lateinit var hfTokenStatusText: TextView

    // Common
    private lateinit var a11yStatus: TextView
    private lateinit var enableA11yButton: Button
    private lateinit var openRelayButton: Button
    private lateinit var connectGoogleButton: Button
    private lateinit var saveButton: Button

    private var isDownloading = false
    private var isLitertDownloading = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        supportActionBar?.title = "Settings"

        secureStorage = SecureStorage(this)
        modelManager = ModelManager(this)
        litertModelManager = LiteRtModelManager(this)

        // Bind views
        backendRadioGroup = findViewById(R.id.backendRadioGroup)
        radioE2eCloud = findViewById(R.id.radioE2eCloud)
        radioCloud = findViewById(R.id.radioCloud)
        radioQwenCloud = findViewById(R.id.radioQwenCloud)
        radioLocal = findViewById(R.id.radioLocal)
        radioLitertNpu = findViewById(R.id.radioLitertNpu)
        cloudSection = findViewById(R.id.cloudSection)
        qwenCloudSection = findViewById(R.id.qwenCloudSection)
        localSection = findViewById(R.id.localSection)
        apiKeyInput = findViewById(R.id.apiKeyInput)
        modelSpinner = findViewById(R.id.modelSpinner)
        qwenApiKeyInput = findViewById(R.id.qwenApiKeyInput)
        qwenModelSpinner = findViewById(R.id.qwenModelSpinner)
        modelStatus = findViewById(R.id.modelStatus)
        downloadProgress = findViewById(R.id.downloadProgress)
        downloadPercent = findViewById(R.id.downloadPercent)
        downloadButton = findViewById(R.id.downloadButton)
        deleteModelButton = findViewById(R.id.deleteModelButton)
        litertNpuSection = findViewById(R.id.litertNpuSection)
        litertNpuStatus = findViewById(R.id.litertNpuStatus)
        litertNpuDownloadProgress = findViewById(R.id.litertNpuDownloadProgress)
        litertNpuDownloadPercent = findViewById(R.id.litertNpuDownloadPercent)
        litertNpuDownloadButton = findViewById(R.id.litertNpuDownloadButton)
        litertNpuDeleteButton = findViewById(R.id.litertNpuDeleteButton)
        hfTokenInput = findViewById(R.id.hfTokenInput)
        hfTokenSaveButton = findViewById(R.id.hfTokenSaveButton)
        hfTokenClearButton = findViewById(R.id.hfTokenClearButton)
        hfTokenStatusText = findViewById(R.id.hfTokenStatus)
        a11yStatus = findViewById(R.id.a11yStatus)
        enableA11yButton = findViewById(R.id.enableA11yButton)
        openRelayButton = findViewById(R.id.openRelayButton)
        connectGoogleButton = findViewById(R.id.connectGoogleButton)
        saveButton = findViewById(R.id.saveButton)

        // Load existing values
        apiKeyInput.setText(secureStorage.getApiKey())

        // Set up model spinner
        val adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, MODEL_NAMES)
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        modelSpinner.adapter = adapter

        val currentModel = secureStorage.getModel()
        val modelIndex = MODEL_IDS.indexOf(currentModel)
        if (modelIndex >= 0) {
            modelSpinner.setSelection(modelIndex)
        }

        // Set up Qwen model spinner
        val qwenAdapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, QWEN_MODEL_NAMES)
        qwenAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        qwenModelSpinner.adapter = qwenAdapter

        // Load existing Qwen values
        qwenApiKeyInput.setText(secureStorage.getQwenApiKey())
        val currentQwenModel = secureStorage.getQwenModel()
        val qwenModelIndex = QWEN_MODEL_IDS.indexOf(currentQwenModel)
        if (qwenModelIndex >= 0) {
            qwenModelSpinner.setSelection(qwenModelIndex)
        }

        // Set initial backend selection
        when (secureStorage.getBackendMode()) {
            SecureStorage.BACKEND_E2E_CLOUD -> {
                radioE2eCloud.isChecked = true
                showE2eCloudSection()
            }
            SecureStorage.BACKEND_LOCAL -> {
                radioLocal.isChecked = true
                showLocalSection()
            }
            SecureStorage.BACKEND_QWEN_CLOUD -> {
                radioQwenCloud.isChecked = true
                showQwenCloudSection()
            }
            SecureStorage.BACKEND_LITERT_NPU -> {
                radioLitertNpu.isChecked = true
                showLitertNpuSection()
            }
            else -> {
                radioCloud.isChecked = true
                showCloudSection()
            }
        }

        // Backend toggle
        backendRadioGroup.setOnCheckedChangeListener { _, checkedId ->
            when (checkedId) {
                R.id.radioE2eCloud -> showE2eCloudSection()
                R.id.radioCloud -> showCloudSection()
                R.id.radioQwenCloud -> showQwenCloudSection()
                R.id.radioLocal -> showLocalSection()
                R.id.radioLitertNpu -> showLitertNpuSection()
            }
        }

        // Download button
        downloadButton.setOnClickListener {
            if (isDownloading) {
                modelManager.cancelDownload()
                isDownloading = false
                downloadButton.text = "Download Model (~2.5 GB)"
                downloadProgress.visibility = View.GONE
                downloadPercent.visibility = View.GONE
            } else {
                startDownload()
            }
        }

        // Delete model button
        deleteModelButton.setOnClickListener {
            modelManager.deleteModel()
            updateModelStatus()
            Toast.makeText(this, "Model deleted", Toast.LENGTH_SHORT).show()
        }

        // LiteRT NPU download / delete buttons (Phase γ.3)
        litertNpuDownloadButton.setOnClickListener {
            if (isLitertDownloading) {
                litertModelManager.cancelDownload()
                isLitertDownloading = false
                litertNpuDownloadButton.text = getString(R.string.litert_npu_download_cta)
                litertNpuDownloadProgress.visibility = View.GONE
                litertNpuDownloadPercent.visibility = View.GONE
            } else {
                startLitertNpuDownload()
            }
        }
        litertNpuDeleteButton.setOnClickListener {
            litertModelManager.deleteModel()
            updateLitertNpuStatus()
            Toast.makeText(this, "NPU model deleted", Toast.LENGTH_SHORT).show()
        }

        // HuggingFace Bearer token wiring (Phase γ.4 / L3).
        //
        // We deliberately DO NOT populate hfTokenInput with the saved
        // token — even masked, echoing it back would let a screen-
        // recorder lift it. Status text alone ("Token set ✓" /
        // "No token set") tells the user what's persisted.
        updateHfTokenStatus()
        hfTokenSaveButton.setOnClickListener { onSaveHfToken() }
        hfTokenClearButton.setOnClickListener { onClearHfToken() }

        enableA11yButton.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }

        openRelayButton.setOnClickListener {
            startActivity(Intent(this, MainActivity::class.java))
        }

        connectGoogleButton.setOnClickListener {
            val token = secureStorage.getCloudAuthToken()
            if (token.isNullOrBlank()) {
                Toast.makeText(this, "Sign in with wallet first", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            Thread {
                val client = ThumperCloudClient(secureStorage.getCloudBaseUrl(), token)
                val url = client.getGmailAuthorizeUrl()
                runOnUiThread {
                    if (url.isNullOrBlank()) {
                        Toast.makeText(
                            this,
                            "Google connect unavailable right now",
                            Toast.LENGTH_LONG
                        ).show()
                    } else {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    }
                }
            }.start()
        }

        // Pair Device entry points (Phase 0.3 — wallet-to-wallet vault sync).
        findViewById<View>(R.id.pairDeviceReceiveButton).setOnClickListener {
            startActivity(Intent(this, PairDeviceReceiverActivity::class.java))
        }
        findViewById<View>(R.id.pairDeviceSendButton).setOnClickListener {
            startActivity(Intent(this, PairDeviceSenderActivity::class.java))
        }

        saveButton.setOnClickListener {
            saveSettings()
        }
    }

    override fun onResume() {
        super.onResume()
        updateA11yStatus()
        updateModelStatus()
        updateLitertNpuStatus()
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        if (item.itemId == android.R.id.home) {
            finish()
            return true
        }
        return super.onOptionsItemSelected(item)
    }

    private fun showE2eCloudSection() {
        // No backend-specific config UI for E2E mode in v0.3 — the auth
        // token + Solana address come from the Wallet / sign-in flow.
        cloudSection.visibility = View.GONE
        qwenCloudSection.visibility = View.GONE
        localSection.visibility = View.GONE
        litertNpuSection.visibility = View.GONE
    }

    private fun showCloudSection() {
        cloudSection.visibility = View.VISIBLE
        qwenCloudSection.visibility = View.GONE
        localSection.visibility = View.GONE
        litertNpuSection.visibility = View.GONE
    }

    private fun showQwenCloudSection() {
        cloudSection.visibility = View.GONE
        qwenCloudSection.visibility = View.VISIBLE
        localSection.visibility = View.GONE
        litertNpuSection.visibility = View.GONE
    }

    private fun showLocalSection() {
        cloudSection.visibility = View.GONE
        qwenCloudSection.visibility = View.GONE
        localSection.visibility = View.VISIBLE
        litertNpuSection.visibility = View.GONE
        updateModelStatus()
    }

    /**
     * Phase γ.3 — surface the LiteRT-LM NPU artifact status + download
     * controls. Mirrors [showLocalSection] structurally; differs only
     * in which manager backs the status text and which model gets
     * downloaded. Coexists with the GGUF flow because the user may
     * have both artifacts resident.
     */
    private fun showLitertNpuSection() {
        cloudSection.visibility = View.GONE
        qwenCloudSection.visibility = View.GONE
        localSection.visibility = View.GONE
        litertNpuSection.visibility = View.VISIBLE
        updateLitertNpuStatus()
    }

    private fun updateModelStatus() {
        // v0.6: surface BOTH the model status and a hidden long-press affordance
        // for the on-device runtime + LoRA panel. The default model status
        // string keeps the v0.5 wording so existing users see the same thing;
        // long-pressing the line opens the v0.6 panel (runtime swap, LoRA
        // training status, re-train trigger). Hidden because v0.6.0 ships
        // opt-in — we don't want every user finding their way into the
        // beta runtime by tapping a normal button.
        if (modelManager.isModelDownloaded()) {
            val size = modelManager.formatSize(modelManager.getModelSizeBytes())
            modelStatus.text = "Model: Downloaded ($size)"
            modelStatus.setTextColor(0xFF4CAF50.toInt())
            downloadButton.text = "Re-download Model"
            deleteModelButton.visibility = View.VISIBLE
        } else {
            modelStatus.text = "Model: Not downloaded"
            modelStatus.setTextColor(0xFF757575.toInt())
            downloadButton.text = "Download Model (~2.5 GB)"
            deleteModelButton.visibility = View.GONE
        }
        modelStatus.setOnLongClickListener {
            showOnDeviceRuntimePanel()
            true
        }
    }

    /**
     * Phase γ.3 — refresh the LiteRT-LM NPU section's status line +
     * download/delete affordances based on what
     * [LiteRtModelManager.isModelVerified] reports.
     *
     * Run on the UI thread; the verification check itself is a
     * coroutine (it hashes the artifact) so we dispatch it via
     * `lifecycleScope` and update views in the success continuation.
     * The synchronous path falls back to the cheap
     * [LiteRtModelManager.isModelDownloaded] check so the UI shows
     * *something* before the hash completes.
     */
    private fun updateLitertNpuStatus() {
        val mgr = litertModelManager
        val downloaded = mgr.isModelDownloaded()
        if (downloaded) {
            val size = mgr.formatSize(mgr.getModelSizeBytes())
            litertNpuStatus.text = getString(R.string.litert_npu_status_downloaded, size)
            litertNpuStatus.setTextColor(0xFF4CAF50.toInt())
            litertNpuDownloadButton.text = getString(R.string.litert_npu_redownload_cta)
            litertNpuDeleteButton.visibility = View.VISIBLE
        } else {
            litertNpuStatus.text = getString(R.string.litert_npu_status_not_downloaded)
            litertNpuStatus.setTextColor(0xFF757575.toInt())
            litertNpuDownloadButton.text = getString(R.string.litert_npu_download_cta)
            litertNpuDeleteButton.visibility = View.GONE
        }

        // Layer the verification result on top once the hash completes.
        // Cheap when the file is small or absent; ~300ms on a real
        // .litertlm artifact — fast enough to do on every onResume.
        lifecycleScope.launch {
            val status = withContext(kotlinx.coroutines.Dispatchers.IO) {
                runCatching { mgr.isModelVerified() }.getOrNull()
            }
            val sizeStr = mgr.formatSize(mgr.getModelSizeBytes())
            when (status) {
                ModelStatus.VERIFIED -> {
                    litertNpuStatus.text = getString(R.string.litert_npu_status_verified, sizeStr)
                    litertNpuStatus.setTextColor(0xFF4CAF50.toInt())
                }
                ModelStatus.DOWNLOADED_UNVERIFIED -> {
                    litertNpuStatus.text = getString(R.string.litert_npu_status_unverified, sizeStr)
                    litertNpuStatus.setTextColor(0xFFFFB300.toInt())
                }
                ModelStatus.TAMPERED -> {
                    litertNpuStatus.text = getString(R.string.litert_npu_status_tampered)
                    litertNpuStatus.setTextColor(0xFFF44336.toInt())
                    litertNpuDeleteButton.visibility = View.VISIBLE
                }
                ModelStatus.NOT_DOWNLOADED, null -> {
                    // already rendered above
                }
            }
        }
    }

    /**
     * Phase γ.4 / L3 — render the "Token set ✓ / No token set" line.
     * Pure-formatting logic lives in [SettingsHelpers.formatHfTokenStatus]
     * so it can be unit-tested without standing up an Activity.
     */
    private fun updateHfTokenStatus() {
        val status = SettingsHelpers.formatHfTokenStatus(secureStorage.hasHfBearerToken())
        when (status) {
            SettingsHelpers.HF_STATUS_SET -> {
                hfTokenStatusText.text = getString(R.string.hf_token_status_set)
                hfTokenStatusText.setTextColor(0xFF4CAF50.toInt())
                hfTokenClearButton.visibility = View.VISIBLE
            }
            else -> {
                hfTokenStatusText.text = getString(R.string.hf_token_status_not_set)
                hfTokenStatusText.setTextColor(0xFF757575.toInt())
                hfTokenClearButton.visibility = View.GONE
            }
        }
    }

    /**
     * Phase γ.4 / L3 — persist whatever the user typed into the HF
     * token field. Validation is intentionally permissive: a token
     * that doesn't look like `hf_…` produces a warning toast but is
     * still saved, so future-format tokens (if HF changes the prefix)
     * don't get rejected.
     */
    private fun onSaveHfToken() {
        val raw = hfTokenInput.text?.toString()?.trim().orEmpty()
        if (raw.isEmpty()) {
            Toast.makeText(this, getString(R.string.hf_token_empty_toast), Toast.LENGTH_SHORT).show()
            return
        }
        if (!SettingsHelpers.looksLikeHfToken(raw)) {
            Toast.makeText(
                this,
                getString(R.string.hf_token_format_warning),
                Toast.LENGTH_LONG,
            ).show()
        }
        secureStorage.setHfBearerToken(raw)
        hfTokenInput.setText("")
        updateHfTokenStatus()
        Toast.makeText(this, getString(R.string.hf_token_saved_toast), Toast.LENGTH_SHORT).show()
    }

    /**
     * Phase γ.4 / L3 — clear the persisted HF token after a confirm
     * dialog. The confirm exists because subsequent NPU bundle
     * downloads will 401 against the gated repo — the user should
     * mean it.
     */
    private fun onClearHfToken() {
        AlertDialog.Builder(this)
            .setMessage(getString(R.string.hf_token_confirm_clear))
            .setPositiveButton(R.string.hf_token_clear) { _, _ ->
                secureStorage.setHfBearerToken(null)
                hfTokenInput.setText("")
                updateHfTokenStatus()
                Toast.makeText(
                    this,
                    getString(R.string.hf_token_removed_toast),
                    Toast.LENGTH_SHORT,
                ).show()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /**
     * Phase γ.3 — kick off the .litertlm download. Mirrors
     * [startDownload] (the GGUF path) but routes progress + completion
     * into the LiteRT NPU section's views.
     */
    private fun startLitertNpuDownload() {
        isLitertDownloading = true
        litertNpuDownloadButton.text = getString(R.string.litert_npu_download_cancel)
        litertNpuDownloadProgress.visibility = View.VISIBLE
        litertNpuDownloadProgress.progress = 0
        litertNpuDownloadPercent.visibility = View.VISIBLE
        litertNpuDownloadPercent.text = "Starting…"

        litertModelManager.downloadModel(object : LiteRtModelManager.DownloadListener {
            override fun onProgress(downloaded: Long, total: Long, percent: Int) {
                mainHandler.post {
                    litertNpuDownloadProgress.progress = percent
                    val dlStr = litertModelManager.formatSize(downloaded)
                    val totalStr = if (total > 0) litertModelManager.formatSize(total) else "?"
                    litertNpuDownloadPercent.text = "$dlStr / $totalStr ($percent%)"
                }
            }

            override fun onComplete(path: String) {
                mainHandler.post {
                    isLitertDownloading = false
                    litertNpuDownloadProgress.visibility = View.GONE
                    litertNpuDownloadPercent.visibility = View.GONE
                    updateLitertNpuStatus()
                    Toast.makeText(
                        this@SettingsActivity,
                        "NPU model downloaded",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            }

            override fun onError(message: String) {
                mainHandler.post {
                    isLitertDownloading = false
                    litertNpuDownloadButton.text = getString(R.string.litert_npu_download_cta)
                    litertNpuDownloadProgress.visibility = View.GONE
                    litertNpuDownloadPercent.visibility = View.GONE
                    Toast.makeText(
                        this@SettingsActivity,
                        "NPU model download failed: $message",
                        Toast.LENGTH_LONG,
                    ).show()
                }
            }
        })
    }

    /**
     * v0.6 hidden panel: runtime swap + LoRA status + voice-training trigger.
     * Reached by long-pressing the "Model:" status line on the Settings page.
     * Documented under docs/v0.6-on-device-llm.md for internal dogfood.
     */
    private fun showOnDeviceRuntimePanel() {
        val storage = secureStorage
        val mm = modelManager
        val runtime = if (storage.useLlamaCppRuntime()) "llama.cpp (v0.6)" else "MediaPipe (v0.5)"
        val loraStatus = when {
            storage.voiceLoraActive() && mm.isLoraReady() -> {
                val ts = storage.voiceLoraReadyAtMillis()
                if (ts > 0) "Active — trained " + relativeTimeShort(ts) else "Active"
            }
            mm.isLoraReady() -> "Trained, inactive"
            else -> "Not trained"
        }
        val body = """
            Runtime: $runtime
            Model file: ${mm.getModelPath()}
              Size: ${mm.formatSize(mm.getModelSizeBytes())}
            LoRA: $loraStatus
        """.trimIndent()

        // Action list — variable number of items depending on runtime + LoRA
        // state. AlertDialog.setItems is the right primitive here; trying to
        // shoehorn 4+ actions into positive/neutral/negative buttons hits
        // Material AlertDialog's hard cap and silently drops actions.
        val actions = mutableListOf<Pair<String, () -> Unit>>()
        if (storage.useLlamaCppRuntime()) {
            actions += "Compare voices" to {
                startActivity(android.content.Intent(this, VoiceCompareActivity::class.java))
            }
            if (mm.isLoraReady()) {
                val label = if (storage.voiceLoraActive()) "Disable voice LoRA" else "Enable voice LoRA"
                actions += label to {
                    val next = !storage.voiceLoraActive()
                    storage.setVoiceLoraActive(next)
                    xyz.ghola.app.email.LocalLlm.reset(this)
                    Toast.makeText(
                        this,
                        if (next) "Voice LoRA enabled" else "Voice LoRA disabled",
                        Toast.LENGTH_SHORT,
                    ).show()
                    updateModelStatus()
                }
            }
            // Phase A.3 — diagnostic gate. Greedy-decodes 20 tokens through
            // both our custom Qwen forward (training path) and llama.cpp's
            // reference path; mismatches mean Phase C will train a broken
            // adapter. Hidden behind the long-press menu — never user-facing.
            actions += "Run parity check (Phase A.3)" to { runParityCheck() }
            actions += "Run banana test (Phase H.1)" to { runBananaTest() }
            actions += "Show ship/no-ship gates (Phase H)" to { showShipGates() }
            actions += "Clean test artifacts" to { cleanTestArtifacts() }
            actions += "Switch back to MediaPipe" to {
                storage.setUseLlamaCppRuntime(false)
                xyz.ghola.app.email.LocalLlm.reset(this)
                Toast.makeText(this, "Reverted to MediaPipe runtime", Toast.LENGTH_SHORT).show()
                updateModelStatus()
            }
        } else {
            actions += "Switch to llama.cpp" to {
                storage.setUseLlamaCppRuntime(true)
                xyz.ghola.app.email.LocalLlm.reset(this)
                Toast.makeText(this, "llama.cpp runtime enabled", Toast.LENGTH_SHORT).show()
                updateModelStatus()
            }
        }

        val items = actions.map { it.first }.toTypedArray()
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("On-device model (v0.6 beta)")
            .setMessage(body)
            .setItems(items) { _, which -> actions[which].second() }
            .setNegativeButton("Close", null)
            .show()
    }

    /**
     * Phase A.3 — runs greedy-decode parity between qwen_forward and
     * llama_decode. Shows the match count in a dialog; ≥18/20 is good
     * enough to ship Phase C, anything lower means the forward has a bug
     * to localize from logcat (LlamaCpp tag).
     *
     * NB: this call blocks for tens of seconds on the Seeker — it does
     * two 20-token greedy decodes through a 1.5B model. We run it on
     * Dispatchers.IO and show a "Running parity check..." dialog while
     * we wait so the user knows the app didn't hang.
     */
    private fun runParityCheck() {
        val mm = modelManager
        if (!mm.isModelDownloaded()) {
            Toast.makeText(this, "Model not downloaded", Toast.LENGTH_SHORT).show()
            return
        }
        val modelPath = mm.getModelPath()
        val prompt = "<|im_start|>user\nWrite one sentence about Solana.<|im_end|>\n" +
                     "<|im_start|>assistant\n"
        val maxTokens = 20

        val progress = androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Parity check")
            .setMessage("Running 20-token greedy decode on both paths…\nThis takes ~30-60s on Seeker.")
            .setCancelable(false)
            .show()

        lifecycleScope.launch {
            val matched = withContext(kotlinx.coroutines.Dispatchers.IO) {
                runCatching {
                    xyz.ghola.app.ai.llama.LlamaCpp().parityCheck(modelPath, prompt, maxTokens)
                }.getOrElse { -1 }
            }
            progress.dismiss()
            val verdict = when {
                matched < 0    -> "ERROR — see logcat (LlamaCpp tag)"
                matched == maxTokens -> "PASS — forward is correct, Phase C is safe to run"
                matched >= 18  -> "WARN — $matched/$maxTokens; minor numerical drift, check logcat"
                matched == 0   -> "FAIL @ token 0 — bug in tok_embed or first attention block"
                else           -> "FAIL @ token $matched — bug in a deeper layer"
            }
            androidx.appcompat.app.AlertDialog.Builder(this@SettingsActivity)
                .setTitle("Parity check: $matched/$maxTokens")
                .setMessage(verdict)
                .setPositiveButton("OK", null)
                .show()
        }
    }

    /**
     * Phase H.1 banana test. ~5-10 minute hardware run that proves the
     * full Phase A→B→C→D→8 chain works end-to-end without depending on
     * the user's actual email corpus.
     */
    private fun runBananaTest() {
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Banana test")
            .setMessage(
                "This will train a fresh LoRA on 200 synthetic 'banana' pairs " +
                "and verify the model overfits to predict 'banana'.\n\n" +
                "Runtime: 5-10 minutes on Seeker. Existing user voice LoRA is " +
                "NOT touched (banana LoRA writes to a separate file).\n\n" +
                "Plug in to charge before starting.",
            )
            .setPositiveButton("Run") { _, _ -> launchBananaTest() }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun launchBananaTest() {
        val progress = androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Banana test")
            .setMessage("Training… (you can dim the screen, but don't kill the app)")
            .setCancelable(false)
            .show()

        lifecycleScope.launch {
            val verdict = withContext(kotlinx.coroutines.Dispatchers.IO) {
                runCatching {
                    xyz.ghola.app.ml.BananaTest.runOnce(
                        this@SettingsActivity,
                        callback = object : xyz.ghola.app.ai.llama.LlamaFinetune.ProgressCallback {
                            override fun onEpoch(epoch: Int, totalEpochs: Int, lossSoFar: Float) {
                                mainHandler.post { progress.setMessage("Epoch $epoch/$totalEpochs — loss=${"%.4f".format(lossSoFar)}") }
                            }
                            override fun onStep(step: Int, totalSteps: Int, loss: Float) {
                                if (step % 20 == 0) {
                                    mainHandler.post {
                                        progress.setMessage("Step $step/$totalSteps — loss=${"%.4f".format(loss)}")
                                    }
                                }
                            }
                            override fun onComplete(adapterPath: String) { /* handled by Verdict */ }
                            override fun onError(message: String) { /* handled by Verdict */ }
                        },
                    )
                }.getOrElse {
                    xyz.ghola.app.ml.BananaTest.Verdict(
                        trained = false, sampledOutput = null, bananaFraction = 0f,
                        passes = false, message = "exception: ${it.message}",
                    )
                }
            }
            progress.dismiss()
            val body = buildString {
                append(verdict.message)
                if (verdict.sampledOutput != null) {
                    append("\n\nSample output:\n")
                    append(verdict.sampledOutput.take(200))
                }
            }
            androidx.appcompat.app.AlertDialog.Builder(this@SettingsActivity)
                .setTitle(if (verdict.passes) "Banana test: PASS" else "Banana test: FAIL")
                .setMessage(body)
                .setPositiveButton("OK", null)
                .show()
        }
    }

    /**
     * Phase H ship/no-ship dashboard. Runs all three evaluatable gates
     * (voice match Δ, n-gram leakage, A/B preference) and renders the
     * pass/fail summary. Gate H.1 (banana test) lives on its own
     * Settings entry because it's a long-running training operation
     * rather than an aggregator.
     *
     * Each gate's eval is expensive — voice match runs ~17 minutes of
     * inference for runEval — so dev should expect this to take a while.
     */
    private fun showShipGates() {
        val progress = androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Phase H gates")
            .setMessage(
                "Evaluating voice match, leakage, and A/B preference…\n\n" +
                "This runs ~50 generations per gate; budget 20+ minutes.",
            )
            .setCancelable(false)
            .show()

        lifecycleScope.launch {
            val gates = withContext(kotlinx.coroutines.Dispatchers.IO) {
                runCatching { xyz.ghola.app.ml.VoiceMetric.phaseHGateReport(this@SettingsActivity) }
                    .getOrNull()
            }
            progress.dismiss()
            val body = if (gates == null) {
                "Gate evaluation failed — see logcat (VoiceMetric tag)."
            } else {
                buildString {
                    append("Gate 2 (voice match Δ ≥ +0.08): ")
                    append(if (gates.voiceMatchPasses) "✅ PASS" else "❌ FAIL")
                    gates.voiceMatchDelta?.let { append("  Δ=${"%.3f".format(it)}") }
                    append("\n\n")
                    append("Gate 3 (n-gram leakage): ")
                    append(if (gates.leakagePasses) "✅ PASS" else "❌ FAIL")
                    gates.leakageWarnFraction?.let { append("  warnFraction=${"%.2f".format(it)}") }
                    gates.leakageHasHardFail?.let { append("  hardFail=$it") }
                    append("\n\n")
                    append("Gate 4 (A/B preference ≥ 0.60, n ≥ 10): ")
                    append(if (gates.preferencePasses) "✅ PASS" else "❌ FAIL")
                    append("  n=${gates.preferenceN}")
                    gates.preferenceLoraFraction?.let { append("  loraFrac=${"%.2f".format(it)}") }
                    append("\n\n")
                    append(if (gates.passes) "OVERALL: SHIP ✅" else "OVERALL: BLOCK ❌")
                    append("\n\n(Gate 1 — banana test — runs separately.)")
                }
            }
            androidx.appcompat.app.AlertDialog.Builder(this@SettingsActivity)
                .setTitle("Phase H result")
                .setMessage(body)
                .setPositiveButton("OK", null)
                .show()
        }
    }

    /**
     * Removes dev artifacts: banana LoRA, .partial checkpoints, and the
     * synthetic training JSONL. Leaves the real user voice LoRA untouched.
     * Useful between repeated banana test runs that would otherwise resume
     * from a stale partial.
     */
    private fun cleanTestArtifacts() {
        val mm = modelManager
        val candidates = listOf(
            // Banana LoRA written by BananaTest.runOnce
            java.io.File(mm.getLoraFile().absolutePath + ".banana"),
            // Phase G partial checkpoint
            java.io.File(mm.getLoraFile().absolutePath + ".partial"),
            // Synthetic JSONLs in cache
            java.io.File(cacheDir, "finetune/banana_test.jsonl"),
            // Banana-run loss exports if present
            java.io.File(cacheDir, "finetune/train.jsonl"),
        )
        val removed = candidates.filter { it.exists() }
        if (removed.isEmpty()) {
            Toast.makeText(this, "No test artifacts to clean", Toast.LENGTH_SHORT).show()
            return
        }
        val summary = removed.joinToString("\n") {
            "${it.name} (${modelManager.formatSize(it.length())})"
        }
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Clean test artifacts")
            .setMessage("Will remove:\n\n$summary\n\nUser voice LoRA + corpus are untouched.")
            .setPositiveButton("Remove") { _, _ ->
                val deleted = removed.count { it.delete() }
                Toast.makeText(this, "Removed $deleted file(s)", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun relativeTimeShort(epochMillis: Long): String {
        val deltaSec = (System.currentTimeMillis() - epochMillis) / 1000
        return when {
            deltaSec < 60 -> "just now"
            deltaSec < 3600 -> "${deltaSec / 60}m ago"
            deltaSec < 86_400 -> "${deltaSec / 3600}h ago"
            else -> "${deltaSec / 86_400}d ago"
        }
    }

    private fun startDownload() {
        isDownloading = true
        downloadButton.text = "Cancel Download"
        downloadProgress.visibility = View.VISIBLE
        downloadProgress.progress = 0
        downloadPercent.visibility = View.VISIBLE
        downloadPercent.text = "Starting..."

        modelManager.downloadModel(object : ModelManager.DownloadListener {
            override fun onProgress(downloaded: Long, total: Long, percent: Int) {
                mainHandler.post {
                    downloadProgress.progress = percent
                    val dlStr = modelManager.formatSize(downloaded)
                    val totalStr = modelManager.formatSize(total)
                    downloadPercent.text = "$dlStr / $totalStr ($percent%)"
                }
            }

            override fun onComplete(path: String) {
                mainHandler.post {
                    isDownloading = false
                    downloadProgress.visibility = View.GONE
                    downloadPercent.visibility = View.GONE
                    updateModelStatus()
                    Toast.makeText(this@SettingsActivity, "Model downloaded", Toast.LENGTH_SHORT).show()
                }
            }

            override fun onError(message: String) {
                mainHandler.post {
                    isDownloading = false
                    downloadButton.text = "Download Model (~2.5 GB)"
                    downloadProgress.visibility = View.GONE
                    downloadPercent.visibility = View.GONE
                    Toast.makeText(this@SettingsActivity, "Download failed: $message", Toast.LENGTH_LONG).show()
                }
            }
        })
    }

    private fun saveSettings() {
        when {
            radioE2eCloud.isChecked -> {
                if (!secureStorage.hasSolanaAddress()) {
                    Toast.makeText(
                        this,
                        "Connect a Solana wallet first (Wallet tab)",
                        Toast.LENGTH_SHORT,
                    ).show()
                    return
                }
                secureStorage.setBackendMode(SecureStorage.BACKEND_E2E_CLOUD)
            }
            radioLocal.isChecked -> {
                if (!modelManager.isModelDownloaded()) {
                    Toast.makeText(this, "Please download the model first", Toast.LENGTH_SHORT).show()
                    return
                }
                secureStorage.setBackendMode(SecureStorage.BACKEND_LOCAL)
            }
            radioLitertNpu.isChecked -> {
                if (!litertModelManager.isModelDownloaded()) {
                    Toast.makeText(
                        this,
                        getString(R.string.litert_npu_save_requires_download),
                        Toast.LENGTH_SHORT,
                    ).show()
                    return
                }
                secureStorage.setBackendMode(SecureStorage.BACKEND_LITERT_NPU)
            }
            radioQwenCloud.isChecked -> {
                val apiKey = qwenApiKeyInput.text.toString().trim()
                if (apiKey.isEmpty()) {
                    Toast.makeText(this, "DashScope API key is required for BYOM Qwen mode", Toast.LENGTH_SHORT).show()
                    return
                }
                secureStorage.setQwenApiKey(apiKey)
                secureStorage.setQwenModel(QWEN_MODEL_IDS[qwenModelSpinner.selectedItemPosition])
                secureStorage.setBackendMode(SecureStorage.BACKEND_QWEN_CLOUD)
            }
            else -> {
                val apiKey = apiKeyInput.text.toString().trim()
                if (apiKey.isEmpty()) {
                    Toast.makeText(this, "API key is required for BYOM Claude mode", Toast.LENGTH_SHORT).show()
                    return
                }
                secureStorage.setApiKey(apiKey)
                secureStorage.setModel(MODEL_IDS[modelSpinner.selectedItemPosition])
                secureStorage.setBackendMode(SecureStorage.BACKEND_CLOUD)
            }
        }

        Toast.makeText(this, "Settings saved", Toast.LENGTH_SHORT).show()
        finish()
    }

    private fun updateA11yStatus() {
        val enabled = ThumperAccessibilityService.instance != null
        a11yStatus.text = if (enabled) "Enabled" else "Disabled"
        a11yStatus.setTextColor(
            if (enabled) 0xFF4CAF50.toInt() else 0xFFF44336.toInt()
        )
        enableA11yButton.isEnabled = !enabled
    }
}

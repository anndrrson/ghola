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
import androidx.appcompat.app.AppCompatActivity
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
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
    private val mainHandler = Handler(Looper.getMainLooper())

    // Backend selection
    private lateinit var backendRadioGroup: RadioGroup
    private lateinit var radioE2eCloud: RadioButton
    private lateinit var radioCloud: RadioButton
    private lateinit var radioQwenCloud: RadioButton
    private lateinit var radioLocal: RadioButton

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

    // Common
    private lateinit var a11yStatus: TextView
    private lateinit var enableA11yButton: Button
    private lateinit var openRelayButton: Button
    private lateinit var connectGoogleButton: Button
    private lateinit var saveButton: Button

    private var isDownloading = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        supportActionBar?.title = "Settings"

        secureStorage = SecureStorage(this)
        modelManager = ModelManager(this)

        // Bind views
        backendRadioGroup = findViewById(R.id.backendRadioGroup)
        radioE2eCloud = findViewById(R.id.radioE2eCloud)
        radioCloud = findViewById(R.id.radioCloud)
        radioQwenCloud = findViewById(R.id.radioQwenCloud)
        radioLocal = findViewById(R.id.radioLocal)
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
        when {
            secureStorage.isE2ECloudMode() -> {
                radioE2eCloud.isChecked = true
                showE2eCloudSection()
            }
            secureStorage.isLocalMode() -> {
                radioLocal.isChecked = true
                showLocalSection()
            }
            secureStorage.isQwenCloudMode() -> {
                radioQwenCloud.isChecked = true
                showQwenCloudSection()
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
    }

    private fun showCloudSection() {
        cloudSection.visibility = View.VISIBLE
        qwenCloudSection.visibility = View.GONE
        localSection.visibility = View.GONE
    }

    private fun showQwenCloudSection() {
        cloudSection.visibility = View.GONE
        qwenCloudSection.visibility = View.VISIBLE
        localSection.visibility = View.GONE
    }

    private fun showLocalSection() {
        cloudSection.visibility = View.GONE
        qwenCloudSection.visibility = View.GONE
        localSection.visibility = View.VISIBLE
        updateModelStatus()
    }

    private fun updateModelStatus() {
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

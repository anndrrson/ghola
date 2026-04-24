package xyz.ghola.app.ui

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import xyz.ghola.app.BuildConfig
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.ai.llama.ModelManager
import xyz.ghola.app.util.AccessibilityUtil

class SetupGateActivity : AppCompatActivity() {
    companion object {
        const val EXTRA_REASON = "reason"
        const val REASON_BACKEND = "backend"
        const val REASON_LOCAL_MODEL = "local_model"
        const val REASON_LOCAL_UNAVAILABLE = "local_unavailable"
        const val REASON_ACCESSIBILITY = "accessibility"
    }

    private lateinit var storage: SecureStorage
    private lateinit var modelManager: ModelManager

    private lateinit var reasonText: TextView
    private lateinit var signInStatus: TextView
    private lateinit var backendStatus: TextView
    private lateinit var accessibilityStatus: TextView
    private lateinit var continueButton: MaterialButton
    private lateinit var signInButton: MaterialButton
    private lateinit var backendButton: MaterialButton
    private lateinit var accessibilityButton: MaterialButton

    private val firstRunSignInLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        renderState()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup_gate)

        storage = SecureStorage(this)
        modelManager = ModelManager(this)

        reasonText = findViewById(R.id.setupReasonText)
        signInStatus = findViewById(R.id.signInStatusText)
        backendStatus = findViewById(R.id.backendStatusText)
        accessibilityStatus = findViewById(R.id.accessibilityStatusText)
        continueButton = findViewById(R.id.continueButton)
        signInButton = findViewById(R.id.openSignInButton)
        backendButton = findViewById(R.id.openBackendButton)
        accessibilityButton = findViewById(R.id.openAccessibilityButton)

        reasonText.text = when (intent.getStringExtra(EXTRA_REASON)) {
            REASON_BACKEND -> "To continue, configure a backend API key in Settings."
            REASON_LOCAL_MODEL -> "To continue, download the on-device model or switch to a cloud backend."
            REASON_LOCAL_UNAVAILABLE -> "This build doesn't support on-device inference. Switch to a cloud backend."
            REASON_ACCESSIBILITY -> "To continue, enable accessibility so Ghola can control apps on your device."
            else -> "To continue, complete the required setup below."
        }

        signInButton.setOnClickListener {
            firstRunSignInLauncher.launch(
                Intent(this, FirstRunActivity::class.java).putExtra(
                    FirstRunActivity.EXTRA_STANDALONE_SIGN_IN,
                    true
                )
            )
        }
        backendButton.setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
        accessibilityButton.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        continueButton.setOnClickListener {
            if (!isBackendReady() || !isAccessibilityReady()) {
                renderState()
                return@setOnClickListener
            }
            startActivity(Intent(this, ChatActivity::class.java))
            finish()
        }

        findViewById<View>(R.id.closeButton).setOnClickListener { finish() }
        renderState()
    }

    override fun onResume() {
        super.onResume()
        renderState()
    }

    private fun renderState() {
        val signedIn = storage.hasCloudAuth()
        signInStatus.text = if (signedIn) {
            "Account: Signed in"
        } else {
            "Account: Not signed in (recommended for monetization and cloud sync)"
        }
        val signInAvailable = BuildConfig.GOOGLE_WEB_CLIENT_ID.isNotBlank()
        signInButton.isEnabled = signInAvailable
        signInButton.alpha = if (signInAvailable) 1f else 0.6f
        signInButton.text = if (signInAvailable) {
            "Sign In With Google"
        } else {
            "Google Sign-In Unavailable"
        }

        val backendReady = isBackendReady()
        val backendLabel = when {
            storage.isLocalMode() -> "On-device"
            storage.isQwenCloudMode() -> "Qwen Cloud"
            else -> "Claude Cloud"
        }
        backendStatus.text = if (backendReady) {
            "Backend: Ready ($backendLabel)"
        } else {
            "Backend: Needs configuration ($backendLabel)"
        }

        val a11yReady = isAccessibilityReady()
        accessibilityStatus.text = if (a11yReady) {
            "Accessibility: Enabled"
        } else {
            "Accessibility: Disabled"
        }

        continueButton.isEnabled = backendReady && a11yReady
        continueButton.alpha = if (continueButton.isEnabled) 1f else 0.6f
    }

    private fun isAccessibilityReady(): Boolean = AccessibilityUtil.isServiceEnabled(this)

    private fun isBackendReady(): Boolean {
        return when {
            storage.isLocalMode() -> {
                BuildConfig.ENABLE_LOCAL_LLM && modelManager.isModelDownloaded()
            }
            storage.isQwenCloudMode() -> storage.hasQwenApiKey()
            else -> storage.hasApiKey()
        }
    }
}

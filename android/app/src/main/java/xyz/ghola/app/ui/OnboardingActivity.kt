package xyz.ghola.app.ui

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.launch
import xyz.ghola.app.BuildConfig
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.CloudAuthManager
import xyz.ghola.app.solana.MWAConnect

/**
 * 2-screen onboarding flow:
 * 1) Pair wallet + SIWS sign-in (required)
 * 2) Accessibility permission (optional)
 */
class OnboardingActivity : AppCompatActivity() {

    private lateinit var secureStorage: SecureStorage
    private lateinit var cloudAuthManager: CloudAuthManager
    private var currentStep = 0
    private var waitingForAccessibility = false

    // ActivityResultSender must be initialized as a field.
    private val activityResultSender = ActivityResultSender(this)

    private lateinit var stepSignIn: View
    private lateinit var stepAccessibility: View

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_onboarding)

        secureStorage = SecureStorage(this)
        cloudAuthManager = CloudAuthManager(this)

        stepSignIn = findViewById(R.id.stepSignIn)
        stepAccessibility = findViewById(R.id.stepAccessibility)

        findViewById<Button>(R.id.btnWalletSignIn).setOnClickListener {
            startWalletSignIn()
        }
        findViewById<Button>(R.id.btnEnableAccessibility).setOnClickListener {
            waitingForAccessibility = true
            AccessibilitySetup.open(this)
        }
        findViewById<Button>(R.id.btnCheckAccessibility).setOnClickListener {
            if (AccessibilitySetup.isEnabled(this)) {
                finishOnboarding()
            } else {
                Toast.makeText(this, "Tap Ghola, turn it on, then come back.", Toast.LENGTH_SHORT).show()
                waitingForAccessibility = true
                AccessibilitySetup.open(this)
            }
        }
        findViewById<Button>(R.id.btnFinish).setOnClickListener {
            finishOnboarding()
        }
        findViewById<Button>(R.id.btnDone).setOnClickListener {
            finishOnboarding()
        }

        showStep(0)
    }

    override fun onResume() {
        super.onResume()
        if (currentStep == 1) {
            if (AccessibilitySetup.isEnabled(this)) {
                finishOnboarding()
            } else if (waitingForAccessibility) {
                Toast.makeText(this, "Android still needs Ghola turned on.", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun startWalletSignIn() {
        lifecycleScope.launch {
            if (BuildConfig.GHOLA_PLAY_STORE_BUILD) {
                val result = cloudAuthManager.signInWithTurnkey(this@OnboardingActivity)
                when (result) {
                    is CloudAuthManager.AuthResult.Success -> {
                        Toast.makeText(this@OnboardingActivity, "Turnkey wallet connected", Toast.LENGTH_SHORT).show()
                        afterWalletSignIn()
                    }
                    is CloudAuthManager.AuthResult.Error -> {
                        Toast.makeText(this@OnboardingActivity, result.message, Toast.LENGTH_LONG).show()
                    }
                }
                return@launch
            }
            val auth = MWAConnect.authorizeSession(
                activityResultSender,
                previousAuthToken = secureStorage.getMwaAuthToken(),
            )
            auth.fold(
                onSuccess = { session ->
                    secureStorage.setMwaSession(
                        address = session.address,
                        authToken = session.authToken,
                        walletUriBase = session.walletUriBase,
                        accountLabel = session.accountLabel,
                        cluster = session.cluster,
                    )
                    val walletAddress = session.address
                    val result = cloudAuthManager.signInWithWallet(activityResultSender, walletAddress)
                    when (result) {
                        is CloudAuthManager.AuthResult.Success -> {
                            Toast.makeText(this@OnboardingActivity, "Wallet connected", Toast.LENGTH_SHORT).show()
                            afterWalletSignIn()
                        }
                        is CloudAuthManager.AuthResult.Error -> {
                            Toast.makeText(this@OnboardingActivity, result.message, Toast.LENGTH_LONG).show()
                        }
                    }
                },
                onFailure = { err ->
                    val msg = when (err) {
                        is MWAConnect.NoWalletInstalledException ->
                            if (BuildConfig.GHOLA_PLAY_STORE_BUILD) {
                                "No compatible wallet found. Install Solflare or Phantom, or use ghola.xyz for web account auth."
                            } else {
                                "No Solana wallet found. Install one to continue."
                            }
                        else -> err.message ?: "Wallet connection failed"
                    }
                    Toast.makeText(this@OnboardingActivity, msg, Toast.LENGTH_LONG).show()
                }
            )
        }
    }

    private fun showStep(step: Int) {
        currentStep = step
        stepSignIn.visibility = if (step == 0) View.VISIBLE else View.GONE
        stepAccessibility.visibility = if (step == 1) View.VISIBLE else View.GONE
        val totalSteps = if (BuildConfig.GHOLA_DEVICE_CONTROL_ENABLED) 2 else 1
        findViewById<TextView>(R.id.stepIndicator).text = "Step ${step + 1} of $totalSteps"
    }

    private fun afterWalletSignIn() {
        if (BuildConfig.GHOLA_DEVICE_CONTROL_ENABLED) {
            showStep(1)
        } else {
            finishOnboarding()
        }
    }

    private fun finishOnboarding() {
        startActivity(Intent(this, HomeActivity::class.java))
        finish()
    }
}

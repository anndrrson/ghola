package xyz.ghola.app.ui

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.launch
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.CloudAuthManager
import xyz.ghola.app.service.ThumperAccessibilityService
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
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        findViewById<Button>(R.id.btnCheckAccessibility).setOnClickListener {
            if (ThumperAccessibilityService.instance != null) {
                finishOnboarding()
            } else {
                Toast.makeText(this, "Accessibility is still disabled", Toast.LENGTH_SHORT).show()
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
        if (currentStep == 1 && ThumperAccessibilityService.instance != null) {
            finishOnboarding()
        }
    }

    private fun startWalletSignIn() {
        lifecycleScope.launch {
            val auth = MWAConnect.authorize(activityResultSender)
            auth.fold(
                onSuccess = { walletAddress ->
                    secureStorage.setSolanaAddress(walletAddress)
                    val result = cloudAuthManager.signInWithWallet(activityResultSender, walletAddress)
                    when (result) {
                        is CloudAuthManager.AuthResult.Success -> {
                            Toast.makeText(this@OnboardingActivity, "Wallet connected", Toast.LENGTH_SHORT).show()
                            showStep(1)
                        }
                        is CloudAuthManager.AuthResult.Error -> {
                            Toast.makeText(this@OnboardingActivity, result.message, Toast.LENGTH_LONG).show()
                        }
                    }
                },
                onFailure = { err ->
                    val msg = when (err) {
                        is MWAConnect.NoWalletInstalledException ->
                            "No Solana wallet found. Install one to continue."
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
        findViewById<TextView>(R.id.stepIndicator).text = "Step ${step + 1} of 2"
    }

    private fun finishOnboarding() {
        startActivity(Intent(this, HomeActivity::class.java))
        finish()
    }
}

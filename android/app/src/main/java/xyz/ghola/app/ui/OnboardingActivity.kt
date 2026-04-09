package xyz.ghola.app.ui

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInClient
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.CloudAuthManager
import xyz.ghola.app.service.ThumperAccessibilityService

/**
 * 3-screen onboarding flow:
 * 1. Sign In (Google Sign-In)
 * 2. Enable Accessibility Service
 * 3. Connect accounts (Gmail, Calendar) + microphone permission (optional)
 */
class OnboardingActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "Onboarding"
        private const val RC_SIGN_IN = 9001
        // Replace with your actual Google OAuth client ID for Android
        private const val GOOGLE_CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com"
    }

    private lateinit var secureStorage: SecureStorage
    private lateinit var cloudAuthManager: CloudAuthManager
    private var googleSignInClient: GoogleSignInClient? = null
    private var currentStep = 0

    // Step views
    private lateinit var stepSignIn: View
    private lateinit var stepAccessibility: View
    private lateinit var stepConnect: View

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_onboarding)

        secureStorage = SecureStorage(this)
        cloudAuthManager = CloudAuthManager(this)

        stepSignIn = findViewById(R.id.stepSignIn)
        stepAccessibility = findViewById(R.id.stepAccessibility)
        stepConnect = findViewById(R.id.stepConnect)

        // Configure Google Sign-In
        val gso = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestIdToken(GOOGLE_CLIENT_ID)
            .requestEmail()
            .requestProfile()
            .build()
        googleSignInClient = GoogleSignIn.getClient(this, gso)

        // Step 1: Sign In
        findViewById<Button>(R.id.btnGoogleSignIn).setOnClickListener {
            startGoogleSignIn()
        }
        findViewById<Button>(R.id.btnSkipSignIn).setOnClickListener {
            advanceStep()
        }

        // Step 2: Accessibility
        findViewById<Button>(R.id.btnEnableAccessibility).setOnClickListener {
            val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            startActivity(intent)
        }
        findViewById<Button>(R.id.btnCheckAccessibility).setOnClickListener {
            if (ThumperAccessibilityService.instance != null) {
                advanceStep()
            } else {
                Toast.makeText(this, "Please enable the Thumper Accessibility Service", Toast.LENGTH_SHORT).show()
            }
        }

        // Step 3: Connect accounts
        findViewById<Button>(R.id.btnConnectGmail).setOnClickListener {
            // Gmail OAuth would open a web view — requires server-side OAuth endpoint
            Toast.makeText(this, "Gmail connection requires setting up OAuth in Settings", Toast.LENGTH_LONG).show()
        }
        findViewById<Button>(R.id.btnFinish).setOnClickListener {
            finishOnboarding()
        }

        showStep(0)
    }

    override fun onResume() {
        super.onResume()
        // Auto-advance from step 2 if accessibility is now enabled
        if (currentStep == 1 && ThumperAccessibilityService.instance != null) {
            advanceStep()
        }
    }

    private fun startGoogleSignIn() {
        val signInIntent = googleSignInClient?.signInIntent ?: return
        startActivityForResult(signInIntent, RC_SIGN_IN)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)

        if (requestCode == RC_SIGN_IN) {
            val task = GoogleSignIn.getSignedInAccountFromIntent(data)
            try {
                val account = task.getResult(ApiException::class.java)
                val idToken = account?.idToken

                if (idToken != null) {
                    // Exchange Google ID token for Thumper JWT on background thread
                    val displayName = account.displayName
                    val email = account.email

                    Thread {
                        val result = cloudAuthManager.signInWithGoogle(idToken)
                        runOnUiThread {
                            when (result) {
                                is CloudAuthManager.AuthResult.Success -> {
                                    // Save user info
                                    displayName?.let { secureStorage.setUserDisplayName(it) }
                                    email?.let { secureStorage.setUserEmail(it) }
                                    Toast.makeText(this, "Signed in as $displayName", Toast.LENGTH_SHORT).show()
                                    advanceStep()
                                }
                                is CloudAuthManager.AuthResult.Error -> {
                                    Log.e(TAG, "Cloud auth failed: ${result.message}")
                                    Toast.makeText(this, "Sign-in failed: ${result.message}", Toast.LENGTH_LONG).show()
                                }
                            }
                        }
                    }.start()
                } else {
                    Toast.makeText(this, "No ID token received from Google", Toast.LENGTH_SHORT).show()
                }
            } catch (e: ApiException) {
                Log.e(TAG, "Google sign-in failed: ${e.statusCode}", e)
                Toast.makeText(this, "Google sign-in failed: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showStep(step: Int) {
        currentStep = step
        stepSignIn.visibility = if (step == 0) View.VISIBLE else View.GONE
        stepAccessibility.visibility = if (step == 1) View.VISIBLE else View.GONE
        stepConnect.visibility = if (step == 2) View.VISIBLE else View.GONE

        // Update step indicator
        findViewById<TextView>(R.id.stepIndicator).text = "Step ${step + 1} of 3"
    }

    private fun advanceStep() {
        if (currentStep < 2) {
            showStep(currentStep + 1)
        } else {
            finishOnboarding()
        }
    }

    private fun finishOnboarding() {
        startActivity(Intent(this, HomeActivity::class.java))
        finish()
    }
}

package xyz.ghola.app.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.TextView
import android.widget.Toast
import android.widget.ViewFlipper
import androidx.appcompat.app.AppCompatActivity
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInClient
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException
import com.google.android.material.button.MaterialButton
import xyz.ghola.app.BuildConfig
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.CloudAuthManager

/**
 * # FirstRunActivity
 *
 * One-shot cinematic opener shown on the very first launch after a
 * cold install. Two beats in a single [ViewFlipper]:
 *
 *   1. **Pitch** — wordmark + headline "The AI that actually uses your
 *      apps." + a one-paragraph explanation of the three pillars
 *      (agents act, agents hold money, keys are hardware). Continue
 *      button, Skip link.
 *   2. **Ready** — "You're set." + optional Google sign-in button +
 *      "Enter Ghola" button that finishes and lands on HomeActivity.
 *
 * Accessibility and Seed Vault prompts are deliberately NOT part of
 * this flow — they fire lazily later, the moment the user actually
 * needs them (see Op-Better #2). This keeps the first-run ritual
 * under ~10 seconds and lets the user see the product before
 * committing to any OS-level permission.
 *
 * The flag [SecureStorage.isFirstRunCompleted] gates this activity —
 * once the user enters Ghola (via Done, Skip, or signing in), the
 * flag is set to `true` and this activity never shows again. If you
 * want to re-run it for testing, clear app data OR call
 * `storage.setFirstRunCompleted(false)` via a debug broadcast.
 *
 * ## Why not a ViewPager?
 *
 * ViewFlipper is simpler, doesn't pull in any ViewPager dep, doesn't
 * need a FragmentStateAdapter, and has built-in slide animations. Two
 * beats is the right call for the demo; any more and the user is
 * being sold to, which is not what first-run should feel like.
 */
class FirstRunActivity : AppCompatActivity() {
    companion object {
        private const val TAG = "FirstRun"
        private const val RC_SIGN_IN = 9101
        const val EXTRA_STANDALONE_SIGN_IN = "standalone_sign_in"
    }

    private lateinit var storage: SecureStorage
    private lateinit var flipper: ViewFlipper
    private lateinit var signInButton: MaterialButton
    private lateinit var doneButton: MaterialButton
    private lateinit var cloudAuthManager: CloudAuthManager
    private var googleSignInClient: GoogleSignInClient? = null
    private var standaloneSignIn = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_first_run)

        storage = SecureStorage(this)
        cloudAuthManager = CloudAuthManager(this)
        flipper = findViewById(R.id.rootFlipper)
        signInButton = findViewById(R.id.signInButton)
        doneButton = findViewById(R.id.doneButton)
        standaloneSignIn = intent.getBooleanExtra(EXTRA_STANDALONE_SIGN_IN, false)

        if (standaloneSignIn) {
            // Reuse the first-run sign-in surface as a standalone account setup gate.
            flipper.displayedChild = 1
            findViewById<TextView>(R.id.skipButton).visibility = View.GONE
            doneButton.text = "DONE"
        }

        findViewById<MaterialButton>(R.id.nextButton).setOnClickListener {
            flipper.showNext()
        }
        findViewById<TextView>(R.id.skipButton).setOnClickListener {
            finishFirstRun()
        }
        doneButton.setOnClickListener {
            finishFirstRun()
        }
        configureGoogleSignIn()
    }

    private fun configureGoogleSignIn() {
        val googleClientId = BuildConfig.GOOGLE_WEB_CLIENT_ID.trim()
        if (googleClientId.isEmpty()) {
            signInButton.isEnabled = false
            signInButton.alpha = 0.6f
            signInButton.text = "GOOGLE SIGN-IN UNAVAILABLE"
            return
        }

        val gso = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestIdToken(googleClientId)
            .requestEmail()
            .requestProfile()
            .build()
        googleSignInClient = GoogleSignIn.getClient(this, gso)

        signInButton.setOnClickListener {
            val signInIntent = googleSignInClient?.signInIntent
            if (signInIntent == null) {
                Toast.makeText(this, "Google sign-in is not configured.", Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            startActivityForResult(signInIntent, RC_SIGN_IN)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != RC_SIGN_IN) return

        val task = GoogleSignIn.getSignedInAccountFromIntent(data)
        try {
            val account = task.getResult(ApiException::class.java)
            val idToken = account?.idToken
            if (idToken.isNullOrBlank()) {
                Toast.makeText(this, "Google sign-in did not return a token.", Toast.LENGTH_LONG).show()
                return
            }

            signInButton.isEnabled = false
            val originalLabel = signInButton.text
            signInButton.text = "SIGNING IN..."

            Thread {
                val auth = cloudAuthManager.signInWithGoogle(idToken)
                runOnUiThread {
                    signInButton.isEnabled = true
                    signInButton.text = originalLabel
                    when (auth) {
                        is CloudAuthManager.AuthResult.Success -> {
                            account.displayName?.let { storage.setUserDisplayName(it) }
                            account.email?.let { storage.setUserEmail(it) }
                            Toast.makeText(this, "Signed in as ${account.displayName ?: "Google user"}", Toast.LENGTH_SHORT).show()
                            finishFirstRun()
                        }
                        is CloudAuthManager.AuthResult.Error -> {
                            Log.e(TAG, "Cloud auth failed: ${auth.message}")
                            Toast.makeText(this, "Sign-in failed: ${auth.message}", Toast.LENGTH_LONG).show()
                        }
                    }
                }
            }.start()
        } catch (e: ApiException) {
            Log.e(TAG, "Google sign-in failed: ${e.statusCode}", e)
            Toast.makeText(this, "Google sign-in failed: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun finishFirstRun() {
        storage.setFirstRunCompleted(true)
        if (standaloneSignIn) {
            setResult(Activity.RESULT_OK)
            finish()
            return
        }
        val intent = Intent(this, HomeActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        startActivity(intent)
        finish()
    }
}

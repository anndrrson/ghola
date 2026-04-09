package xyz.ghola.app.ui

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.TextView
import android.widget.Toast
import android.widget.ViewFlipper
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage

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

    private lateinit var storage: SecureStorage
    private lateinit var flipper: ViewFlipper

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_first_run)

        storage = SecureStorage(this)
        flipper = findViewById(R.id.rootFlipper)

        findViewById<MaterialButton>(R.id.nextButton).setOnClickListener {
            flipper.showNext()
        }
        findViewById<TextView>(R.id.skipButton).setOnClickListener {
            finishFirstRun()
        }
        findViewById<MaterialButton>(R.id.doneButton).setOnClickListener {
            finishFirstRun()
        }
        findViewById<MaterialButton>(R.id.signInButton).setOnClickListener {
            // TODO: wire into CloudAuthManager's real Google Sign-In flow.
            // For now the button is aspirational — tapping it toasts
            // "Sign in from Settings" and lands on Home so first-run
            // never blocks on a flow we haven't finished wiring.
            Toast.makeText(
                this,
                "Sign in with Google from Settings → Account (the button is cosmetic in this build).",
                Toast.LENGTH_LONG,
            ).show()
            finishFirstRun()
        }
    }

    private fun finishFirstRun() {
        storage.setFirstRunCompleted(true)
        val intent = Intent(this, HomeActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        startActivity(intent)
        finish()
    }
}

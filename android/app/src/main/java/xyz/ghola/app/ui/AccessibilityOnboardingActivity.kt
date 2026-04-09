package xyz.ghola.app.ui

import android.content.ComponentName
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.View
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import xyz.ghola.app.R
import xyz.ghola.app.service.ThumperAccessibilityService
import xyz.ghola.app.util.AccessibilityUtil

/**
 * # AccessibilityOnboardingActivity
 *
 * Cinematic one-tap flow that takes a new user from "never heard of
 * Android accessibility settings" to "Ghola is now driving my phone"
 * in 3 taps total:
 *
 *   1. Tap GRANT PERMISSION  →  Android opens Ghola's accessibility detail
 *   2. Tap the toggle switch   →  Android shows its confirmation dialog
 *   3. Tap "Allow"             →  Return to Ghola, permission granted
 *
 * The fourth-party reality is that Android genuinely does not let apps
 * enable accessibility services programmatically — that's the OS's
 * explicit anti-malware rule, and fighting it is futile. The best any
 * app can do is minimize the friction of the 3 taps above by:
 *
 * - Deep-linking directly to Ghola's entry in the accessibility settings
 *   via `Settings.ACTION_ACCESSIBILITY_DETAILS_SETTINGS` (Android 11+)
 *   so the user doesn't have to scroll through a list of 40+ services.
 * - Auto-detecting the successful grant via `onResume()` so the user
 *   doesn't have to tap a "done" button back in Ghola.
 * - Explaining WHY up front so the user doesn't wonder what they're
 *   consenting to.
 *
 * ## When this activity is shown
 *
 * [HomeActivity.onResume] checks [AccessibilityUtil.isServiceEnabled]
 * and launches this activity if the user has not yet granted the
 * permission AND has not explicitly dismissed the prompt via "Skip for
 * now" (which sets a flag in SecureStorage to suppress re-prompts for
 * the current session). The user can always re-trigger the flow from
 * the Settings screen.
 *
 * ## What if the deep link fails on an old device?
 *
 * [Settings.ACTION_ACCESSIBILITY_DETAILS_SETTINGS] is API 30+. On older
 * Android, we fall back to [Settings.ACTION_ACCESSIBILITY_SETTINGS]
 * which lands on the full list but at least gets the user into the
 * right settings screen. Both paths work in production; the deep link
 * is just nicer UX.
 */
class AccessibilityOnboardingActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "AccessOnboard"
    }

    private lateinit var grantButton: MaterialButton
    private lateinit var skipText: TextView
    private lateinit var statusBadge: TextView
    private lateinit var crumbBack: TextView

    /** True once the user has tapped GRANT PERMISSION — used by onResume
     *  to decide whether to celebrate a fresh grant. */
    private var grantLaunched = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_accessibility_onboarding)

        grantButton = findViewById(R.id.grantButton)
        skipText = findViewById(R.id.skipText)
        statusBadge = findViewById(R.id.statusBadge)
        crumbBack = findViewById(R.id.crumbBack)

        grantButton.setOnClickListener { launchAccessibilitySettings() }
        skipText.setOnClickListener { finishSkipping() }
        crumbBack.setOnClickListener { finishSkipping() }
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
    }

    /** Re-check accessibility state. If the service is now enabled,
     *  show a brief "› GRANTED" badge and auto-finish back to Home. */
    private fun refreshStatus() {
        val enabled = AccessibilityUtil.isServiceEnabled(this)
        if (enabled) {
            statusBadge.text = "› GRANTED"
            statusBadge.setTextColor(0xFF3DA8FF.toInt())
            grantButton.text = "CONTINUE  →"
            grantButton.setOnClickListener { finishGranted() }

            if (grantLaunched) {
                // User just came back from Settings after granting — show
                // the green state briefly then auto-return to Home so the
                // entire onboarding is a single visible hop.
                grantButton.postDelayed({ finishGranted() }, 900)
            }
        } else {
            statusBadge.text = "› NOT GRANTED"
            statusBadge.setTextColor(0xFFEF4444.toInt())
        }
    }

    /**
     * Open Android Settings directly at Ghola's accessibility detail
     * page. On API 30+ we use ACTION_ACCESSIBILITY_DETAILS_SETTINGS
     * which jumps right to the toggle; on older devices we fall back
     * to ACTION_ACCESSIBILITY_SETTINGS which shows the full list.
     */
    private fun launchAccessibilitySettings() {
        grantLaunched = true
        val componentName = ComponentName(
            packageName,
            ThumperAccessibilityService::class.java.name,
        )

        // Try the deep link first. The flattened component-name extra is
        // what AOSP's Settings app uses internally to scroll directly to
        // the named service and focus its toggle.
        //
        // ACTION_ACCESSIBILITY_DETAILS_SETTINGS + EXTRA_COMPONENT_NAME are
        // @hide constants in the public SDK surface even though the intent
        // is resolvable in production. Hard-coding the string literals is
        // the canonical workaround used by Firefox, Signal, and others.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val flattened = componentName.flattenToString()
            val showArgs = Bundle()
            showArgs.putString(":settings:fragment_args_key", flattened)

            val deepLink = Intent("android.settings.ACCESSIBILITY_DETAILS_SETTINGS")
            deepLink.putExtra("android.provider.extra.ACCESSIBILITY_COMPONENT_NAME", flattened)
            deepLink.putExtra(":settings:fragment_args_key", flattened)
            deepLink.putExtra(":settings:show_fragment_args", showArgs)
            deepLink.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

            try {
                startActivity(deepLink)
                return
            } catch (e: Exception) {
                Log.w(TAG, "ACCESSIBILITY_DETAILS_SETTINGS failed, falling back: ${e.message}")
            }
        }

        // Fallback for API < 30 or OEM-customized settings apps that
        // don't understand the detail intent: land on the full list.
        try {
            startActivity(
                Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (e: Exception) {
            Log.e(TAG, "Could not open accessibility settings", e)
            Toast.makeText(
                this,
                "Open Android Settings → Accessibility → Ghola manually.",
                Toast.LENGTH_LONG,
            ).show()
        }
    }

    private fun finishGranted() {
        setResult(RESULT_OK)
        finish()
    }

    private fun finishSkipping() {
        setResult(RESULT_CANCELED)
        finish()
    }
}

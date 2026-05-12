package xyz.ghola.app.ui

import android.animation.ValueAnimator
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.view.animation.AccelerateDecelerateInterpolator
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.constraintlayout.motion.widget.MotionLayout
import androidx.lifecycle.lifecycleScope
import com.google.android.material.button.MaterialButton
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.launch
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.CloudAuthManager
import xyz.ghola.app.service.ThumperAccessibilityService
import xyz.ghola.app.solana.MWAConnect

/**
 * Two-step onboarding hero.
 *
 * Step 0 — Wallet sign-in (required for cloud features).
 * Step 1 — Accessibility permission (optional, enables device control).
 *
 * Layout uses [MotionLayout]; transitions between steps are declarative
 * (see `res/xml/onboarding_motion_scene.xml`). The CTA progresses through a
 * three-state controller — Idle, RequestingChallenge, WaitingForWalletSignature
 * — with a shimmer hint while the user approves the wallet prompt.
 *
 * Deep-linkable via the [EXTRA_STEP] intent extra. [HomeActivity] passes
 * [STEP_SIWS] when a cloud-only tile (Call/Email) is tapped without a session,
 * dropping the user straight onto the sign-in CTA.
 */
class OnboardingActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_STEP = "onboarding_step"
        const val STEP_SIWS = 0
        const val STEP_ACCESSIBILITY = 1
    }

    private lateinit var secureStorage: SecureStorage
    private lateinit var cloudAuthManager: CloudAuthManager
    private var currentStep = STEP_SIWS

    // ActivityResultSender must be initialized as a field. Lazy/onCreate
    // construction crashes MWA — see the comment on the same pattern in
    // ChatActivity.
    private val activityResultSender = ActivityResultSender(this)

    private lateinit var motion: MotionLayout
    private lateinit var ctaButton: MaterialButton
    private lateinit var ctaSpinner: ProgressBar
    private lateinit var ctaHint: TextView
    private lateinit var heroTitle: TextView
    private lateinit var heroBody: TextView
    private lateinit var stepIndicator: TextView

    private var animatedBackground: AnimatedGradientDrawable? = null
    private var hintShimmer: ValueAnimator? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_onboarding)

        secureStorage = SecureStorage(this)
        cloudAuthManager = CloudAuthManager(this)

        motion = findViewById(R.id.onboardingMotion)
        ctaButton = findViewById(R.id.btnWalletSignIn)
        ctaSpinner = findViewById(R.id.ctaSpinner)
        ctaHint = findViewById(R.id.ctaHint)
        heroTitle = findViewById(R.id.heroTitle)
        heroBody = findViewById(R.id.heroBody)
        stepIndicator = findViewById(R.id.stepIndicator)

        // Animated radial-gradient background — slow ambient breath.
        val bg = AnimatedGradientDrawable()
        motion.background = bg
        animatedBackground = bg

        // Click handlers.
        ctaButton.setOnClickListener { startWalletSignIn() }
        findViewById<MaterialButton>(R.id.btnEnableAccessibility).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        findViewById<MaterialButton>(R.id.btnCheckAccessibility).setOnClickListener {
            if (ThumperAccessibilityService.instance != null) {
                finishOnboarding()
            } else {
                Toast.makeText(this, "Accessibility is still disabled", Toast.LENGTH_SHORT).show()
            }
        }
        findViewById<MaterialButton>(R.id.btnFinish).setOnClickListener { finishOnboarding() }
        findViewById<MaterialButton>(R.id.btnDone).setOnClickListener { finishOnboarding() }

        // Deep-link: jump to the requested step. We default to STEP_SIWS;
        // STEP_ACCESSIBILITY is honored only if the wallet step is already
        // complete (otherwise the user lands on an empty step).
        val requestedStep = intent.getIntExtra(EXTRA_STEP, STEP_SIWS)
        if (requestedStep == STEP_ACCESSIBILITY && secureStorage.hasCloudAuth()) {
            showStep(STEP_ACCESSIBILITY, animate = false)
        } else {
            showStep(STEP_SIWS, animate = false)
        }

        renderCta(CtaState.Idle)
    }

    override fun onResume() {
        super.onResume()
        animatedBackground?.start()
        if (currentStep == STEP_ACCESSIBILITY && ThumperAccessibilityService.instance != null) {
            finishOnboarding()
        }
    }

    override fun onPause() {
        super.onPause()
        animatedBackground?.stop()
        hintShimmer?.cancel()
    }

    // ── Sign-in flow ─────────────────────────────────────────────────────────

    private fun startWalletSignIn() {
        renderCta(CtaState.RequestingChallenge)
        lifecycleScope.launch {
            val auth = MWAConnect.authorize(activityResultSender)
            auth.fold(
                onSuccess = { walletAddress ->
                    secureStorage.setSolanaAddress(walletAddress)
                    // We're now in front of the wallet UI — the user has to
                    // approve the SIWS message signature. Switch the CTA into
                    // a "waiting for wallet" state with a shimmer hint.
                    renderCta(CtaState.WaitingForWalletSignature)
                    val result = cloudAuthManager.signInWithWallet(
                        activityResultSender,
                        walletAddress,
                    )
                    when (result) {
                        is CloudAuthManager.AuthResult.Success -> {
                            renderCta(CtaState.Idle)
                            showStep(STEP_ACCESSIBILITY, animate = true)
                        }
                        is CloudAuthManager.AuthResult.Error -> {
                            renderCta(CtaState.Error(result.message))
                            Toast.makeText(
                                this@OnboardingActivity,
                                result.message,
                                Toast.LENGTH_LONG,
                            ).show()
                        }
                    }
                },
                onFailure = { err ->
                    val msg = when (err) {
                        is MWAConnect.NoWalletInstalledException ->
                            "No Solana wallet found. Install one to continue."
                        else -> err.message ?: "Wallet connection failed"
                    }
                    renderCta(CtaState.Error(msg))
                    Toast.makeText(this@OnboardingActivity, msg, Toast.LENGTH_LONG).show()
                },
            )
        }
    }

    // ── CTA state machine ────────────────────────────────────────────────────

    private sealed class CtaState {
        object Idle : CtaState()
        object RequestingChallenge : CtaState()
        object WaitingForWalletSignature : CtaState()
        data class Error(val message: String) : CtaState()
    }

    private fun renderCta(state: CtaState) {
        hintShimmer?.cancel()
        hintShimmer = null

        when (state) {
            is CtaState.Idle -> {
                ctaButton.isEnabled = true
                ctaButton.alpha = 1f
                ctaButton.text = getString(R.string.onboarding_cta_idle)
                ctaSpinner.visibility = View.GONE
                ctaHint.visibility = View.GONE
            }
            is CtaState.RequestingChallenge -> {
                ctaButton.isEnabled = false
                ctaButton.alpha = 0.6f
                ctaButton.text = getString(R.string.onboarding_cta_requesting)
                ctaSpinner.visibility = View.VISIBLE
                ctaHint.visibility = View.GONE
            }
            is CtaState.WaitingForWalletSignature -> {
                ctaButton.isEnabled = false
                ctaButton.alpha = 0.6f
                ctaButton.text = getString(R.string.onboarding_cta_requesting)
                ctaSpinner.visibility = View.VISIBLE
                ctaHint.visibility = View.VISIBLE
                ctaHint.text = getString(R.string.onboarding_cta_hint_wallet)
                hintShimmer = ValueAnimator.ofFloat(0.4f, 1f).apply {
                    duration = 1500L
                    repeatMode = ValueAnimator.REVERSE
                    repeatCount = ValueAnimator.INFINITE
                    interpolator = AccelerateDecelerateInterpolator()
                    addUpdateListener { ctaHint.alpha = it.animatedValue as Float }
                    start()
                }
            }
            is CtaState.Error -> {
                ctaButton.isEnabled = true
                ctaButton.alpha = 1f
                ctaButton.text = getString(R.string.onboarding_cta_idle)
                ctaSpinner.visibility = View.GONE
                ctaHint.visibility = View.GONE
                // User-visible error is delivered via Toast in startWalletSignIn.
            }
        }
    }

    // ── Step machinery ───────────────────────────────────────────────────────

    private fun showStep(step: Int, animate: Boolean) {
        currentStep = step
        // Swap copy first — MotionLayout interpolates the alpha/position.
        when (step) {
            STEP_SIWS -> {
                stepIndicator.text = getString(R.string.onboarding_step_1)
                heroTitle.text = getString(R.string.onboarding_title_wallet)
                heroBody.text = getString(R.string.onboarding_body_wallet)
            }
            STEP_ACCESSIBILITY -> {
                stepIndicator.text = getString(R.string.onboarding_step_2)
                heroTitle.text = getString(R.string.onboarding_title_a11y)
                heroBody.text = getString(R.string.onboarding_body_a11y)
            }
        }
        if (animate) {
            if (step == STEP_ACCESSIBILITY) motion.transitionToEnd()
            else motion.transitionToStart()
        } else {
            // Jump without animation — used when re-entering an already-
            // completed step via deep link.
            motion.progress = if (step == STEP_ACCESSIBILITY) 1f else 0f
        }
    }

    private fun finishOnboarding() {
        startActivity(Intent(this, HomeActivity::class.java))
        finish()
    }
}

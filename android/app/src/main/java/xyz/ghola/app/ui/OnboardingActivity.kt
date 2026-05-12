package xyz.ghola.app.ui

import android.animation.AnimatorSet
import android.animation.ObjectAnimator
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
import androidx.constraintlayout.widget.ConstraintLayout
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

    private lateinit var root: ConstraintLayout
    private lateinit var heroIconStep0: View
    private lateinit var heroIconStep1: View
    private lateinit var ctaButton: MaterialButton
    private lateinit var ctaSpinner: ProgressBar
    private lateinit var ctaHint: TextView
    private lateinit var heroTitle: TextView
    private lateinit var heroBody: TextView
    private lateinit var stepIndicator: TextView
    private lateinit var accentBar: View
    private lateinit var btnEnableA11y: View
    private lateinit var btnCheckA11y: View
    private lateinit var btnFinish: View

    private var animatedBackground: AnimatedGradientDrawable? = null
    private var hintShimmer: ValueAnimator? = null
    private var transitionAnimator: AnimatorSet? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_onboarding)

        secureStorage = SecureStorage(this)
        cloudAuthManager = CloudAuthManager(this)

        root = findViewById(R.id.onboardingMotion)
        ctaButton = findViewById(R.id.btnWalletSignIn)
        ctaSpinner = findViewById(R.id.ctaSpinner)
        ctaHint = findViewById(R.id.ctaHint)
        heroTitle = findViewById(R.id.heroTitle)
        heroBody = findViewById(R.id.heroBody)
        stepIndicator = findViewById(R.id.stepIndicator)
        accentBar = findViewById(R.id.accentBar)
        heroIconStep0 = findViewById(R.id.heroIconStep0)
        heroIconStep1 = findViewById(R.id.heroIconStep1)
        btnEnableA11y = findViewById(R.id.btnEnableAccessibility)
        btnCheckA11y = findViewById(R.id.btnCheckAccessibility)
        btnFinish = findViewById(R.id.btnFinish)

        // Animated radial-gradient background — slow ambient breath.
        val bg = AnimatedGradientDrawable()
        root.background = bg
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
        val isStep1 = step == STEP_ACCESSIBILITY

        // Copy + accent width swap before the animation so the new state's
        // text is in place by the time the fade-in completes.
        if (isStep1) {
            stepIndicator.text = getString(R.string.onboarding_step_2)
            heroTitle.text = getString(R.string.onboarding_title_a11y)
            heroBody.text = getString(R.string.onboarding_body_a11y)
        } else {
            stepIndicator.text = getString(R.string.onboarding_step_1)
            heroTitle.text = getString(R.string.onboarding_title_wallet)
            heroBody.text = getString(R.string.onboarding_body_wallet)
        }

        transitionAnimator?.cancel()
        transitionAnimator = null

        if (!animate) {
            // Jump directly to the target state — used when deep-linking
            // back into a step we already finished.
            heroIconStep0.alpha = if (isStep1) 0f else 1f
            heroIconStep1.alpha = if (isStep1) 1f else 0f
            ctaButton.alpha = if (isStep1) 0f else 1f
            ctaButton.visibility = if (isStep1) View.GONE else View.VISIBLE
            btnEnableA11y.alpha = if (isStep1) 1f else 0f
            btnEnableA11y.visibility = if (isStep1) View.VISIBLE else View.GONE
            btnCheckA11y.alpha = if (isStep1) 1f else 0f
            btnCheckA11y.visibility = if (isStep1) View.VISIBLE else View.GONE
            btnFinish.alpha = if (isStep1) 1f else 0f
            btnFinish.visibility = if (isStep1) View.VISIBLE else View.GONE
            // Accent bar width — swap layout params.
            val lp = accentBar.layoutParams
            lp.width = (resources.displayMetrics.density * (if (isStep1) 96 else 48)).toInt()
            accentBar.layoutParams = lp
            return
        }

        // Animated transition: 500ms total. Step-0 elements fade out 0-200ms;
        // step-1 elements fade in 200-500ms; hero icon crossfade runs through.
        val outDuration = 200L
        val inDuration = 300L
        val outStartDelay = 0L
        val inStartDelay = outDuration

        val fadeOuts = mutableListOf<android.animation.Animator>()
        val fadeIns = mutableListOf<android.animation.Animator>()

        // Hero icon crossfade (full 500ms each direction)
        fadeOuts += ObjectAnimator.ofFloat(
            heroIconStep0,
            "alpha",
            heroIconStep0.alpha,
            if (isStep1) 0f else 1f,
        ).setDuration(outDuration + inDuration)
        fadeIns += ObjectAnimator.ofFloat(
            heroIconStep1,
            "alpha",
            heroIconStep1.alpha,
            if (isStep1) 1f else 0f,
        ).setDuration(outDuration + inDuration)

        // CTA: hide step-0 button, show step-1 buttons (or vice versa).
        val stepZeroVisible = !isStep1
        fadeOuts += ObjectAnimator.ofFloat(
            ctaButton,
            "alpha",
            ctaButton.alpha,
            if (stepZeroVisible) 1f else 0f,
        ).setDuration(if (stepZeroVisible) inDuration else outDuration)

        listOf(btnEnableA11y, btnCheckA11y, btnFinish).forEach { v ->
            v.visibility = View.VISIBLE
            val anim = ObjectAnimator.ofFloat(
                v,
                "alpha",
                v.alpha,
                if (isStep1) 1f else 0f,
            )
            if (isStep1) {
                anim.startDelay = inStartDelay
                anim.duration = inDuration
                fadeIns += anim
            } else {
                anim.duration = outDuration
                fadeOuts += anim
            }
        }

        // Title slide — out then in.
        val slideOut = ObjectAnimator.ofFloat(heroTitle, "translationX", 0f, -16f)
            .setDuration(outDuration)
        val slideIn = ObjectAnimator.ofFloat(heroTitle, "translationX", 16f, 0f)
            .apply {
                startDelay = inStartDelay
                duration = inDuration
            }
        val titleFadeOut = ObjectAnimator.ofFloat(heroTitle, "alpha", heroTitle.alpha, 0f)
            .setDuration(outDuration)
        val titleFadeIn = ObjectAnimator.ofFloat(heroTitle, "alpha", 0f, 1f)
            .apply {
                startDelay = inStartDelay
                duration = inDuration
            }

        // Accent bar width animation
        val targetWidthPx = (resources.displayMetrics.density * (if (isStep1) 96 else 48)).toInt()
        val widthAnimator = ValueAnimator.ofInt(accentBar.width, targetWidthPx).apply {
            duration = outDuration + inDuration
            addUpdateListener {
                val lp = accentBar.layoutParams
                lp.width = it.animatedValue as Int
                accentBar.layoutParams = lp
            }
        }

        val set = AnimatorSet()
        set.interpolator = AccelerateDecelerateInterpolator()
        set.playTogether(
            fadeOuts + fadeIns + listOf(slideOut, slideIn, titleFadeOut, titleFadeIn, widthAnimator),
        )
        set.addListener(object : android.animation.AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: android.animation.Animator) {
                // Hide invisible buttons so they don't intercept taps.
                ctaButton.visibility = if (isStep1) View.GONE else View.VISIBLE
                btnEnableA11y.visibility = if (isStep1) View.VISIBLE else View.GONE
                btnCheckA11y.visibility = if (isStep1) View.VISIBLE else View.GONE
                btnFinish.visibility = if (isStep1) View.VISIBLE else View.GONE
                heroTitle.translationX = 0f
            }
        })
        transitionAnimator = set
        set.start()
    }

    private fun finishOnboarding() {
        startActivity(Intent(this, HomeActivity::class.java))
        finish()
    }
}

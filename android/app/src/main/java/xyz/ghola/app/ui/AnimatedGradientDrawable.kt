package xyz.ghola.app.ui

import android.animation.ValueAnimator
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RadialGradient
import android.graphics.Rect
import android.graphics.Shader
import android.graphics.drawable.Drawable
import android.view.animation.AccelerateDecelerateInterpolator

/**
 * Slow-breathing radial-gradient background for the onboarding hero pane.
 *
 * Renders two `RadialGradient` shaders ("pole A" — accent at top-left, "pole B"
 * — dimmer accent at bottom-right) and crossfades between them on a
 * [ValueAnimator] driven by [ANIM_DURATION_MS]. The animator is reusable
 * across activity lifecycle — call [start] in `onResume` and [stop] in
 * `onPause` so we don't burn CPU off-screen.
 *
 * Built on platform primitives — no Lottie, no third-party motion lib. The
 * crossfade is implemented by drawing pole A at full alpha and then drawing
 * pole B on top with `paintB.alpha = (t * 255).toInt()`.
 */
class AnimatedGradientDrawable : Drawable() {

    private val paintA = Paint(Paint.ANTI_ALIAS_FLAG)
    private val paintB = Paint(Paint.ANTI_ALIAS_FLAG)

    /** Background fill (always painted under the gradient poles). */
    private val basePaint = Paint().apply { color = COLOR_BG }

    /** Animation progress [0..1]. */
    private var t: Float = 0f

    private val animator: ValueAnimator =
        ValueAnimator.ofFloat(0f, 1f).apply {
            duration = ANIM_DURATION_MS
            repeatMode = ValueAnimator.REVERSE
            repeatCount = ValueAnimator.INFINITE
            interpolator = AccelerateDecelerateInterpolator()
            addUpdateListener {
                t = it.animatedValue as Float
                invalidateSelf()
            }
        }

    override fun onBoundsChange(bounds: Rect) {
        super.onBoundsChange(bounds)
        if (bounds.width() <= 0 || bounds.height() <= 0) return

        val w = bounds.width().toFloat()
        val h = bounds.height().toFloat()
        // Two poles: top-left warm accent, bottom-right cooler dim.
        // Radii sized to spill past the bounds so the falloff is smooth.
        val radius = (kotlin.math.hypot(w.toDouble(), h.toDouble()) * 0.9).toFloat()

        paintA.shader = RadialGradient(
            w * 0.25f,
            h * 0.20f,
            radius,
            POLE_A_INNER,
            POLE_A_OUTER,
            Shader.TileMode.CLAMP,
        )
        paintB.shader = RadialGradient(
            w * 0.80f,
            h * 0.85f,
            radius,
            POLE_B_INNER,
            POLE_B_OUTER,
            Shader.TileMode.CLAMP,
        )
    }

    override fun draw(canvas: Canvas) {
        val b = bounds
        canvas.drawRect(b, basePaint)
        canvas.drawRect(b, paintA)
        paintB.alpha = (t * 255f).toInt().coerceIn(0, 255)
        canvas.drawRect(b, paintB)
    }

    /** Begin the breathing animation. Safe to call repeatedly. */
    fun start() {
        if (!animator.isStarted) animator.start()
    }

    /** Pause the animation — call from Activity.onPause to spare battery. */
    fun stop() {
        if (animator.isStarted) animator.cancel()
    }

    override fun setAlpha(alpha: Int) {
        basePaint.alpha = alpha
        paintA.alpha = alpha
        paintB.alpha = alpha
    }

    override fun setColorFilter(colorFilter: ColorFilter?) {
        basePaint.colorFilter = colorFilter
        paintA.colorFilter = colorFilter
        paintB.colorFilter = colorFilter
    }

    @Deprecated("Required by Drawable")
    override fun getOpacity(): Int = PixelFormat.OPAQUE

    companion object {
        private const val ANIM_DURATION_MS = 8_000L

        // Brand bg (matches @color/ghola_bg) — anchors the screen under the
        // gradient poles so the corners don't bleed to black.
        private val COLOR_BG = Color.parseColor("#08090d")

        // Pole A: warm-ish accent at top-left.
        private val POLE_A_INNER = Color.parseColor("#403da8ff") // 25% accent
        private val POLE_A_OUTER = Color.parseColor("#0008090d") // fully transparent bg

        // Pole B: cooler/dimmer accent at bottom-right.
        private val POLE_B_INNER = Color.parseColor("#352b96f0") // ~21% accent_dim
        private val POLE_B_OUTER = Color.parseColor("#0008090d")
    }
}

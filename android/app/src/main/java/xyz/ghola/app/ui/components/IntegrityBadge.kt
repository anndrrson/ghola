package xyz.ghola.app.ui.components

import android.content.Context
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.util.AttributeSet
import android.util.TypedValue
import android.view.Gravity
import androidx.annotation.ColorInt
import androidx.appcompat.widget.AppCompatTextView
import androidx.core.content.ContextCompat
import xyz.ghola.app.R
import xyz.ghola.app.ai.llama.ModelManager.ModelStatus

// R is still imported because init{} references R.color.ghola_text_secondary
// for the placeholder colour before bind() is called.

/**
 * Standalone Android View counterpart of the web
 * `ModelIntegrityBadge` (`apps/web/src/components/chat/ModelIntegrityBadge.tsx`).
 *
 * A compact, low-key chip rendered next to the model name (typically in
 * a chat header or settings list). The point isn't to flex a feature —
 * it's to surface the protocol read happening on every session so the
 * user knows that their on-device model artifact is the one ghola
 * actually shipped.
 *
 * Visual contract (mirrors the web emerald/amber/red palette):
 *
 *   ┌──────────────────────────┬────────────┬───────────────────────────┐
 *   │ ModelStatus              │ Dot colour │ Label                     │
 *   ├──────────────────────────┼────────────┼───────────────────────────┤
 *   │ VERIFIED                 │ green      │ Verified · 438aea…3b1a    │
 *   │ DOWNLOADED_UNVERIFIED    │ yellow     │ Unverified                │
 *   │ TAMPERED                 │ red        │ Tampered                  │
 *   │ NOT_DOWNLOADED           │ grey       │ Not downloaded            │
 *   └──────────────────────────┴────────────┴───────────────────────────┘
 *
 * The coloured dot is a compound drawable so the badge composes cleanly
 * into any horizontal `LinearLayout` / `ConstraintLayout` row without a
 * wrapper. We deliberately do NOT extend `MaterialButton` — most chat
 * headers want a flat, opt-in click affordance, and `MaterialButton`
 * brings ripple + state-list overhead the badge doesn't need.
 *
 * Phase γ.3 (parallel agent) is responsible for the actual wiring into
 * `ChatActivity` / `SettingsActivity`. This file deliberately ships
 * without touching either of those activities.
 */
class IntegrityBadge @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : AppCompatTextView(context, attrs, defStyleAttr) {

    /**
     * Optional click callback. When set, the badge becomes clickable and
     * invokes this on tap. Hosts can use it to open
     * [IntegrityBadgeDetailDialog] or navigate to a deeper inspector.
     *
     * Null = badge is non-interactive (the default; matches the spec
     * note that ChatActivity wiring is owned by a different turn).
     */
    var onBadgeClick: Runnable? = null
        set(value) {
            field = value
            if (value != null) {
                isClickable = true
                isFocusable = true
                setOnClickListener { value.run() }
            } else {
                isClickable = false
                isFocusable = false
                setOnClickListener(null)
            }
        }

    init {
        // Layout & typography defaults — match the web chip:
        //   - inline-flex with a 4px gap between dot and text
        //   - small mono uppercase tracking
        //   - chip padding 2.5/1 (web units) → 10dp horiz / 4dp vert
        gravity = Gravity.CENTER_VERTICAL
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
        isAllCaps = true
        letterSpacing = 0.12f
        compoundDrawablePadding = dp(6)
        val hPad = dp(10)
        val vPad = dp(4)
        setPadding(hPad, vPad, hPad, vPad)
        // Default colour until bind() flips it — keeps the layout
        // preview readable in Android Studio.
        setTextColor(ContextCompat.getColor(context, R.color.ghola_text_secondary))
        // Mirror the web "Not downloaded" idle state for the empty
        // bind — also keeps the @ToolWindow preview meaningful.
        renderState(ModelStatus.NOT_DOWNLOADED, null)
    }

    /**
     * Bind the badge to a status snapshot.
     *
     * @param status    one of the four [ModelStatus] enum values produced
     *                  by `ModelManager.isModelVerified()`.
     * @param artifactName the artifact filename (e.g. `qwen2.5-1.5b…gguf`).
     *                  Currently used only as the accessibility
     *                  contentDescription; the visible chip stays
     *                  compact. Future iterations may put this in a
     *                  tooltip when targetSdk allows it.
     * @param hashShort optional pre-shortened hex (e.g. `438aea…3b1a`).
     *                  When non-null AND status==VERIFIED, appended to
     *                  the label with a middle-dot separator, matching
     *                  the web badge's `… · 438aea…` rendering. Ignored
     *                  for the other three states.
     */
    fun bind(status: ModelStatus, artifactName: String, hashShort: String?) {
        renderState(status, hashShort)
        contentDescription = buildContentDescription(status, artifactName, hashShort)
    }

    /**
     * Internal renderer — sets the compound drawable, label, and text
     * colour for a given status. Extracted so the init block can call
     * it without an artifactName.
     */
    private fun renderState(status: ModelStatus, hashShort: String?) {
        val spec = IntegrityBadgeRenderSpec.of(status, hashShort)
        val color = ContextCompat.getColor(context, spec.colorRes)
        text = spec.label
        setTextColor(color)

        val dot = DotDrawable(color, dp(8))
        // setBounds is what compound drawables actually honour for sizing;
        // intrinsic width on a custom drawable would also work but is
        // less explicit.
        dot.setBounds(0, 0, dp(8), dp(8))
        setCompoundDrawables(dot, null, null, null)
    }

    /**
     * Accessibility-only string. Screen readers see the full status
     * spelled out plus the artifact name — sighted users see the
     * compact chip.
     */
    private fun buildContentDescription(
        status: ModelStatus,
        artifactName: String,
        hashShort: String?,
    ): String = IntegrityBadgeRenderSpec.contentDescription(status, artifactName, hashShort)

    private fun dp(value: Int): Int {
        val density = resources.displayMetrics.density
        return (value * density).toInt()
    }

    /**
     * Tiny solid-fill circle drawable used as the leading compound
     * drawable. Inlined here (rather than a vector asset) so the badge
     * is self-contained — no new files under res/drawable, and the
     * colour is parameterised so we don't need one drawable per state.
     */
    private class DotDrawable(@ColorInt private val color: Int, private val diameter: Int) : Drawable() {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            this.color = color
            style = Paint.Style.FILL
        }

        override fun draw(canvas: Canvas) {
            val cx = bounds.centerX().toFloat()
            val cy = bounds.centerY().toFloat()
            val r = diameter / 2f
            canvas.drawCircle(cx, cy, r, paint)
        }

        override fun setAlpha(alpha: Int) {
            paint.alpha = alpha
        }

        override fun setColorFilter(colorFilter: ColorFilter?) {
            paint.colorFilter = colorFilter
        }

        @Deprecated("Required by Drawable contract; PixelFormat.TRANSLUCENT is the safe default.")
        override fun getOpacity(): Int = PixelFormat.TRANSLUCENT

        override fun getIntrinsicWidth(): Int = diameter
        override fun getIntrinsicHeight(): Int = diameter
    }
}

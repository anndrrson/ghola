package xyz.ghola.app.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.util.AttributeSet
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import com.patrykandpatrick.vico.core.cartesian.CartesianChart
import com.patrykandpatrick.vico.core.cartesian.axis.HorizontalAxis
import com.patrykandpatrick.vico.core.cartesian.axis.VerticalAxis
import com.patrykandpatrick.vico.core.cartesian.data.CartesianChartModelProducer
import com.patrykandpatrick.vico.core.cartesian.data.CartesianLayerRangeProvider
import com.patrykandpatrick.vico.core.cartesian.data.CartesianValueFormatter
import com.patrykandpatrick.vico.core.cartesian.data.candlestickSeries
import com.patrykandpatrick.vico.core.cartesian.layer.CandlestickCartesianLayer
import com.patrykandpatrick.vico.core.cartesian.layer.absolute
import com.patrykandpatrick.vico.core.common.Fill
import com.patrykandpatrick.vico.core.common.component.LineComponent
import com.patrykandpatrick.vico.core.common.component.TextComponent
import com.patrykandpatrick.vico.core.common.data.ExtraStore
import com.patrykandpatrick.vico.views.cartesian.CartesianChartView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import xyz.ghola.app.market.MarketCandle
import xyz.ghola.app.market.MarketSnapshot
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max

class MarketChartView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : FrameLayout(context, attrs) {

    private var scope = newScope()
    private val modelProducer = CartesianChartModelProducer()
    private val labelColor = Color.rgb(139, 149, 168)
    private val gridColor = Color.rgb(23, 34, 53)
    private val chartView: CartesianChartView
    private val chartOverlay: MarketChartOverlayView
    private val overlayText: TextView
    private val sourceText: TextView

    init {
        setBackgroundColor(Color.rgb(5, 7, 11))
        chartView = CartesianChartView(context).apply {
            setBackgroundColor(Color.rgb(5, 7, 11))
            modelProducer = this@MarketChartView.modelProducer
            chart = buildChart()
        }
        addView(
            chartView,
            LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT),
        )
        chartOverlay = MarketChartOverlayView(context)
        addView(
            chartOverlay,
            LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT),
        )

        sourceText = TextView(context).apply {
            setTextColor(labelColor)
            textSize = 11f
            typeface = Typeface.MONOSPACE
            setPadding(dp(12), dp(8), dp(12), dp(8))
        }
        addView(
            sourceText,
            LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START),
        )

        overlayText = TextView(context).apply {
            setTextColor(labelColor)
            textSize = 13f
            gravity = Gravity.CENTER
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.NORMAL)
        }
        addView(
            overlayText,
            LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT),
        )
    }

    fun setSnapshot(value: MarketSnapshot) {
        val candles = value.candles.takeLast(160)
        sourceText.text = "${if (value.stale) "STALE" else "LIVE"} / ${value.interval} / COINBASE"
        sourceText.visibility = View.VISIBLE
        if (candles.size < 2) {
            chartOverlay.clear()
            overlayText.text = value.error ?: "Waiting for market data"
            overlayText.visibility = View.VISIBLE
            return
        }
        overlayText.visibility = View.GONE
        chartOverlay.setCandles(candles, value)
        renderCandles(candles)
    }

    fun setLoading(text: String) {
        sourceText.visibility = View.GONE
        chartOverlay.clear()
        overlayText.text = text
        overlayText.visibility = View.VISIBLE
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        scope.cancel()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (!scope.isActive) {
            scope = newScope()
        }
    }

    private fun renderCandles(candles: List<MarketCandle>) {
        val x: List<Number> = candles.indices.toList()
        val opening: List<Number> = candles.map { it.open }
        val closing: List<Number> = candles.map { it.close }
        val low: List<Number> = candles.map { it.low }
        val high: List<Number> = candles.map { it.high }
        scope.launch {
            modelProducer.runTransaction {
                candlestickSeries(
                    x = x,
                    opening = opening,
                    closing = closing,
                    low = low,
                    high = high,
                )
            }
        }
    }

    private fun buildChart(): CartesianChart {
        val label = TextComponent(
            color = labelColor,
            typeface = Typeface.MONOSPACE,
            textSizeSp = 10f,
        )
        val guideline = LineComponent(Fill(gridColor), thicknessDp = 0.6f)
        val bullish = candle(Color.rgb(49, 211, 145))
        val neutral = candle(Color.rgb(61, 168, 255))
        val bearish = candle(Color.rgb(255, 90, 100))
        val priceFormatter = CartesianValueFormatter { _, value, _ -> value.cleanMarketAxis() }
        return CartesianChart(
            CandlestickCartesianLayer(
                candleProvider = CandlestickCartesianLayer.CandleProvider.absolute(
                    bullish = bullish,
                    neutral = neutral,
                    bearish = bearish,
                ),
                minCandleBodyHeightDp = 1.2f,
                candleSpacingDp = 2f,
                scaleCandleWicks = true,
                rangeProvider = MarketRangeProvider,
            ),
            endAxis = VerticalAxis.end(
                label = label,
                guideline = guideline,
                valueFormatter = priceFormatter,
            ),
            bottomAxis = HorizontalAxis.bottom(
                label = label,
                guideline = null,
                valueFormatter = CartesianValueFormatter.decimal(),
            ),
        )
    }

    private fun candle(color: Int): CandlestickCartesianLayer.Candle {
        val body = LineComponent(Fill(color), thicknessDp = 5.5f)
        val wick = LineComponent(Fill(color), thicknessDp = 1.2f)
        return CandlestickCartesianLayer.Candle(body = body, topWick = wick, bottomWick = wick)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun newScope(): CoroutineScope =
        CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
}

private class MarketChartOverlayView(context: Context) : View(context) {
    private val gridPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(23, 34, 53)
        strokeWidth = dp(1f)
    }
    private val lastPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(61, 168, 255)
        strokeWidth = dp(1f)
    }
    private val crosshairPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(180, 139, 149, 168)
        strokeWidth = dp(1f)
    }
    private val bullishPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(130, 49, 211, 145)
    }
    private val bearishPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(130, 255, 90, 100)
    }
    private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(139, 149, 168)
        textSize = sp(10f)
        typeface = Typeface.MONOSPACE
    }
    private val labelStrongPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(238, 241, 248)
        textSize = sp(11f)
        typeface = Typeface.MONOSPACE
    }
    private val boxPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(230, 5, 7, 11)
        style = Paint.Style.FILL
    }
    private val boxStrokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(30, 42, 58)
        style = Paint.Style.STROKE
        strokeWidth = dp(1f)
    }

    private var candles: List<MarketCandle> = emptyList()
    private var snapshot: MarketSnapshot? = null
    private var selectedIndex: Int? = null

    init {
        isClickable = true
        setWillNotDraw(false)
    }

    fun setCandles(value: List<MarketCandle>, snapshot: MarketSnapshot) {
        candles = value
        this.snapshot = snapshot
        selectedIndex = selectedIndex?.coerceIn(0, (value.size - 1).coerceAtLeast(0))
        invalidate()
    }

    fun clear() {
        candles = emptyList()
        snapshot = null
        selectedIndex = null
        invalidate()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (candles.isEmpty()) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE -> {
                selectedIndex = nearestIndex(event.x)
                invalidate()
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                selectedIndex = null
                invalidate()
                return true
            }
        }
        return true
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val data = candles
        if (data.size < 2) return
        drawVolume(canvas, data)
        drawLastPrice(canvas, data)
        selectedIndex?.let { drawSelection(canvas, data, it.coerceIn(data.indices)) }
    }

    private fun drawVolume(canvas: Canvas, data: List<MarketCandle>) {
        val maxVolume = data.maxOfOrNull { it.volume }?.takeIf { it > 0.0 } ?: return
        val top = height * 0.78f
        val bottom = height - dp(24f)
        val slot = width.toFloat() / data.size
        val barWidth = max(dp(1.4f), slot * 0.55f)
        canvas.drawLine(0f, top, width.toFloat(), top, gridPaint)
        data.forEachIndexed { index, candle ->
            val fraction = (candle.volume / maxVolume).toFloat().coerceIn(0f, 1f)
            val left = index * slot + (slot - barWidth) / 2f
            val right = left + barWidth
            val barTop = bottom - (bottom - top) * fraction
            val paint = if (candle.close >= candle.open) bullishPaint else bearishPaint
            canvas.drawRect(left, barTop, right, bottom, paint)
        }
    }

    private fun drawLastPrice(canvas: Canvas, data: List<MarketCandle>) {
        val last = data.lastOrNull()?.close ?: return
        val range = data.priceRange()
        val y = priceToY(last, range)
        canvas.drawLine(0f, y, width.toFloat(), y, lastPaint)
        val label = last.cleanMarketAxis()
        val textWidth = labelStrongPaint.measureText(label)
        val rect = RectF(width.toFloat() - textWidth - dp(12f), y - dp(11f), width.toFloat(), y + dp(8f))
        canvas.drawRect(rect, boxPaint)
        canvas.drawRect(rect, boxStrokePaint)
        canvas.drawText(label, rect.left + dp(5f), y + dp(4f), labelStrongPaint)
    }

    private fun drawSelection(canvas: Canvas, data: List<MarketCandle>, index: Int) {
        val candle = data[index]
        val x = indexToX(index, data.size)
        canvas.drawLine(x, 0f, x, height.toFloat(), crosshairPaint)
        val range = data.priceRange()
        val closeY = priceToY(candle.close, range)
        canvas.drawLine(0f, closeY, width.toFloat(), closeY, crosshairPaint)
        val lines = listOf(
            "O ${candle.open.cleanMarketAxis()}  H ${candle.high.cleanMarketAxis()}",
            "L ${candle.low.cleanMarketAxis()}  C ${candle.close.cleanMarketAxis()}",
            "V ${candle.volume.cleanMarketAxis()}  ${snapshot?.liveStatus?.uppercase(Locale.US) ?: ""}",
        )
        val boxWidth = lines.maxOf { labelStrongPaint.measureText(it) } + dp(18f)
        val boxHeight = dp(58f)
        val boxLeft = if (x + boxWidth + dp(12f) < width) x + dp(10f) else x - boxWidth - dp(10f)
        val boxTop = dp(36f)
        val rect = RectF(boxLeft, boxTop, boxLeft + boxWidth, boxTop + boxHeight)
        canvas.drawRect(rect, boxPaint)
        canvas.drawRect(rect, boxStrokePaint)
        lines.forEachIndexed { lineIndex, line ->
            canvas.drawText(
                line,
                rect.left + dp(8f),
                rect.top + dp(18f + lineIndex.toFloat() * 16f),
                if (lineIndex == 0) labelStrongPaint else labelPaint,
            )
        }
    }

    private fun nearestIndex(x: Float): Int {
        val count = candles.size
        if (count <= 1) return 0
        if (width <= 0) return 0
        return ((x / width.toFloat()) * (count - 1)).toInt().coerceIn(0, count - 1)
    }

    private fun indexToX(index: Int, count: Int): Float {
        if (count <= 1) return 0f
        return width * (index.toFloat() / (count - 1).toFloat())
    }

    private fun priceToY(price: Double, range: PriceRange): Float {
        val fraction = ((price - range.min) / range.range).toFloat().coerceIn(0f, 1f)
        return height - fraction * height
    }

    private fun List<MarketCandle>.priceRange(): PriceRange {
        val rawMin = minOf { it.low }
        val rawMax = maxOf { it.high }
        val rawRange = max(rawMax - rawMin, 0.000001)
        val padding = max(rawRange * 0.08, abs(rawMax) * 0.002)
        return PriceRange(rawMin - padding, rawMax + padding)
    }

    private fun dp(value: Float): Float = value * resources.displayMetrics.density
    private fun sp(value: Float): Float = value * resources.displayMetrics.scaledDensity
}

private data class PriceRange(val min: Double, val max: Double) {
    val range: Double = kotlin.math.max(max - min, 0.000001)
}

private object MarketRangeProvider : CartesianLayerRangeProvider {
    override fun getMinY(minY: Double, maxY: Double, extraStore: ExtraStore): Double =
        minY - padding(minY, maxY)

    override fun getMaxY(minY: Double, maxY: Double, extraStore: ExtraStore): Double =
        maxY + padding(minY, maxY)

    private fun padding(minY: Double, maxY: Double): Double {
        val range = maxY - minY
        val fallback = maxOf(abs(maxY) * 0.002, 1.0)
        return maxOf(range * 0.08, fallback)
    }
}

private fun Double.cleanMarketAxis(): String {
    if (!isFinite()) return ""
    val absolute = abs(this)
    val scaled = when {
        absolute >= 1_000_000.0 -> this / 1_000_000.0
        absolute >= 1_000.0 -> this / 1_000.0
        else -> this
    }
    val suffix = when {
        absolute >= 1_000_000.0 -> "M"
        absolute >= 1_000.0 -> "K"
        else -> ""
    }
    val decimals = when {
        absolute >= 1_000.0 -> 1
        absolute >= 10.0 -> 2
        else -> 4
    }
    return "%.${decimals}f".format(Locale.US, scaled)
        .trimEnd('0')
        .trimEnd('.') + suffix
}

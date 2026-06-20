package xyz.ghola.app.market

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.TimeUnit
import kotlin.math.max

data class MarketCandle(
    val startMillis: Long,
    val open: Double,
    val high: Double,
    val low: Double,
    val close: Double,
    val volume: Double,
)

data class MarketBookLevel(
    val price: Double,
    val size: Double,
)

data class MarketDexVenue(
    val platform: String,
    val source: String?,
    val stale: Boolean,
    val mid: Double?,
    val markPrice: Double?,
    val oraclePrice: Double?,
    val bestBid: Double?,
    val bestAsk: Double?,
    val spreadBps: Double?,
    val fundingRate: Double?,
    val openInterest: Double?,
    val dayNotionalVolume: Double?,
    val candles: List<MarketCandle>,
    val bids: List<MarketBookLevel>,
    val asks: List<MarketBookLevel>,
)

data class JupiterRouteQuote(
    val inputAmount: Double?,
    val outputAmount: Double?,
    val price: Double?,
    val priceImpactPct: Double?,
    val slippageBps: Int,
    val routeSummary: List<String>,
    val stale: Boolean,
)

data class SolanaDexContext(
    val phoenix: MarketDexVenue?,
    val jupiter: JupiterRouteQuote?,
)

data class MarketStreamStatus(
    val liveStatus: String,
    val updatedAt: String?,
    val error: String?,
)

data class MarketSnapshot(
    val productId: String,
    val baseCurrency: String,
    val interval: String,
    val fetchedAtMillis: Long,
    val source: String,
    val liveStatus: String,
    val warnings: List<String>,
    val stale: Boolean,
    val error: String?,
    val price: Double?,
    val mid: Double?,
    val bestBid: Double?,
    val bestAsk: Double?,
    val spreadBps: Double?,
    val change24h: Double?,
    val volume24h: Double?,
    val candles: List<MarketCandle>,
    val bids: List<MarketBookLevel>,
    val asks: List<MarketBookLevel>,
    val solanaDex: SolanaDexContext? = null,
) {
    fun toAgentContext(kind: AgentContextKind = AgentContextKind.MarketBrief): String {
        val recent = candles.takeLast(16).joinToString(separator = "\n") { candle ->
            "candle t=${candle.startMillis / 1000} o=${candle.open.clean()} h=${candle.high.clean()} " +
                "l=${candle.low.clean()} c=${candle.close.clean()} v=${candle.volume.clean()}"
        }.ifBlank { "none" }
        val bidLevels = bids.take(5).joinToString { "${it.price.clean()}@${it.size.clean()}" }
            .ifBlank { "none" }
        val askLevels = asks.take(5).joinToString { "${it.price.clean()}@${it.size.clean()}" }
            .ifBlank { "none" }
        val phoenix = solanaDex?.phoenix
        val phoenixLine = phoenix?.let {
            "phoenix mid=${it.mid?.clean() ?: "unknown"} mark=${it.markPrice?.clean() ?: "unknown"} " +
                "bid=${it.bestBid?.clean() ?: "unknown"} ask=${it.bestAsk?.clean() ?: "unknown"} " +
                "spread_bps=${it.spreadBps?.clean() ?: "unknown"} funding=${it.fundingRate?.clean() ?: "unknown"}"
        } ?: "none"
        val jupiterLine = solanaDex?.jupiter?.let {
            "jupiter price=${it.price?.clean() ?: "unknown"} output_amount=${it.outputAmount?.clean() ?: "unknown"} " +
                "price_impact_pct=${it.priceImpactPct?.clean() ?: "unknown"} slippage_bps=${it.slippageBps} " +
                "route=${it.routeSummary.joinToString(" > ").ifBlank { "unknown" }}"
        } ?: "none"

        val task = when (kind) {
            AgentContextKind.MarketBrief ->
                "Give me a concise market brief with trend, liquidity, key levels, and risk."
            AgentContextKind.TradePlan ->
                "Structure a trade plan with entry, invalidation, position sizing assumptions, and risk controls. Do not execute anything without an explicit approval."
        }

        return buildString {
            appendLine("Use this native Ghola market snapshot as the source context.")
            appendLine("source=$source live_status=$liveStatus stale=$stale product=$productId interval=$interval fetched_at_ms=$fetchedAtMillis warnings=${warnings.joinToString(",").ifBlank { "none" }}")
            appendLine("price=${price?.clean() ?: "unknown"} mid=${mid?.clean() ?: "unknown"} best_bid=${bestBid?.clean() ?: "unknown"} best_ask=${bestAsk?.clean() ?: "unknown"} spread_bps=${spreadBps?.clean() ?: "unknown"}")
            appendLine("change_24h=${change24h?.clean() ?: "unknown"} volume_24h=${volume24h?.clean() ?: "unknown"}")
            appendLine("top_bids=$bidLevels")
            appendLine("top_asks=$askLevels")
            appendLine("solana_dex_phoenix=$phoenixLine")
            appendLine("solana_dex_jupiter=$jupiterLine")
            appendLine("recent_candles:")
            appendLine(recent)
            append(task)
        }
    }
}

enum class AgentContextKind {
    MarketBrief,
    TradePlan,
}

class MarketDataClient(
    private val cloudBaseUrl: String? = null,
    private val httpClient: OkHttpClient = OkHttpClient(),
) {
    companion object {
        private const val COINBASE_MARKET_URL = "https://api.coinbase.com/api/v3/brokerage/market"
        private const val CANDLE_WINDOW = 160
        private const val BOOK_WINDOW = 20
        private const val DEFAULT_PRODUCT = "BTC-USD"
        private val PRODUCTS = setOf("BTC-USD", "ETH-USD", "SOL-USD")
        private val INTERVALS = mapOf(
            "1m" to ("ONE_MINUTE" to 60L),
            "5m" to ("FIVE_MINUTE" to 5L * 60L),
            "15m" to ("FIFTEEN_MINUTE" to 15L * 60L),
            "1h" to ("ONE_HOUR" to 60L * 60L),
        )
    }

    interface MarketStreamListener {
        fun onSnapshot(snapshot: MarketSnapshot)
        fun onStatus(status: MarketStreamStatus)
        fun onFailure(message: String)
    }

    private val streamingClient = httpClient.newBuilder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    fun getSnapshot(productId: String = DEFAULT_PRODUCT, interval: String = "5m"): MarketSnapshot {
        val product = normalizeProduct(productId)
        val intervalInfo = INTERVALS[interval] ?: INTERVALS.getValue("5m")
        val intervalLabel = if (INTERVALS.containsKey(interval)) interval else "5m"
        val nowMillis = System.currentTimeMillis()
        mobileUrl("/v1/private-account/markets/mobile-snapshot", product, intervalLabel)?.let { url ->
            val cloudSnapshot = runCatching {
                val request = Request.Builder()
                    .url(url)
                    .header("cache-control", "no-cache")
                    .get()
                    .build()
                httpClient.newCall(request).execute().use { response ->
                    val body = response.body?.string().orEmpty()
                    if (!response.isSuccessful || body.isBlank()) {
                        throw IllegalStateException("mobile_market_${response.code}")
                    }
                    parseMobileSnapshot(JSONObject(body))
                }
            }.getOrNull()
            if (cloudSnapshot != null) return cloudSnapshot
        }
        val endSeconds = nowMillis / 1000L
        val startSeconds = endSeconds - intervalInfo.second * CANDLE_WINDOW

        return try {
            val productJson = getJson("/products/$product")
            val bookJson = getJson("/product_book?product_id=$product&limit=$BOOK_WINDOW")
            val candleJson = getJson(
                "/products/$product/candles?start=$startSeconds&end=$endSeconds" +
                    "&granularity=${intervalInfo.first}&limit=$CANDLE_WINDOW",
            )
            buildSnapshot(
                productId = product,
                interval = intervalLabel,
                fetchedAtMillis = nowMillis,
                stale = false,
                error = null,
                productJson = productJson,
                bookJson = bookJson,
                candleJson = candleJson,
            )
        } catch (e: Exception) {
            emptySnapshot(
                productId = product,
                interval = intervalLabel,
                fetchedAtMillis = nowMillis,
                error = e.message ?: "Market data unavailable",
            )
        }
    }

    fun openStream(
        productId: String = DEFAULT_PRODUCT,
        interval: String = "5m",
        listener: MarketStreamListener,
    ): EventSource? {
        val product = normalizeProduct(productId)
        val intervalLabel = if (INTERVALS.containsKey(interval)) interval else "5m"
        val url = mobileUrl("/v1/private-account/markets/mobile-stream", product, intervalLabel) ?: return null
        val request = Request.Builder()
            .url(url)
            .header("cache-control", "no-cache")
            .get()
            .build()
        return EventSources.createFactory(streamingClient).newEventSource(
            request,
            object : EventSourceListener() {
                override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                    when (type) {
                        "snapshot", null -> runCatching {
                            listener.onSnapshot(parseMobileSnapshot(JSONObject(data)))
                        }.onFailure { listener.onFailure(it.message ?: "Invalid market snapshot") }
                        "status" -> runCatching {
                            val json = JSONObject(data)
                            listener.onStatus(
                                MarketStreamStatus(
                                    liveStatus = json.optString("live_status", "connecting"),
                                    updatedAt = json.optString("updated_at").takeIf { it.isNotBlank() },
                                    error = json.optString("error").takeIf { it.isNotBlank() },
                                ),
                            )
                        }.onFailure { listener.onFailure(it.message ?: "Invalid stream status") }
                    }
                }

                override fun onFailure(eventSource: EventSource, t: Throwable?, response: okhttp3.Response?) {
                    listener.onFailure(t?.message ?: "Market stream disconnected")
                }
            },
        )
    }

    private fun mobileUrl(path: String, productId: String, interval: String): okhttp3.HttpUrl? {
        val base = cloudBaseUrl?.trim()?.takeIf { it.isNotBlank() } ?: return null
        val builder = base.removeSuffix("/").toHttpUrlOrNull()?.newBuilder() ?: return null
        path.trim('/').split('/').forEach { builder.addPathSegment(it) }
        return builder
            .addQueryParameter("product_id", productId)
            .addQueryParameter("interval", interval)
            .build()
    }

    private fun getJson(path: String): JSONObject {
        val request = Request.Builder()
            .url("$COINBASE_MARKET_URL$path")
            .header("cache-control", "no-cache")
            .get()
            .build()
        httpClient.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful || body.isBlank()) {
                throw IllegalStateException("coinbase_market_${response.code}")
            }
            return JSONObject(body)
        }
    }

    private fun buildSnapshot(
        productId: String,
        interval: String,
        fetchedAtMillis: Long,
        stale: Boolean,
        error: String?,
        productJson: JSONObject,
        bookJson: JSONObject,
        candleJson: JSONObject,
    ): MarketSnapshot {
        val pricebook = bookJson.optJSONObject("pricebook")
        val bids = normalizeBook(pricebook?.optJSONArray("bids"))
        val asks = normalizeBook(pricebook?.optJSONArray("asks"))
        val bestBid = bids.firstOrNull()?.price ?: productJson.safeDouble("best_bid_price")
        val bestAsk = asks.firstOrNull()?.price ?: productJson.safeDouble("best_ask_price")
        val price = productJson.safeDouble("price") ?: bookJson.safeDouble("last")
        val mid = bookJson.safeDouble("mid_market")
            ?: productJson.safeDouble("mid_market_price")
            ?: midFromBook(bestBid, bestAsk)
            ?: price

        return MarketSnapshot(
            productId = productId,
            baseCurrency = productId.substringBefore("-"),
            interval = interval,
            fetchedAtMillis = fetchedAtMillis,
            source = "coinbase_advanced_public",
            liveStatus = if (stale) "stale" else "fallback",
            warnings = if (stale) listOfNotNull(error) else emptyList(),
            stale = stale,
            error = error,
            price = price,
            mid = mid,
            bestBid = bestBid,
            bestAsk = bestAsk,
            spreadBps = bookJson.safeDouble("spread_bps") ?: spreadBps(bestBid, bestAsk),
            change24h = productJson.safeSignedDouble("price_percentage_change_24h"),
            volume24h = productJson.safeDouble("volume_24h"),
            candles = normalizeCandles(candleJson.optJSONArray("candles")),
            bids = bids,
            asks = asks,
        )
    }

    private fun emptySnapshot(
        productId: String,
        interval: String,
        fetchedAtMillis: Long,
        error: String,
    ): MarketSnapshot = MarketSnapshot(
        productId = productId,
        baseCurrency = productId.substringBefore("-"),
        interval = interval,
        fetchedAtMillis = fetchedAtMillis,
        source = "coinbase_advanced_public",
        liveStatus = "stale",
        warnings = listOf(error),
        stale = true,
        error = error,
        price = null,
        mid = null,
        bestBid = null,
        bestAsk = null,
        spreadBps = null,
        change24h = null,
        volume24h = null,
        candles = emptyList(),
        bids = emptyList(),
        asks = emptyList(),
    )

    private fun parseMobileSnapshot(json: JSONObject): MarketSnapshot {
        val primary = json.optJSONObject("primary") ?: JSONObject()
        val productId = normalizeProduct(json.optString("product_id", DEFAULT_PRODUCT))
        val interval = json.optString("interval", "5m").takeIf { INTERVALS.containsKey(it) } ?: "5m"
        val warnings = json.optJSONArray("warnings").toStringList()
        val stale = primary.optBoolean("stale", false) || json.optString("live_status") == "stale"
        val source = listOfNotNull(
            primary.optString("platform", "coinbase").takeIf { it.isNotBlank() },
            primary.optString("source").takeIf { it.isNotBlank() },
        ).joinToString(":").ifBlank { "coinbase" }
        return MarketSnapshot(
            productId = productId,
            baseCurrency = json.optString("base_currency", productId.substringBefore("-")),
            interval = interval,
            fetchedAtMillis = json.safeTimeMillis("fetched_at") ?: System.currentTimeMillis(),
            source = source,
            liveStatus = json.optString("live_status", if (stale) "stale" else "live"),
            warnings = warnings,
            stale = stale,
            error = warnings.firstOrNull(),
            price = primary.safeDouble("price"),
            mid = primary.safeDouble("mid"),
            bestBid = primary.safeDouble("best_bid"),
            bestAsk = primary.safeDouble("best_ask"),
            spreadBps = primary.safeDouble("spread_bps"),
            change24h = primary.safeSignedDouble("price_percentage_change_24h"),
            volume24h = primary.safeDouble("volume_24h"),
            candles = normalizeCandles(primary.optJSONArray("candles")),
            bids = normalizeBook(primary.optJSONArray("bids")),
            asks = normalizeBook(primary.optJSONArray("asks")),
            solanaDex = parseSolanaDex(json.optJSONObject("solana_dex")),
        )
    }

    private fun parseSolanaDex(json: JSONObject?): SolanaDexContext? {
        if (json == null) return null
        return SolanaDexContext(
            phoenix = parseDexVenue(json.optJSONObject("phoenix")),
            jupiter = parseJupiter(json.optJSONObject("jupiter")),
        )
    }

    private fun parseDexVenue(json: JSONObject?): MarketDexVenue? {
        if (json == null) return null
        return MarketDexVenue(
            platform = json.optString("platform", "phoenix"),
            source = json.optString("source").takeIf { it.isNotBlank() },
            stale = json.optBoolean("stale", false),
            mid = json.safeDouble("mid"),
            markPrice = json.safeDouble("mark_price"),
            oraclePrice = json.safeDouble("oracle_price"),
            bestBid = json.safeDouble("best_bid"),
            bestAsk = json.safeDouble("best_ask"),
            spreadBps = json.safeDouble("spread_bps"),
            fundingRate = json.safeSignedDouble("funding_rate"),
            openInterest = json.safeDouble("open_interest"),
            dayNotionalVolume = json.safeDouble("day_notional_volume"),
            candles = normalizeCandles(json.optJSONArray("candles")),
            bids = normalizeBook(json.optJSONArray("bids")),
            asks = normalizeBook(json.optJSONArray("asks")),
        )
    }

    private fun parseJupiter(json: JSONObject?): JupiterRouteQuote? {
        if (json == null) return null
        return JupiterRouteQuote(
            inputAmount = json.safeDouble("input_amount"),
            outputAmount = json.safeDouble("output_amount"),
            price = json.safeDouble("price"),
            priceImpactPct = json.safeSignedDouble("price_impact_pct"),
            slippageBps = json.optInt("slippage_bps", 0),
            routeSummary = json.optJSONArray("route_summary").toStringList(),
            stale = json.optBoolean("stale", false),
        )
    }

    private fun normalizeProduct(raw: String): String {
        val value = raw.trim().uppercase()
        val product = if (value.contains("-")) value else "$value-USD"
        return if (PRODUCTS.contains(product)) product else DEFAULT_PRODUCT
    }

    private fun normalizeCandles(candles: JSONArray?): List<MarketCandle> {
        if (candles == null) return emptyList()
        val normalized = mutableListOf<MarketCandle>()
        for (i in 0 until candles.length()) {
            val item = candles.optJSONObject(i) ?: continue
            val start = item.safeTimeMillis("t") ?: item.safeTimeMillis("start") ?: continue
            val open = item.safeDouble("o") ?: item.safeDouble("open") ?: continue
            val high = item.safeDouble("h") ?: item.safeDouble("high") ?: continue
            val low = item.safeDouble("l") ?: item.safeDouble("low") ?: continue
            val close = item.safeDouble("c") ?: item.safeDouble("close") ?: continue
            val volume = item.safeDouble("v") ?: item.safeDouble("volume") ?: 0.0
            if (open <= 0.0 || high <= 0.0 || low <= 0.0 || close <= 0.0) continue
            normalized += MarketCandle(start, open, high, low, close, volume)
        }
        return normalized.sortedBy { it.startMillis }.takeLast(CANDLE_WINDOW)
    }

    private fun normalizeBook(levels: JSONArray?): List<MarketBookLevel> {
        if (levels == null) return emptyList()
        val normalized = mutableListOf<MarketBookLevel>()
        for (i in 0 until levels.length()) {
            val item = levels.optJSONObject(i) ?: continue
            val price = item.safeDouble("px") ?: item.safeDouble("price") ?: item.safeDouble("price_level") ?: continue
            val size = item.safeDouble("sz") ?: item.safeDouble("size") ?: item.safeDouble("new_quantity") ?: continue
            if (price > 0.0 && size > 0.0) {
                normalized += MarketBookLevel(price, size)
            }
        }
        return normalized.take(BOOK_WINDOW)
    }

    private fun midFromBook(bestBid: Double?, bestAsk: Double?): Double? {
        if (bestBid == null || bestAsk == null || bestBid <= 0.0 || bestAsk <= 0.0) return null
        return (bestBid + bestAsk) / 2.0
    }

    private fun spreadBps(bestBid: Double?, bestAsk: Double?): Double? {
        if (bestBid == null || bestAsk == null || bestBid <= 0.0 || bestAsk <= 0.0) return null
        val mid = (bestBid + bestAsk) / 2.0
        if (mid <= 0.0) return null
        return max(0.0, ((bestAsk - bestBid) / mid) * 10_000.0)
    }
}

private fun JSONObject.safeDouble(name: String): Double? =
    safeUnsignedNumber(if (has(name) && !isNull(name)) opt(name) else null)

private fun JSONObject.safeSignedDouble(name: String): Double? =
    safeSignedNumber(if (has(name) && !isNull(name)) opt(name) else null)

private fun JSONObject.safeTimeMillis(name: String): Long? {
    val value = if (has(name) && !isNull(name)) opt(name) else null
    val secondsOrMillis = when (value) {
        is Number -> value.toLong()
        is String -> value.trim().toLongOrNull()
            ?: runCatching { Instant.parse(value.trim()).toEpochMilli() }.getOrNull()
        else -> null
    } ?: return null
    return if (secondsOrMillis < 10_000_000_000L) secondsOrMillis * 1000L else secondsOrMillis
}

private fun JSONArray?.toStringList(): List<String> {
    if (this == null) return emptyList()
    val values = mutableListOf<String>()
    for (i in 0 until length()) {
        optString(i).takeIf { it.isNotBlank() }?.let { values += it }
    }
    return values
}

private fun safeUnsignedNumber(value: Any?): Double? {
    val parsed = safeSignedNumber(value) ?: return null
    return parsed.takeIf { it >= 0.0 }
}

private fun safeSignedNumber(value: Any?): Double? {
    val parsed = when (value) {
        is Number -> value.toDouble()
        is String -> value.trim().removeSuffix("%").toDoubleOrNull()
        else -> null
    }
    return parsed?.takeIf { it.isFinite() }
}

private fun Double.clean(): String {
    if (!isFinite()) return "unknown"
    val abs = kotlin.math.abs(this)
    val decimals = when {
        abs >= 1000.0 -> 2
        abs >= 10.0 -> 4
        else -> 6
    }
    return "%.${decimals}f".format(java.util.Locale.US, this)
        .trimEnd('0')
        .trimEnd('.')
}

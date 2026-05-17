package xyz.ghola.app.service

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Phase α — per-inference battery + thermal + energy snapshots.
 *
 * Records start/end state around each `LlmBackend.generate()` invocation so
 * the upcoming NPU backend (Phase γ) has a baseline to beat. The metrics
 * captured are all readable without root and without battery-historian:
 *
 *   - wall-clock duration (System.nanoTime / 1e6 → ms)
 *   - battery percentage delta
 *   - charging-state start/end (so a snapshot that started on AC and ended
 *     unplugged can be discarded by the analyser)
 *   - thermal-state start/end (PowerManager.currentThermalStatus, API 29+)
 *   - instantaneous current-draw start/end (BATTERY_PROPERTY_CURRENT_NOW, µA;
 *     OEM-dependent — `null` when unavailable, never spuriously zero)
 *   - tokens generated (caller-supplied — usually `ApiResponse.usage.outputTokens`)
 *   - backend identity + model identity tags (for grouping in analysis)
 *
 * ## Derived energy estimate
 *
 * Wh per token is a *best-effort* derivation, not a calibrated reading. The
 * formula assumes:
 *
 *   1. The battery is at the nominal Seeker pack voltage (3.85 V). This is
 *      hard-coded because Android does not expose a stable per-cell-voltage
 *      reading on most OEM builds.
 *   2. `BATTERY_PROPERTY_CURRENT_NOW` is reported in microamperes (true on
 *      all AOSP devices and the Solana Seeker). Some Samsung/Xiaomi forks
 *      report milliamperes — those readings will be off by 1000× and the
 *      analyser must reject them.
 *   3. Token generation is the dominant load during the window. Background
 *      jobs (radio, screen) are baked into the average. This is acceptable
 *      because Phase α is a *baseline* — we're measuring the actual user
 *      experience, not isolated kernel cost.
 *
 * The estimate uses the *average* of start/end current (trapezoidal-rule
 * approximation over the inference window):
 *
 *     avg_uA = (start_uA + end_uA) / 2
 *     avg_W  = (avg_uA / 1_000_000) * 3.85
 *     energy_Wh = avg_W * (duration_ms / 1000) / 3600
 *     wh_per_token = energy_Wh / max(1, tokens)
 *
 * When either current sample is unavailable the field is `null` and the
 * analyser falls back to battery-percentage-delta * battery-capacity, which
 * is much noisier but works without an OEM-friendly current sensor.
 *
 * ## Thread safety
 *
 * Active sessions live in a [ConcurrentHashMap] keyed by session id.
 * Ring-buffer mutations are guarded by a [Mutex] so concurrent end/cancel
 * calls produce a consistent ordering.
 */
class BatteryEnergyProfiler(
    private val sampler: SystemSampler,
    private val maxSnapshots: Int = DEFAULT_RING_SIZE,
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val monotonicClock: () -> Long = { System.nanoTime() },
) {

    /**
     * Production-path constructor. Reads battery + thermal + current draw
     * from the platform services. Visible-for-test callers can supply a
     * [SystemSampler] directly to inject deterministic values.
     */
    constructor(
        context: Context,
        maxSnapshots: Int = DEFAULT_RING_SIZE,
        clock: () -> Long = { System.currentTimeMillis() },
        monotonicClock: () -> Long = { System.nanoTime() },
    ) : this(
        sampler = AndroidSystemSampler(context.applicationContext),
        maxSnapshots = maxSnapshots,
        clock = clock,
        monotonicClock = monotonicClock,
    )

    companion object {
        const val DEFAULT_RING_SIZE: Int = 50

        /** Nominal Seeker / Saga battery pack voltage. See class kdoc. */
        const val NOMINAL_VOLTAGE_V: Double = 3.85
    }

    /**
     * Public snapshot record. Stored in the ring buffer and serialised by
     * [exportJson]. Field names match the JSON wire format 1:1.
     */
    data class Snapshot(
        val sessionId: String,
        val backendName: String,
        val modelName: String?,
        val startEpochMs: Long,
        val endEpochMs: Long,
        val durationMs: Long,
        val startBatteryPct: Int,
        val endBatteryPct: Int,
        val startCharging: Boolean,
        val endCharging: Boolean,
        val startThermal: String,
        val endThermal: String,
        val startCurrentUa: Long?,
        val endCurrentUa: Long?,
        val tokensGenerated: Int,
        val whPerToken: Double?,
        val totalWh: Double?,
        val cancelled: Boolean,
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("session_id", sessionId)
            put("backend", backendName)
            put("model", modelName ?: JSONObject.NULL)
            put("start_epoch_ms", startEpochMs)
            put("end_epoch_ms", endEpochMs)
            put("duration_ms", durationMs)
            put("start_battery_pct", startBatteryPct)
            put("end_battery_pct", endBatteryPct)
            put("start_charging", startCharging)
            put("end_charging", endCharging)
            put("start_thermal", startThermal)
            put("end_thermal", endThermal)
            put("start_current_ua", startCurrentUa ?: JSONObject.NULL)
            put("end_current_ua", endCurrentUa ?: JSONObject.NULL)
            put("tokens_generated", tokensGenerated)
            put("wh_per_token", whPerToken ?: JSONObject.NULL)
            put("total_wh", totalWh ?: JSONObject.NULL)
            put("cancelled", cancelled)
        }
    }

    private data class Active(
        val sessionId: String,
        val backendName: String,
        val modelName: String?,
        val startEpochMs: Long,
        val startMonotonicNs: Long,
        val startBatteryPct: Int,
        val startCharging: Boolean,
        val startThermal: String,
        val startCurrentUa: Long?,
    )

    private val active: MutableMap<String, Active> = ConcurrentHashMap()
    private val ring: ArrayDeque<Snapshot> = ArrayDeque(maxSnapshots)
    private val mutex = Mutex()

    /**
     * Open a profile session. Returns a session id to thread through to
     * [end] / [cancel]. Capturing battery/thermal at start is best-effort;
     * if the system services are unavailable the snapshot still completes
     * with the sentinel values (-1 battery, "NONE" thermal).
     */
    suspend fun begin(backendName: String, modelName: String? = null): String {
        val s = readSystemState()
        val id = UUID.randomUUID().toString()
        active[id] = Active(
            sessionId = id,
            backendName = backendName,
            modelName = modelName,
            startEpochMs = clock(),
            startMonotonicNs = monotonicClock(),
            startBatteryPct = s.batteryPct,
            startCharging = s.charging,
            startThermal = s.thermal,
            startCurrentUa = s.currentUa,
        )
        return id
    }

    /**
     * Close a profile session and append the snapshot to the ring buffer.
     * Returns the resulting [Snapshot], or `null` if the session id is
     * unknown (e.g. already ended or cancelled).
     */
    suspend fun end(sessionId: String, tokensGenerated: Int): Snapshot? {
        val a = active.remove(sessionId) ?: return null
        val s = readSystemState()
        val endEpoch = clock()
        val durationMs = (monotonicClock() - a.startMonotonicNs) / 1_000_000
        val snap = buildSnapshot(a, s, endEpoch, durationMs, tokensGenerated, cancelled = false)
        mutex.withLock { appendLocked(snap) }
        return snap
    }

    /**
     * Cancel an in-flight session. The snapshot is still recorded (so we
     * can spot patterns of cancellation under thermal pressure) but the
     * derived energy fields are intentionally left null.
     */
    suspend fun cancel(sessionId: String): Snapshot? {
        val a = active.remove(sessionId) ?: return null
        val s = readSystemState()
        val endEpoch = clock()
        val durationMs = (monotonicClock() - a.startMonotonicNs) / 1_000_000
        val snap = buildSnapshot(a, s, endEpoch, durationMs, tokensGenerated = 0, cancelled = true)
            .copy(whPerToken = null, totalWh = null)
        mutex.withLock { appendLocked(snap) }
        return snap
    }

    /** Snapshot of the ring buffer in insertion order (oldest → newest). */
    suspend fun snapshots(): List<Snapshot> = mutex.withLock { ring.toList() }

    /**
     * Drop everything in the ring buffer. Used by tests + the DevTools
     * screen (when it lands in a later phase).
     */
    suspend fun clear() {
        mutex.withLock { ring.clear() }
    }

    /** Return the number of completed snapshots currently in the ring. */
    suspend fun size(): Int = mutex.withLock { ring.size }

    /** JSON wire format identical to the upcoming `/dev/perf` payload. */
    suspend fun exportJson(): JSONObject {
        val arr = JSONArray()
        mutex.withLock {
            for (snap in ring) arr.put(snap.toJson())
        }
        return JSONObject().apply {
            put("schema_version", 1)
            put("ring_size", maxSnapshots)
            put("snapshots", arr)
            put("exported_at_epoch_ms", clock())
        }
    }

    // ───────────────────────────── internals ─────────────────────────────

    private fun appendLocked(snap: Snapshot) {
        if (ring.size >= maxSnapshots) ring.removeFirst()
        ring.addLast(snap)
    }

    private fun buildSnapshot(
        a: Active,
        s: SystemState,
        endEpoch: Long,
        durationMs: Long,
        tokensGenerated: Int,
        cancelled: Boolean,
    ): Snapshot {
        val (whPerToken, totalWh) = deriveEnergy(
            startUa = a.startCurrentUa,
            endUa = s.currentUa,
            durationMs = durationMs,
            tokens = tokensGenerated,
        )
        return Snapshot(
            sessionId = a.sessionId,
            backendName = a.backendName,
            modelName = a.modelName,
            startEpochMs = a.startEpochMs,
            endEpochMs = endEpoch,
            durationMs = durationMs,
            startBatteryPct = a.startBatteryPct,
            endBatteryPct = s.batteryPct,
            startCharging = a.startCharging,
            endCharging = s.charging,
            startThermal = a.startThermal,
            endThermal = s.thermal,
            startCurrentUa = a.startCurrentUa,
            endCurrentUa = s.currentUa,
            tokensGenerated = tokensGenerated,
            whPerToken = whPerToken,
            totalWh = totalWh,
            cancelled = cancelled,
        )
    }

    /**
     * Visible for test. Returns (whPerToken, totalWh). When either current
     * sample is unavailable, both are null — see class kdoc for why.
     */
    internal fun deriveEnergy(
        startUa: Long?,
        endUa: Long?,
        durationMs: Long,
        tokens: Int,
    ): Pair<Double?, Double?> {
        if (startUa == null || endUa == null || durationMs <= 0) return null to null
        // Android reports *discharge* current as a negative value on AOSP
        // and a positive value on Samsung. Take absolute magnitude so the
        // sign convention doesn't poison the average.
        val absStart = kotlin.math.abs(startUa)
        val absEnd = kotlin.math.abs(endUa)
        val avgUa = (absStart + absEnd) / 2.0
        val avgW = (avgUa / 1_000_000.0) * NOMINAL_VOLTAGE_V
        val totalWh = avgW * (durationMs / 1000.0) / 3600.0
        val whPerToken = if (tokens > 0) totalWh / tokens else null
        return whPerToken to totalWh
    }

    private fun readSystemState(): SystemState = sampler.sample()

    /**
     * State captured at one instant in time. Public so tests can construct
     * fakes that don't need a [Context]. See [AndroidSystemSampler] for the
     * production implementation.
     */
    data class SystemState(
        val batteryPct: Int,
        val charging: Boolean,
        val thermal: String,
        val currentUa: Long?,
    )

    /** Abstraction over the platform telemetry, so unit tests don't need a [Context]. */
    interface SystemSampler {
        fun sample(): SystemState
    }
}

/** Production [BatteryEnergyProfiler.SystemSampler] that pulls from Android system services. */
class AndroidSystemSampler(private val context: Context) : BatteryEnergyProfiler.SystemSampler {
    override fun sample(): BatteryEnergyProfiler.SystemState {
        val batteryStatus = try {
            context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        } catch (_: Throwable) {
            null
        }
        val level = batteryStatus?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = batteryStatus?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val pct = if (level >= 0 && scale > 0) (level * 100 / scale) else -1
        val statusCode = batteryStatus?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val charging = statusCode == BatteryManager.BATTERY_STATUS_CHARGING ||
            statusCode == BatteryManager.BATTERY_STATUS_FULL

        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val thermal = if (pm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ThermalState.fromInt(pm.currentThermalStatus).label
        } else {
            "NONE"
        }

        val bm = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        val raw: Long? = bm?.getLongProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW)
        val currentUa: Long? = when {
            raw == null -> null
            raw == Long.MIN_VALUE -> null
            raw == Integer.MIN_VALUE.toLong() -> null
            raw == 0L -> null
            else -> raw
        }
        return BatteryEnergyProfiler.SystemState(pct, charging, thermal, currentUa)
    }
}

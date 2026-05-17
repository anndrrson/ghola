package xyz.ghola.app.service

import android.content.Context
import android.os.Build
import android.os.PowerManager
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.callbackFlow
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * Phase α — Thermal-state observability.
 *
 * Wraps [PowerManager.OnThermalStatusChangedListener] (API 29+) and exposes
 * the live thermal state as a Kotlin [Flow]. The mapping from the platform
 * `int` constant to the sealed [ThermalState] type is the same one used by
 * [BatteryEnergyProfiler] for per-inference snapshots, so the two stay in
 * lock-step.
 *
 * Lifecycle. Call [register] from a foreground component (Activity onStart,
 * Service onCreate, etc.) and [unregister] from the matching tear-down path.
 * The class is safe to register-then-unregister multiple times; the second
 * register is a no-op.
 *
 * Pre-API-29 behaviour. On older devices the platform doesn't expose thermal
 * status. We surface [ThermalState.None] as a constant so callers don't have
 * to special-case the SDK level — they just see a steady-state "fine" signal.
 */
class ThermalStateProvider internal constructor(
    private val powerManager: PowerManager?,
    private val executor: Executor,
    /** Visible-for-test override so unit tests can simulate pre-Q devices. */
    private val sdkInt: Int = Build.VERSION.SDK_INT,
) {

    /** Production constructor: pulls [PowerManager] off the supplied [Context]. */
    constructor(
        context: Context,
        executor: Executor = Executors.newSingleThreadExecutor(),
    ) : this(
        powerManager = context.applicationContext
            .getSystemService(Context.POWER_SERVICE) as? PowerManager,
        executor = executor,
    )

    private val _state: MutableStateFlow<ThermalState> =
        MutableStateFlow(currentThermalStateInternal())

    /** Current thermal state as a hot [StateFlow]. Always emits at least once. */
    val state: StateFlow<ThermalState> get() = _state.asStateFlow()

    private var listener: PowerManager.OnThermalStatusChangedListener? = null

    /** Snapshot helper for one-off reads (e.g. [BatteryEnergyProfiler.begin]). */
    fun currentThermalState(): ThermalState = currentThermalStateInternal()

    /**
     * Subscribe to thermal-state transitions. Idempotent — calling twice
     * without an intervening [unregister] is a no-op.
     */
    fun register() {
        if (sdkInt < Build.VERSION_CODES.Q) return
        val pm = powerManager ?: return
        if (listener != null) return
        val l = PowerManager.OnThermalStatusChangedListener { status ->
            _state.value = ThermalState.fromInt(status)
        }
        pm.addThermalStatusListener(executor, l)
        listener = l
    }

    /** Idempotent: safe to call without a matching [register]. */
    fun unregister() {
        if (sdkInt < Build.VERSION_CODES.Q) return
        val pm = powerManager ?: return
        val l = listener ?: return
        pm.removeThermalStatusListener(l)
        listener = null
    }

    /** Visible-for-test: true after [register] succeeded, false after [unregister]. */
    internal fun isRegistered(): Boolean = listener != null

    /**
     * Cold flow flavour for callers that prefer scoping the listener to a
     * coroutine collector rather than the host component's lifecycle.
     * The underlying listener is registered on collect and torn down on
     * cancellation.
     */
    fun asFlow(): Flow<ThermalState> = callbackFlow {
        trySend(currentThermalStateInternal())
        if (sdkInt < Build.VERSION_CODES.Q) {
            awaitClose { /* nothing to clean up */ }
            return@callbackFlow
        }
        val pm = powerManager
        if (pm == null) {
            awaitClose { }
            return@callbackFlow
        }
        val l = PowerManager.OnThermalStatusChangedListener { status ->
            trySend(ThermalState.fromInt(status))
        }
        pm.addThermalStatusListener(executor, l)
        awaitClose { pm.removeThermalStatusListener(l) }
    }

    private fun currentThermalStateInternal(): ThermalState {
        if (sdkInt < Build.VERSION_CODES.Q) return ThermalState.None
        val pm = powerManager ?: return ThermalState.None
        return ThermalState.fromInt(pm.currentThermalStatus)
    }
}

/**
 * Sealed-class mirror of [PowerManager.THERMAL_STATUS_*]. Using a sealed type
 * forces callers to handle every state in `when` expressions, which is the
 * defining property the backend selector (Phase δ) will rely on.
 */
sealed class ThermalState(val rawValue: Int, val label: String) {
    object None : ThermalState(0, "NONE")
    object Light : ThermalState(1, "LIGHT")
    object Moderate : ThermalState(2, "MODERATE")
    object Severe : ThermalState(3, "SEVERE")
    object Critical : ThermalState(4, "CRITICAL")
    object Emergency : ThermalState(5, "EMERGENCY")
    object Shutdown : ThermalState(6, "SHUTDOWN")

    override fun toString(): String = label

    companion object {
        fun fromInt(value: Int): ThermalState = when (value) {
            0 -> None
            1 -> Light
            2 -> Moderate
            3 -> Severe
            4 -> Critical
            5 -> Emergency
            6 -> Shutdown
            else -> None
        }
    }
}

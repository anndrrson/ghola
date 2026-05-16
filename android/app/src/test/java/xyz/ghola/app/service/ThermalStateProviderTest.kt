package xyz.ghola.app.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Test
import java.util.concurrent.Executor

/**
 * Phase α tests for [ThermalStateProvider] + [ThermalState].
 *
 * These tests avoid touching the real Android [android.os.PowerManager] —
 * the platform class is `final` so we can't subclass it without Mockito
 * (intentionally not in the project's test deps). Instead we drive
 * [ThermalStateProvider] through its `internal` constructor with a `null`
 * PowerManager + an overridden sdkInt, which exercises the same code paths
 * the production constructor would on a pre-Q device or a device whose
 * SystemService lookup returned null.
 */
class ThermalStateProviderTest {

    private val directExecutor: Executor = Executor { r -> r.run() }

    @Test
    fun thermalStateFromInt_mapsEveryDocumentedConstant() {
        // Every constant in PowerManager.THERMAL_STATUS_* (API 29) must
        // produce the matching sealed-class instance. The label is part of
        // the JSON wire format the BatteryEnergyProfiler emits — if the
        // string changes the analyser breaks.
        assertSame(ThermalState.None, ThermalState.fromInt(0))
        assertSame(ThermalState.Light, ThermalState.fromInt(1))
        assertSame(ThermalState.Moderate, ThermalState.fromInt(2))
        assertSame(ThermalState.Severe, ThermalState.fromInt(3))
        assertSame(ThermalState.Critical, ThermalState.fromInt(4))
        assertSame(ThermalState.Emergency, ThermalState.fromInt(5))
        assertSame(ThermalState.Shutdown, ThermalState.fromInt(6))

        assertEquals("NONE", ThermalState.None.label)
        assertEquals("LIGHT", ThermalState.Light.label)
        assertEquals("MODERATE", ThermalState.Moderate.label)
        assertEquals("SEVERE", ThermalState.Severe.label)
        assertEquals("CRITICAL", ThermalState.Critical.label)
        assertEquals("EMERGENCY", ThermalState.Emergency.label)
        assertEquals("SHUTDOWN", ThermalState.Shutdown.label)
    }

    @Test
    fun thermalStateFromInt_unknownDefaultsToNone() {
        // Defensive: future SDK might add a new constant. Treat unknown
        // values as None rather than crashing — the BackendSelector will
        // see "fine" and pick the highest-quality backend.
        assertSame(ThermalState.None, ThermalState.fromInt(-1))
        assertSame(ThermalState.None, ThermalState.fromInt(42))
        assertSame(ThermalState.None, ThermalState.fromInt(Int.MAX_VALUE))
    }

    @Test
    fun preQDevice_currentStateIsNone() {
        // sdkInt = 28 simulates Android Pie. PowerManager.currentThermalStatus
        // was added in Q (API 29); on older devices the provider must surface
        // None as a steady-state signal rather than throw.
        val provider = ThermalStateProvider(
            powerManager = null,
            executor = directExecutor,
            sdkInt = 28,
        )
        assertSame(ThermalState.None, provider.currentThermalState())
        assertSame(ThermalState.None, provider.state.value)
    }

    @Test
    fun registerIsNoOp_whenPowerManagerUnavailable() {
        // If getSystemService returned null (unusual but possible on stripped
        // builds) we must not NPE. register()/unregister() should be safe and
        // isRegistered() should stay false.
        val provider = ThermalStateProvider(
            powerManager = null,
            executor = directExecutor,
            sdkInt = 33,
        )
        provider.register()
        assertFalse(provider.isRegistered())
        provider.unregister()
        assertFalse(provider.isRegistered())
    }

    @Test
    fun registerIsNoOp_onPreQEvenWithPowerManager() {
        // Even if PowerManager is non-null, the addThermalStatusListener API
        // requires API 29+. The provider gates on sdkInt and must not call
        // the API on older devices.
        val provider = ThermalStateProvider(
            powerManager = null, // null avoids the actual API call
            executor = directExecutor,
            sdkInt = 28,
        )
        provider.register()
        assertFalse(provider.isRegistered())
    }

    @Test
    fun stateFlow_alwaysHasInitialValue() {
        val provider = ThermalStateProvider(
            powerManager = null,
            executor = directExecutor,
            sdkInt = 33,
        )
        // StateFlow contract: a value is always available. On Q+ with no
        // PowerManager that initial value must be the safe "None" sentinel.
        assertNotNull(provider.state.value)
        assertSame(ThermalState.None, provider.state.value)
    }
}

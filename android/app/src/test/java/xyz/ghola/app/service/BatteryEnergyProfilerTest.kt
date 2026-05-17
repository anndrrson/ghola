package xyz.ghola.app.service

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicLong

/**
 * Phase α tests for [BatteryEnergyProfiler].
 *
 * Drives the profiler with a [FakeSampler] so we can simulate arbitrary
 * battery / thermal / current-draw trajectories without an Android device.
 * All time is driven by the injected `clock` + `monotonicClock` lambdas so
 * the wall-clock assertions are deterministic.
 */
class BatteryEnergyProfilerTest {

    /**
     * Test-only sampler. The first `sample()` call returns the first item;
     * subsequent calls advance through the supplied list and stick on the
     * last element once exhausted. This matches the natural "start then end"
     * call ordering inside the profiler.
     */
    private class FakeSampler(
        private val states: MutableList<BatteryEnergyProfiler.SystemState>
    ) : BatteryEnergyProfiler.SystemSampler {
        constructor(vararg states: BatteryEnergyProfiler.SystemState) :
            this(states.toMutableList())

        override fun sample(): BatteryEnergyProfiler.SystemState {
            val s = states.first()
            if (states.size > 1) states.removeAt(0)
            return s
        }
    }

    private fun state(
        pct: Int = 80,
        charging: Boolean = false,
        thermal: String = "NONE",
        currentUa: Long? = -300_000L,
    ) = BatteryEnergyProfiler.SystemState(pct, charging, thermal, currentUa)

    private fun fixedClocks(): Pair<AtomicLong, AtomicLong> =
        AtomicLong(1_700_000_000_000L) to AtomicLong(0L)

    @Test
    fun beginEnd_recordsHappyPathSnapshot() = runBlocking {
        val (wall, mono) = fixedClocks()
        val sampler = FakeSampler(
            state(pct = 80, thermal = "NONE", currentUa = -300_000L),
            state(pct = 79, thermal = "LIGHT", currentUa = -400_000L),
        )
        val profiler = BatteryEnergyProfiler(
            sampler = sampler,
            clock = { wall.get() },
            monotonicClock = { mono.get() },
        )

        val id = profiler.begin("CloudLlmBackend", "claude-sonnet-4.7")
        // Simulate 2.5 seconds of wall-clock elapsing before end().
        wall.addAndGet(2_500L)
        mono.addAndGet(2_500L * 1_000_000L)
        val snap = profiler.end(id, tokensGenerated = 50)

        assertNotNull(snap)
        snap!!
        assertEquals("CloudLlmBackend", snap.backendName)
        assertEquals("claude-sonnet-4.7", snap.modelName)
        assertEquals(2_500L, snap.durationMs)
        assertEquals(80, snap.startBatteryPct)
        assertEquals(79, snap.endBatteryPct)
        assertEquals("NONE", snap.startThermal)
        assertEquals("LIGHT", snap.endThermal)
        assertEquals(50, snap.tokensGenerated)
        assertFalse(snap.cancelled)
        assertNotNull(snap.whPerToken)
        assertNotNull(snap.totalWh)
        assertEquals(1, profiler.size())
    }

    @Test
    fun cancel_recordsSnapshotWithNullEnergyMetrics() = runBlocking {
        val (wall, mono) = fixedClocks()
        val sampler = FakeSampler(
            state(pct = 60, currentUa = -200_000L),
            state(pct = 60, thermal = "SEVERE", currentUa = -500_000L),
        )
        val profiler = BatteryEnergyProfiler(
            sampler = sampler,
            clock = { wall.get() },
            monotonicClock = { mono.get() },
        )

        val id = profiler.begin("LocalLlamaBackend")
        wall.addAndGet(800L)
        mono.addAndGet(800L * 1_000_000L)
        val snap = profiler.cancel(id)

        assertNotNull(snap)
        snap!!
        assertTrue(snap.cancelled)
        assertEquals(0, snap.tokensGenerated)
        assertNull(snap.whPerToken)
        assertNull(snap.totalWh)
        assertEquals("SEVERE", snap.endThermal)
        // Cancelled snapshots still live in the ring buffer so we can
        // analyse abort patterns under thermal pressure.
        assertEquals(1, profiler.size())
    }

    @Test
    fun unknownSessionId_returnsNull_doesNotThrow() = runBlocking {
        val profiler = BatteryEnergyProfiler(
            sampler = FakeSampler(state()),
        )
        assertNull(profiler.end("not-a-real-session", tokensGenerated = 10))
        assertNull(profiler.cancel("still-not-real"))
        assertEquals(0, profiler.size())
    }

    @Test
    fun deriveEnergy_trapezoidalAverage_isCorrect() {
        val profiler = BatteryEnergyProfiler(sampler = FakeSampler(state()))
        // Inputs:
        //   start = -200,000 µA (200 mA)
        //   end   = -400,000 µA (400 mA)
        //   avg   = 300,000 µA = 0.3 A
        //   avgW  = 0.3 A × 3.85 V = 1.155 W
        //   duration = 10,000 ms = 10 s
        //   totalWh = 1.155 W × 10 s / 3600 = 0.003208333... Wh
        //   wh_per_token (5 tokens) = 0.000641666... Wh
        val (whPerTok, totalWh) = profiler.deriveEnergy(
            startUa = -200_000L,
            endUa = -400_000L,
            durationMs = 10_000L,
            tokens = 5,
        )
        assertNotNull(whPerTok)
        assertNotNull(totalWh)
        val expectedTotal = (0.300 * BatteryEnergyProfiler.NOMINAL_VOLTAGE_V) * 10.0 / 3600.0
        assertEquals(expectedTotal, totalWh!!, 1e-9)
        assertEquals(expectedTotal / 5.0, whPerTok!!, 1e-9)
    }

    @Test
    fun deriveEnergy_missingCurrentSamples_returnsNullPair() {
        val profiler = BatteryEnergyProfiler(sampler = FakeSampler(state()))
        val (a, b) = profiler.deriveEnergy(startUa = null, endUa = -300L, durationMs = 1000, tokens = 10)
        assertNull(a); assertNull(b)
        val (c, d) = profiler.deriveEnergy(startUa = -300L, endUa = null, durationMs = 1000, tokens = 10)
        assertNull(c); assertNull(d)
        val (e, f) = profiler.deriveEnergy(startUa = -300L, endUa = -300L, durationMs = 0, tokens = 10)
        assertNull(e); assertNull(f)
    }

    @Test
    fun deriveEnergy_zeroTokens_yieldsNullPerTokenButKeepsTotal() {
        val profiler = BatteryEnergyProfiler(sampler = FakeSampler(state()))
        val (whPerTok, totalWh) = profiler.deriveEnergy(
            startUa = -300_000L,
            endUa = -300_000L,
            durationMs = 5_000L,
            tokens = 0,
        )
        assertNull(whPerTok)
        assertNotNull(totalWh)
        assertTrue("totalWh should be positive", totalWh!! > 0.0)
    }

    @Test
    fun ringBuffer_evictsOldestBeyondCapacity() = runBlocking {
        val (wall, mono) = fixedClocks()
        // Capacity 3 → after 5 inferences, snapshots 1 + 2 are evicted.
        val profiler = BatteryEnergyProfiler(
            sampler = FakeSampler(state(currentUa = -100_000L)),
            maxSnapshots = 3,
            clock = { wall.get() },
            monotonicClock = { mono.get() },
        )
        val ids = mutableListOf<String>()
        repeat(5) { i ->
            val id = profiler.begin("backend-$i")
            wall.addAndGet(100L)
            mono.addAndGet(100L * 1_000_000L)
            profiler.end(id, tokensGenerated = i + 1)
            ids.add(id)
        }
        assertEquals(3, profiler.size())
        val snaps = profiler.snapshots()
        // Oldest two evicted → first surviving snapshot should be backend-2.
        assertEquals("backend-2", snaps[0].backendName)
        assertEquals("backend-3", snaps[1].backendName)
        assertEquals("backend-4", snaps[2].backendName)
    }

    @Test
    fun exportJson_roundTripsAllFields() = runBlocking {
        val (wall, mono) = fixedClocks()
        val profiler = BatteryEnergyProfiler(
            sampler = FakeSampler(
                state(pct = 50, thermal = "NONE", currentUa = -100_000L),
                state(pct = 49, thermal = "LIGHT", currentUa = -200_000L),
            ),
            clock = { wall.get() },
            monotonicClock = { mono.get() },
        )
        val id = profiler.begin("EnvelopeCloudBackend", "claude-sonnet-4.7")
        wall.addAndGet(1_000L)
        mono.addAndGet(1_000L * 1_000_000L)
        profiler.end(id, tokensGenerated = 20)

        val json = profiler.exportJson()
        assertEquals(1, json.getInt("schema_version"))
        val arr = json.getJSONArray("snapshots")
        assertEquals(1, arr.length())
        val snap = arr.getJSONObject(0)
        assertEquals("EnvelopeCloudBackend", snap.getString("backend"))
        assertEquals("claude-sonnet-4.7", snap.getString("model"))
        assertEquals(20, snap.getInt("tokens_generated"))
        assertEquals("NONE", snap.getString("start_thermal"))
        assertEquals("LIGHT", snap.getString("end_thermal"))
        assertFalse(snap.getBoolean("cancelled"))
    }

    @Test
    fun multipleConcurrentSessions_areTrackedIndependently() = runBlocking {
        val (wall, mono) = fixedClocks()
        val profiler = BatteryEnergyProfiler(
            sampler = FakeSampler(state(currentUa = -100_000L)),
            clock = { wall.get() },
            monotonicClock = { mono.get() },
        )
        val a = profiler.begin("CloudLlmBackend")
        val b = profiler.begin("LocalLlamaBackend")
        wall.addAndGet(500L); mono.addAndGet(500L * 1_000_000L)
        val snapA = profiler.end(a, tokensGenerated = 10)
        val snapB = profiler.end(b, tokensGenerated = 20)
        assertNotNull(snapA); assertNotNull(snapB)
        assertEquals("CloudLlmBackend", snapA!!.backendName)
        assertEquals("LocalLlamaBackend", snapB!!.backendName)
        assertEquals(2, profiler.size())
    }
}

package xyz.ghola.app.integration

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import xyz.ghola.app.ai.ContentBlock
import xyz.ghola.app.ai.litert.LiteRTNeuroPilotBackend
import xyz.ghola.app.ai.litert.LiteRTRuntime
import xyz.ghola.app.ai.litert.LiteRtModelManager
import xyz.ghola.app.ai.litert.LiteRtNpuDispatcher
import xyz.ghola.app.ai.litert.LiteRtVariant
import xyz.ghola.app.ai.litert.SoCDetector
import xyz.ghola.app.service.BatteryEnergyProfiler
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * End-to-end integration test for the Phase γ LiteRT-LM NPU pipeline.
 *
 * Each prior commit in the multi-SoC NPU stack ships with focused
 * unit tests that exercise one moving piece in isolation
 * ([SoCDetector], [LiteRtVariant], [LiteRtModelManager],
 * [LiteRTNeuroPilotBackend], [LiteRtNpuDispatcher],
 * [xyz.ghola.app.ai.IntegrityVerifier],
 * [BatteryEnergyProfiler]). What none of those tests prove is that
 * the wiring between the pieces is correct: that a build-ID stream
 * picked up at boot routes through detection → variant selection →
 * download (with auth + integrity gate) → dispatch decision →
 * backend construction → profiled generation without a missing
 * adapter or a wrong assumption about who owns which side-effect.
 *
 * This test class is that missing seam. Each case drives the full
 * pipeline with **only the unavoidable boundaries mocked** — the
 * native LiteRT-LM engine, the gated HuggingFace HTTP endpoint, the
 * Android `Context` (we have no Robolectric on this `:test` source
 * set), and the platform battery sampler. Every Kotlin file under
 * `ai/litert/` is exercised by its real implementation.
 *
 * **Coverage matrix**
 *
 *   1. Seeker-like (`MT6878`) device — full pipeline picks Generic
 *      variant, downloads it from MockWebServer, lands on disk, the
 *      dispatcher returns [LiteRtNpuDispatcher.Decision.BuildBackend].
 *   2. Pixel 8 Pro-like (`Tensor G3`) device — Google Tensor falls
 *      through to Generic and proves the unknown-SoC failover.
 *   3. Dimensity 9300 (`MT6989`) device — first-class NPU variant
 *      gets its SoC-pinned filename in the request URL.
 *   4. Tampered download — pin lookup returns a wrong hash, the
 *      integrity verifier flags it, the dispatcher returns
 *      [LiteRtNpuDispatcher.Decision.FailWithTamperedError].
 *   5. 401 from gated HF repo — manager surfaces
 *      [LiteRtModelManager.ERR_GATED_REPO].
 *   6. HF bearer token plumbed through — request carries
 *      `Authorization: Bearer …`.
 *   7. Inference + profiling — backend wraps generate() inside a
 *      [BatteryEnergyProfiler] begin/end and the resulting snapshot
 *      captures the right tokens-generated + wall-clock fields.
 *
 * **Constraints kept**
 *
 *   - No real network. MockWebServer serves the bytes.
 *   - No real disk outside the JUnit [TemporaryFolder] rule.
 *   - No real `.litertlm` fixtures — every payload is ≤ ~1 MB so the
 *     full suite runs in well under 5 seconds on the CI laptop.
 *   - No production code paths are altered. The one extraction —
 *     [LiteRtModelManager]'s `pinResolverOverride` test seam — is
 *     documented inline and defaults to the real
 *     [xyz.ghola.app.ai.PinnedModelHashes.forVariant].
 *
 * If a future agent extends the pipeline (e.g. adds a Phase γ.5
 * mirror failover or a Phase η on-chain pin lookup), the matching
 * end-to-end case belongs here.
 */
class LiteRTNpuEndToEndTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    // ─────────────────────── helpers ───────────────────────

    /** Build a small deterministic fake `.litertlm` body (~64 KiB). */
    private fun fakeLitertlmBytes(seed: Int = 0): ByteArray =
        ByteArray(64 * 1024) { (((it + seed) * 31) and 0xFF).toByte() }

    private fun sha256Hex(bytes: ByteArray): String {
        val d = MessageDigest.getInstance("SHA-256").digest(bytes)
        return d.joinToString("") { "%02x".format(it) }
    }

    /**
     * Drive [SoCDetector] from a [SoCDetector.BuildIds] payload so we
     * can simulate any SoC on the JVM without Robolectric or
     * ReflectionHelpers — same seam the existing
     * [xyz.ghola.app.ai.litert.SoCDetectorTest] uses.
     */
    private fun detectFor(
        socManufacturer: String,
        socModel: String,
        hardware: String,
    ) = SoCDetector.detectFromBuildIds(
        SoCDetector.BuildIds(
            socModel = socModel,
            socManufacturer = socManufacturer,
            hardware = hardware,
        ),
    )

    /** Construct a manager wired to the temp folder + MockWebServer. */
    private fun newManager(
        variant: LiteRtVariant,
        urlPath: String = "/${variant.filename}",
        hfToken: String? = null,
        pinResolver: ((LiteRtVariant) -> String?)? = null,
    ): LiteRtModelManager = LiteRtModelManager(
        context = null,
        activeVariant = variant,
        modelsDirOverride = tempFolder.root,
        urlOverride = server.url(urlPath).toString(),
        hfTokenOverride = { hfToken },
        pinResolverOverride = pinResolver,
    )

    /** Listener that captures the terminal callback for assertions. */
    private class CapturingListener : LiteRtModelManager.DownloadListener {
        val latch = CountDownLatch(1)
        val terminal = AtomicReference<String>()
        val completePath = AtomicReference<String?>()
        val errorMsg = AtomicReference<String?>()
        var progressCount = 0
        override fun onProgress(downloaded: Long, total: Long, percent: Int) {
            progressCount++
        }
        override fun onComplete(path: String) {
            completePath.set(path)
            if (terminal.compareAndSet(null, "complete")) latch.countDown()
        }
        override fun onError(message: String) {
            errorMsg.set(message)
            if (terminal.compareAndSet(null, "error")) latch.countDown()
        }
    }

    /** Run the full detection → variant → download → dispatch chain. */
    private data class PipelineResult(
        val variant: LiteRtVariant,
        val listener: CapturingListener,
        val decision: LiteRtNpuDispatcher.Decision,
        val request: RecordedRequest?,
        val onDiskFile: File,
    )

    private fun runPipeline(
        buildIds: SoCDetector.BuildIds,
        responseBody: ByteArray,
        responseCode: Int = 200,
        hfToken: String? = null,
        pinResolver: ((LiteRtVariant) -> String?)? = null,
    ): PipelineResult {
        val identity = SoCDetector.detectFromBuildIds(buildIds)
        val variant = LiteRtVariant.forSoC(identity)

        server.enqueue(
            MockResponse()
                .setResponseCode(responseCode)
                .setBody(Buffer().apply { write(responseBody) }),
        )

        val mgr = newManager(
            variant = variant,
            urlPath = "/${variant.filename}",
            hfToken = hfToken,
            pinResolver = pinResolver,
        )
        val listener = CapturingListener()
        mgr.downloadModelBlocking(listener)

        val req = server.takeRequest(2, TimeUnit.SECONDS)

        // Resolve dispatcher decision off the live (status, path) pair.
        val decision = runBlocking {
            val status = mgr.isModelVerified()
            val path = mgr.getModelPath()
            LiteRtNpuDispatcher.decide(status, path)
        }

        return PipelineResult(
            variant = variant,
            listener = listener,
            decision = decision,
            request = req,
            onDiskFile = File(tempFolder.root, variant.filename),
        )
    }

    // ─────────────────────── test 1: Seeker-like ───────────────────────

    @Test
    fun fullFlow_seekerLikeDevice_downloadsGenericVariant() {
        val payload = fakeLitertlmBytes()
        val pipeline = runPipeline(
            buildIds = SoCDetector.BuildIds(
                socModel = "MT6878",
                socManufacturer = "Mediatek",
                hardware = "mt6878",
            ),
            responseBody = payload,
        )

        // Seeker's MT6878 has no NPU bundle published → falls back to Generic.
        assertEquals(LiteRtVariant.Generic, pipeline.variant)

        // Download landed on disk with the SoC-tuned filename.
        assertEquals("complete", pipeline.listener.terminal.get())
        assertTrue("on-disk file must exist", pipeline.onDiskFile.exists())
        assertEquals(payload.size.toLong(), pipeline.onDiskFile.length())
        assertEquals(
            "filename on disk must match variant filename — guards against silent mismatch",
            LiteRtVariant.Generic.filename,
            pipeline.onDiskFile.name,
        )

        // Request URL targets the variant's filename.
        val req = pipeline.request ?: error("MockWebServer received no request")
        assertTrue(
            "request path must reference the variant filename",
            req.path!!.contains(LiteRtVariant.Generic.filename),
        )

        // No HF token configured → no Authorization header.
        assertNull(req.getHeader("Authorization"))

        // Dispatcher decision: pin is null today (pass-through) → BuildBackend.
        val build = pipeline.decision as LiteRtNpuDispatcher.Decision.BuildBackend
        assertEquals(pipeline.onDiskFile.absolutePath, build.modelPath)
    }

    // ────────────── test 2: Pixel 8 Pro-like (Tensor G3) ──────────────

    @Test
    fun fullFlow_pixel8ProLikeDevice_downloadsGenericVariant() {
        val payload = fakeLitertlmBytes(seed = 1)
        val pipeline = runPipeline(
            buildIds = SoCDetector.BuildIds(
                socModel = "Tensor G3",
                socManufacturer = "Google",
                hardware = "zuma",
            ),
            responseBody = payload,
        )

        // Google Tensor → Generic fallback (no Gemma NPU bundle for Tensor).
        assertEquals(LiteRtVariant.Generic, pipeline.variant)
        assertEquals("complete", pipeline.listener.terminal.get())
        assertTrue(pipeline.onDiskFile.exists())
        assertEquals(payload.size.toLong(), pipeline.onDiskFile.length())
        assertTrue(pipeline.decision is LiteRtNpuDispatcher.Decision.BuildBackend)
    }

    // ────────────── test 3: D9300 / MT6989 picks NPU variant ──────────

    @Test
    fun fullFlow_d9300LikeDevice_picksMt6989Variant() {
        val payload = fakeLitertlmBytes(seed = 2)
        val pipeline = runPipeline(
            buildIds = SoCDetector.BuildIds(
                socModel = "MT6989",
                socManufacturer = "Mediatek",
                hardware = "mt6989",
            ),
            responseBody = payload,
        )

        // First-class NPU variant — not the Generic fallback.
        assertEquals(LiteRtVariant.Mt6989, pipeline.variant)

        // Request path must encode the MT6989-tuned filename, not Generic.
        val req = pipeline.request ?: error("MockWebServer received no request")
        assertTrue(
            "request path must reference the MT6989 variant filename, was: ${req.path}",
            req.path!!.contains(LiteRtVariant.Mt6989.filename),
        )
        assertFalse(
            "must NOT carry the Generic filename on a D9300 device",
            req.path!!.contains(LiteRtVariant.Generic.filename),
        )

        assertEquals("complete", pipeline.listener.terminal.get())
        assertEquals(LiteRtVariant.Mt6989.filename, pipeline.onDiskFile.name)
        val build = pipeline.decision as LiteRtNpuDispatcher.Decision.BuildBackend
        assertEquals(pipeline.onDiskFile.absolutePath, build.modelPath)
    }

    // ────────────── test 4: tampered download rejected ────────────────

    @Test
    fun fullFlow_tamperedDownload_rejectedByIntegrity() {
        val payload = fakeLitertlmBytes(seed = 3)
        // Pin resolver returns a deliberately wrong hash — the
        // integrity verifier must reject the on-disk bytes and the
        // manager must delete the artifact before reporting error.
        val wrongPin = "deadbeef".repeat(8) // 64 hex chars, definitely not the real digest
        val pipeline = runPipeline(
            buildIds = SoCDetector.BuildIds(
                socModel = "MT6989",
                socManufacturer = "Mediatek",
                hardware = "mt6989",
            ),
            responseBody = payload,
            pinResolver = { wrongPin },
        )

        // Manager surfaces the stable tamper error string.
        assertEquals("error", pipeline.listener.terminal.get())
        assertNotNull(pipeline.listener.errorMsg.get())
        assertTrue(
            "tamper error must mention integrity, was: ${pipeline.listener.errorMsg.get()}",
            pipeline.listener.errorMsg.get()!!.contains("integrity", ignoreCase = true),
        )

        // The poisoned artifact must be deleted so a resume doesn't
        // build on top of it.
        assertFalse(
            "poisoned artifact must be deleted after tamper detection",
            pipeline.onDiskFile.exists(),
        )

        // Dispatcher decision: no file → FallbackMissingModel (the
        // post-tamper steady state for a Settings re-entry). This
        // proves that BuildBackend is impossible to reach after a
        // tamper, which is the security-critical invariant.
        assertEquals(
            LiteRtNpuDispatcher.Decision.FallbackMissingModel,
            pipeline.decision,
        )

        // Sanity: also exercise the TAMPERED → FailWithTamperedError
        // edge directly by staging a verified-but-mismatched fixture
        // and querying the dispatcher. This is the path a user hits
        // when a previously-good artifact's pin rotates underneath
        // them — the manager's runtime check would catch this on the
        // next isModelVerified() call.
        val staged = File(tempFolder.root, LiteRtVariant.Mt6989.filename)
        staged.writeBytes(payload) // matches the seed-3 payload we just served
        val mgr2 = newManager(
            variant = LiteRtVariant.Mt6989,
            pinResolver = { wrongPin },
        )
        val tamperDecision = runBlocking {
            LiteRtNpuDispatcher.decide(mgr2.isModelVerified(), mgr2.getModelPath())
        }
        assertEquals(
            LiteRtNpuDispatcher.Decision.FailWithTamperedError,
            tamperDecision,
        )
    }

    // ────────────── test 5: 401 → gated-repo error ────────────────────

    @Test
    fun fullFlow_401FromHFRepo_surfacesGatedRepoError() {
        val pipeline = runPipeline(
            buildIds = SoCDetector.BuildIds(
                socModel = "MT6878",
                socManufacturer = "Mediatek",
                hardware = "mt6878",
            ),
            responseBody = "gated".toByteArray(),
            responseCode = 401,
        )

        assertEquals("error", pipeline.listener.terminal.get())
        assertEquals(
            LiteRtModelManager.ERR_GATED_REPO,
            pipeline.listener.errorMsg.get(),
        )
        // No file written on a 401 short-circuit.
        assertFalse(pipeline.onDiskFile.exists())
        // Dispatcher steady state with no file: FallbackMissingModel.
        assertEquals(
            LiteRtNpuDispatcher.Decision.FallbackMissingModel,
            pipeline.decision,
        )
    }

    // ────────────── test 6: HF token attached to request ──────────────

    @Test
    fun fullFlow_hfBearerToken_attachedToRequest() {
        val payload = fakeLitertlmBytes(seed = 4)
        val pipeline = runPipeline(
            buildIds = SoCDetector.BuildIds(
                socModel = "SM8650",
                socManufacturer = "QTI",
                hardware = "qcom",
            ),
            responseBody = payload,
            hfToken = "hf_e2e_integration_token_xyz",
        )

        assertEquals(LiteRtVariant.Sm8650, pipeline.variant)
        assertEquals("complete", pipeline.listener.terminal.get())
        val req = pipeline.request ?: error("MockWebServer received no request")
        assertEquals(
            "Bearer hf_e2e_integration_token_xyz",
            req.getHeader("Authorization"),
        )
        assertTrue(req.path!!.contains(LiteRtVariant.Sm8650.filename))
    }

    // ────────────── test 7: inference + profiler snapshot ─────────────

    /** Deterministic [BatteryEnergyProfiler.SystemSampler] for the JVM. */
    private class FakeSampler(
        private vararg val states: BatteryEnergyProfiler.SystemState,
    ) : BatteryEnergyProfiler.SystemSampler {
        private var idx = 0
        override fun sample(): BatteryEnergyProfiler.SystemState {
            val s = states[idx]
            if (idx < states.size - 1) idx++
            return s
        }
    }

    private fun userMessage(text: String): JSONArray = JSONArray().apply {
        put(JSONObject().apply {
            put("role", "user")
            put("content", text)
        })
    }

    @Test
    fun fullFlow_inferencePathWithMockedRuntime_profilerCapturesSnapshot() = runBlocking {
        // 1) Stage a downloaded artifact via the full pipeline, then
        //    feed its on-disk path into the backend — proves the
        //    handoff between model manager and backend is wired
        //    correctly (it's a string path, but the contract is
        //    "absolute path of a real file the runtime can open").
        val payload = fakeLitertlmBytes(seed = 5)
        val pipeline = runPipeline(
            buildIds = SoCDetector.BuildIds(
                socModel = "MT6989",
                socManufacturer = "Mediatek",
                hardware = "mt6989",
            ),
            responseBody = payload,
        )
        assertEquals("complete", pipeline.listener.terminal.get())
        val build = pipeline.decision as LiteRtNpuDispatcher.Decision.BuildBackend
        val modelPath = build.modelPath

        // 2) Mock the LiteRT-LM native runtime: returns a fixed string.
        //    The backend's prompt-formatting + control-token-strip
        //    logic runs unmocked.
        val fakeRuntime = object : LiteRTRuntime {
            var generateCalls = 0
            var lastPrompt: String? = null
            override fun generate(prompt: String): String {
                generateCalls++
                lastPrompt = prompt
                return "Hello from the NPU."
            }
            override fun cancel() {}
            override fun shutdown() {}
        }

        // 3) Construct the backend against the real downloaded file
        //    (proves the IntegrityVerifier init-time check passes on a
        //    null pin, matching today's production posture) and the
        //    pin matches our `Mt6989` payload bytes — null pin means
        //    pass-through.
        val backend = LiteRTNeuroPilotBackend(
            modelFile = File(modelPath),
            runtimeFactory = { fakeRuntime },
            integrityHash = null,
        )

        // 4) Wrap the generate() in a deterministic profiler. Two
        //    samples: start at 80% / -200_000µA, end at 79% / -250_000µA.
        val wall = AtomicLong(1_700_000_000_000L)
        val mono = AtomicLong(0L)
        val profiler = BatteryEnergyProfiler(
            sampler = FakeSampler(
                BatteryEnergyProfiler.SystemState(80, false, "NONE", -200_000L),
                BatteryEnergyProfiler.SystemState(79, false, "LIGHT", -250_000L),
            ),
            clock = { wall.get() },
            monotonicClock = { mono.get() },
        )

        val sessionId = profiler.begin(
            backendName = backend.displayName,
            modelName = "Gemma3-1B-IT_q4_ekv1280_mt6989.litertlm",
        )

        // Advance time so the snapshot's durationMs is well-defined.
        wall.addAndGet(750L)
        mono.addAndGet(750L * 1_000_000L)

        val response = backend.generate(
            messages = userMessage("Say hi."),
            tools = JSONArray(),
            system = "You are concise.",
            forceToolUse = false,
        )

        // Caller usually pulls outputTokens off ApiResponse.usage, but
        // the LiteRT backend returns `usage = null`. Pass an estimate
        // derived from the response text — this mirrors what
        // `LocalChatBackend` callers do.
        val estimatedTokens = response.contentBlocks
            .filterIsInstance<ContentBlock.Text>()
            .sumOf { it.text.length } / 4
        val snapshot = profiler.end(sessionId, tokensGenerated = estimatedTokens)

        // Generation hit the runtime exactly once and produced the
        // expected text block.
        assertEquals(1, fakeRuntime.generateCalls)
        assertEquals(1, response.contentBlocks.size)
        assertEquals(
            "Hello from the NPU.",
            (response.contentBlocks[0] as ContentBlock.Text).text,
        )
        assertEquals("end_turn", response.stopReason)
        // The prompt the runtime saw must include the user text +
        // system prompt + ChatML scaffolding.
        assertTrue(fakeRuntime.lastPrompt!!.contains("Say hi."))
        assertTrue(fakeRuntime.lastPrompt!!.contains("You are concise."))
        assertTrue(fakeRuntime.lastPrompt!!.endsWith("<|im_start|>assistant\n"))

        // Snapshot exists with the right wiring.
        assertNotNull("profiler must record a snapshot", snapshot)
        snapshot!!
        assertEquals(backend.displayName, snapshot.backendName)
        assertEquals(
            "Gemma3-1B-IT_q4_ekv1280_mt6989.litertlm",
            snapshot.modelName,
        )
        assertEquals(750L, snapshot.durationMs)
        assertEquals(80, snapshot.startBatteryPct)
        assertEquals(79, snapshot.endBatteryPct)
        assertEquals(estimatedTokens, snapshot.tokensGenerated)
        assertFalse(snapshot.cancelled)
        // Derived energy fields are non-null because both current
        // samples were populated.
        assertNotNull(snapshot.totalWh)
        if (estimatedTokens > 0) assertNotNull(snapshot.whPerToken)

        backend.shutdown()
    }

    // ────────────── extra: detectFor smoke (composition sanity) ───────

    @Test
    fun socDetector_drivesVariantSelection_smoke() {
        // Composition sanity for the helper used above — keeps this
        // file's expectations honest if the detector's table moves.
        assertEquals(
            LiteRtVariant.Generic,
            LiteRtVariant.forSoC(
                detectFor("Mediatek", "MT6878", "mt6878"),
            ),
        )
        assertEquals(
            LiteRtVariant.Mt6989,
            LiteRtVariant.forSoC(
                detectFor("Mediatek", "MT6989", "mt6989"),
            ),
        )
        assertEquals(
            LiteRtVariant.Sm8650,
            LiteRtVariant.forSoC(
                detectFor("QTI", "SM8650", "qcom"),
            ),
        )
        assertEquals(
            LiteRtVariant.Generic,
            LiteRtVariant.forSoC(
                detectFor("Google", "Tensor G3", "zuma"),
            ),
        )
        // Sanity: the deterministic payload hashing helper agrees
        // with what IntegrityVerifier.verifyBytes would compute.
        val bytes = fakeLitertlmBytes(seed = 7)
        val viaHelper = sha256Hex(bytes)
        val viaVerifier = xyz.ghola.app.ai.IntegrityVerifier
            .verifyBytes(bytes, null).recorded.sha256Hex
        assertEquals(viaHelper, viaVerifier)
    }
}

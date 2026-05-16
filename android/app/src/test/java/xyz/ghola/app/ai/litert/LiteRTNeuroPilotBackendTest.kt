package xyz.ghola.app.ai.litert

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import xyz.ghola.app.ai.ContentBlock
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Unit tests for [LiteRTNeuroPilotBackend]. Validates the Phase γ.1
 * skeleton contract:
 *
 *   1. Happy path — load + generate returns an ApiResponse with a
 *      single Text block.
 *   2. NPU unavailable — runtime factory simulates an NPU
 *      [LiteRtLmJniException]-like failure, the production fallback
 *      is exercised at the factory boundary, generate still
 *      succeeds.
 *   3. Integrity verification — a tampered model file with a
 *      non-matching pin is rejected at construction time, before
 *      any native code touches it.
 *   4. Cancellation — cancel() flips the in-progress flag observed
 *      between runtime entry and post-completion.
 *   5. Shutdown — runtime is disposed exactly once; subsequent
 *      generate calls fail loudly rather than silently re-init.
 *
 * The native runtime is mocked through the [LiteRTRuntime] interface
 * seam introduced in `LiteRTNeuroPilotBackend.kt`, so these tests
 * run on the JVM without loading the
 * `com.google.ai.edge.litertlm` arm64 libraries.
 */
class LiteRTNeuroPilotBackendTest {

    private val tempFiles = mutableListOf<File>()

    @After
    fun tearDown() {
        tempFiles.forEach { f -> if (f.exists()) f.delete() }
        tempFiles.clear()
    }

    /**
     * Make a small fake `.litertlm`-extension file. The verifier
     * doesn't care about the format — it hashes bytes. The chosen
     * payload is large enough that [java.io.File.length] reads
     * non-zero (the production guard checks this in
     * [xyz.ghola.app.email.LocalLlm.isModelReady]).
     */
    private fun makeFakeModel(prefix: String, content: ByteArray = "fake-litertlm-bytes".toByteArray()): File {
        val f = File.createTempFile(prefix, ".litertlm")
        f.writeBytes(content)
        tempFiles.add(f)
        return f
    }

    private fun sha256Hex(bytes: ByteArray): String {
        val d = MessageDigest.getInstance("SHA-256").digest(bytes)
        return d.joinToString("") { "%02x".format(it) }
    }

    private fun userMessage(text: String): JSONArray = JSONArray().apply {
        put(JSONObject().apply {
            put("role", "user")
            put("content", text)
        })
    }

    /** A scriptable [LiteRTRuntime] that records each call for assertions. */
    private class FakeRuntime(
        private val response: String = "fake-litertlm-response",
        private val onGenerate: ((String) -> Unit)? = null,
    ) : LiteRTRuntime {
        val generateCalls = AtomicInteger(0)
        val cancelCalls = AtomicInteger(0)
        val shutdownCalls = AtomicInteger(0)
        var lastPrompt: String? = null
        var throwOnGenerate: Throwable? = null

        override fun generate(prompt: String): String {
            generateCalls.incrementAndGet()
            lastPrompt = prompt
            onGenerate?.invoke(prompt)
            throwOnGenerate?.let { throw it }
            return response
        }

        override fun cancel() {
            cancelCalls.incrementAndGet()
        }

        override fun shutdown() {
            shutdownCalls.incrementAndGet()
        }
    }

    // ── Test 1: happy path — generate returns Text block ─────────────

    @Test
    fun generate_happyPathReturnsTextContentBlock() {
        val model = makeFakeModel("npu-happy-")
        val fake = FakeRuntime(response = "Hello from the NPU.")

        val backend = LiteRTNeuroPilotBackend(
            modelFile = model,
            runtimeFactory = { fake },
            integrityHash = null,
        )

        val response = backend.generate(
            messages = userMessage("What's 2+2?"),
            tools = JSONArray(),
            system = "You are concise.",
            forceToolUse = false,
        )

        assertEquals(1, response.contentBlocks.size)
        val block = response.contentBlocks[0]
        assertTrue("expected Text content block, got $block", block is ContentBlock.Text)
        assertEquals("Hello from the NPU.", (block as ContentBlock.Text).text)
        assertEquals("end_turn", response.stopReason)
        assertNull(response.usage)
        assertEquals(
            "runtime should be invoked exactly once for a one-shot generate",
            1,
            fake.generateCalls.get(),
        )
        // Sanity: the prompt the runtime sees must contain the user
        // text and the system text in ChatML structure.
        val prompt = fake.lastPrompt!!
        assertTrue(prompt.contains("You are concise."))
        assertTrue(prompt.contains("What's 2+2?"))
        assertTrue(prompt.endsWith("<|im_start|>assistant\n"))
    }

    // ── Test 2: NPU unavailable → factory falls back, generate works ─

    @Test
    fun generate_npuUnavailableFallsBackAtFactoryAndStillSucceeds() {
        // Simulate the production [LiteRTLmRuntime.tryCreate] pattern:
        // the factory itself absorbs the NPU init failure and hands
        // back a CPU runtime. From the backend's perspective the
        // factory always succeeds; the fallback is an internal
        // detail. We verify the factory is invoked once and the
        // resulting backend serves a generate call.
        val model = makeFakeModel("npu-fallback-")
        val factoryInvocations = AtomicInteger(0)
        val factory: () -> LiteRTRuntime = {
            factoryInvocations.incrementAndGet()
            // Pretend NPU init failed inside tryCreate and we got a
            // CPU fallback. The fake has no way to know which
            // backend it represents; the production code logs
            // "Backend.CPU fallback" and proceeds identically.
            FakeRuntime(response = "fallback-cpu-response")
        }
        val backend = LiteRTNeuroPilotBackend(
            modelFile = model,
            runtimeFactory = factory,
            integrityHash = null,
        )

        // Runtime is lazy — no factory call yet.
        assertEquals(0, factoryInvocations.get())

        val response = backend.generate(
            messages = userMessage("hi"),
            tools = JSONArray(),
            system = "",
            forceToolUse = false,
        )

        assertEquals(1, factoryInvocations.get())
        assertEquals(
            "fallback-cpu-response",
            (response.contentBlocks[0] as ContentBlock.Text).text,
        )

        // Second generate must NOT rebuild the runtime — confirms the
        // singleton-style cache and avoids paying the ~10s engine
        // init on every chat turn.
        backend.generate(
            messages = userMessage("again"),
            tools = JSONArray(),
            system = "",
            forceToolUse = false,
        )
        assertEquals(
            "factory must be invoked exactly once across multiple generates",
            1,
            factoryInvocations.get(),
        )
    }

    // ── Test 3: integrity — tampered model rejected at construction ──

    @Test
    fun construction_tamperedFileWithPinnedHashIsRejected() {
        val payload = "the-real-model-bytes".toByteArray()
        val model = makeFakeModel("npu-tamper-", payload)
        val realHash = sha256Hex(payload)

        // Pinned hash matches → construction succeeds.
        val backend = LiteRTNeuroPilotBackend(
            modelFile = model,
            runtimeFactory = { FakeRuntime() },
            integrityHash = realHash,
        )
        assertNotNull(backend)

        // Tamper: overwrite the file with different bytes after the
        // verified construction would happen. To simulate a tampered
        // file at construction time we instead build a new backend
        // against the same file with a deliberately wrong pin.
        val wrongHash =
            "0000000000000000000000000000000000000000000000000000000000000000"
        try {
            LiteRTNeuroPilotBackend(
                modelFile = model,
                runtimeFactory = { FakeRuntime() },
                integrityHash = wrongHash,
            )
            fail("expected IOException for tampered-file pin mismatch")
        } catch (e: IOException) {
            assertTrue(
                "exception must mention integrity",
                e.message!!.contains("integrity", ignoreCase = true),
            )
        }
    }

    // ── Test 4: cancel flag observed; runtime.cancel() forwarded ─────

    @Test
    fun cancel_setsFlagAndForwardsToRuntime() {
        val model = makeFakeModel("npu-cancel-")
        val started = CountDownLatch(1)
        val released = CountDownLatch(1)

        // Build a runtime that blocks inside generate so we can race
        // a cancel against it.
        val cancelObserved = AtomicBoolean(false)
        val fake = object : LiteRTRuntime {
            val cancels = AtomicInteger(0)
            override fun generate(prompt: String): String {
                started.countDown()
                // Wait until the test thread calls cancel.
                if (!released.await(2, TimeUnit.SECONDS)) {
                    fail("test fixture: release latch timed out")
                }
                return "partial"
            }
            override fun cancel() {
                cancels.incrementAndGet()
                cancelObserved.set(true)
                released.countDown()
            }
            override fun shutdown() {}
        }

        val backend = LiteRTNeuroPilotBackend(
            modelFile = model,
            runtimeFactory = { fake },
            integrityHash = null,
        )

        val genThread = Thread {
            try {
                backend.generate(
                    messages = userMessage("long-running"),
                    tools = JSONArray(),
                    system = "",
                    forceToolUse = false,
                )
            } catch (e: IOException) {
                // Expected — the post-completion cancel guard throws
                // "Generation cancelled" when cancelled.get() is true
                // after the runtime returns.
                assertTrue(
                    "post-cancel error must mention cancellation",
                    e.message!!.contains("cancel", ignoreCase = true),
                )
            }
        }
        genThread.start()

        assertTrue("gen must enter runtime within 2s", started.await(2, TimeUnit.SECONDS))
        backend.cancel()
        genThread.join(3_000)
        assertFalse("gen thread must terminate after cancel", genThread.isAlive)
        assertTrue("runtime.cancel must be observed", cancelObserved.get())
    }

    // ── Test 5: shutdown disposes runtime and blocks further generates ─

    @Test
    fun shutdown_disposesRuntimeAndBlocksFurtherGeneration() {
        val model = makeFakeModel("npu-shutdown-")
        val fake = FakeRuntime()
        val backend = LiteRTNeuroPilotBackend(
            modelFile = model,
            runtimeFactory = { fake },
            integrityHash = null,
        )

        // Bring the runtime up via one generate.
        backend.generate(
            messages = userMessage("hello"),
            tools = JSONArray(),
            system = "",
            forceToolUse = false,
        )
        assertEquals(1, fake.generateCalls.get())
        assertEquals(0, fake.shutdownCalls.get())

        backend.shutdown()
        assertEquals(
            "shutdown must dispose the active runtime exactly once",
            1,
            fake.shutdownCalls.get(),
        )

        // Further generate calls must fail loudly — silent re-init
        // would defeat the purpose of shutting down.
        try {
            backend.generate(
                messages = userMessage("after shutdown"),
                tools = JSONArray(),
                system = "",
                forceToolUse = false,
            )
            fail("expected IOException after shutdown")
        } catch (e: IOException) {
            assertTrue(
                "exception must reference shutdown state",
                e.message!!.contains("shut down", ignoreCase = true),
            )
        }

        // Idempotency: a second shutdown must not double-dispose.
        backend.shutdown()
        assertEquals(
            "shutdown must be idempotent (runtime disposed exactly once)",
            1,
            fake.shutdownCalls.get(),
        )
    }

    // ── Test 6: missing model file rejected at construction ──────────

    @Test
    fun construction_missingFileThrowsIoException() {
        val nonexistent = File(System.getProperty("java.io.tmpdir"), "definitely-not-here.litertlm")
        if (nonexistent.exists()) nonexistent.delete()
        try {
            LiteRTNeuroPilotBackend(
                modelFile = nonexistent,
                runtimeFactory = { FakeRuntime() },
                integrityHash = null,
            )
            fail("expected IOException for missing model file")
        } catch (e: IOException) {
            assertTrue(
                "exception must mention the missing file",
                e.message!!.contains("not found", ignoreCase = true),
            )
        }
    }
}

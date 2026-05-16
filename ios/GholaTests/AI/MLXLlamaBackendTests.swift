import XCTest
@testable import Ghola

/// Tests for `MLXLlamaBackend` covering both the lightweight
/// constructor-time path validation (ζ-iOS.1 contract, kept) and the
/// real model-loading + generation path that ζ-iOS.2 wires up.
///
/// Tests that need a real Llama-3.2-1B-Instruct-4bit safetensors tree
/// look it up via `realModelPath()`. If the env var
/// `GHOLA_MLX_TEST_MODEL_PATH` is not set, those tests `XCTSkip` with
/// a clear pointer to the download instructions. We deliberately do
/// **not** download from HuggingFace at test time — that would (a) make
/// the test suite non-deterministic on CI, (b) take 5+ minutes, and
/// (c) require network even for the unit-test target.
///
/// To exercise the integration tests locally:
///   1. `huggingface-cli download mlx-community/Llama-3.2-1B-Instruct-4bit \
///         --local-dir /tmp/ghola-mlx-llama32-1b-4bit`
///   2. `GHOLA_MLX_TEST_MODEL_PATH=/tmp/ghola-mlx-llama32-1b-4bit \
///         xcodebuild test -scheme Ghola -destination 'platform=macOS'`
final class MLXLlamaBackendTests: XCTestCase {

    // MARK: - Constructor (ζ-iOS.1 contract, unchanged)

    func testInit_throwsWhenModelPathDoesNotExist() {
        let bogus = URL(fileURLWithPath: "/tmp/ghola-mlx-tests/does-not-exist-\(UUID().uuidString)")
        XCTAssertThrowsError(try MLXLlamaBackend(modelPath: bogus)) { error in
            guard let err = error as? MLXLlamaBackendError else {
                return XCTFail("Expected MLXLlamaBackendError, got \(error)")
            }
            XCTAssertEqual(err, .modelPathMissing(bogus))
        }
    }

    func testInit_throwsWhenModelPathIsAFile() throws {
        // A regular file (not a directory) should also fail the isDir guard.
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ghola-mlx-tests-\(UUID().uuidString).txt")
        try "not a model".write(to: tmp, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: tmp) }

        XCTAssertThrowsError(try MLXLlamaBackend(modelPath: tmp))
    }

    func testInit_succeedsWhenModelPathIsADirectory() throws {
        let dir = try makeTempModelDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let backend = try MLXLlamaBackend(modelPath: dir)
        XCTAssertEqual(backend.resolvedModelPath, dir)
    }

    // MARK: - Contract

    func testDisplayName_isLlama3_2_1BMLX() throws {
        let dir = try makeTempModelDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let backend = try MLXLlamaBackend(modelPath: dir)
        XCTAssertEqual(backend.displayName, "On-device (Llama 3.2 1B 4-bit · MLX)")
    }

    func testRequiresInternet_isFalse() throws {
        let dir = try makeTempModelDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let backend = try MLXLlamaBackend(modelPath: dir)
        XCTAssertFalse(backend.requiresInternet)
    }

    // MARK: - generate() — error paths exercised without a real model

    /// Pre-call cancel should not abort the next call (the generate loop
    /// resets the flag at entry). Compatibility with ζ-iOS.1 contract.
    /// Updated for ζ-iOS.2: now that we actually try to load the model
    /// on the happy path, calling `generate` against an empty tmp dir
    /// fails at `ensureModelLoaded()` rather than returning a stub. We
    /// assert on the error *kind*, not the message.
    func testGenerate_emptyDirectory_throwsModelLoadFailed() async throws {
        let dir = try makeTempModelDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let backend = try MLXLlamaBackend(modelPath: dir)
        do {
            _ = try await backend.generate(
                messages: [LlmMessage(role: .user, content: "hi")],
                tools: [],
                system: "",
                forceToolUse: false
            )
            XCTFail("Expected modelLoadFailed; got success")
        } catch let MLXLlamaBackendError.modelLoadFailed(msg) {
            XCTAssertTrue(
                msg.contains("Llama-3.2-1B-Instruct-4bit"),
                "Error must mention model name for debuggability: \(msg)"
            )
            XCTAssertTrue(
                msg.contains("config.json"),
                "Error must point at the missing artifact: \(msg)"
            )
        } catch {
            XCTFail("Expected MLXLlamaBackendError.modelLoadFailed, got \(error)")
        }
    }

    /// Tool use is gated until a future phase wires it up. Verifies the
    /// short-circuit fires before we touch the filesystem.
    func testGenerate_withTools_throwsNotImplemented() async throws {
        let dir = try makeTempModelDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let backend = try MLXLlamaBackend(modelPath: dir)
        let tool = Tool(
            name: "weather",
            description: "Get weather",
            inputSchemaJSON: Data("{}".utf8)
        )
        do {
            _ = try await backend.generate(
                messages: [LlmMessage(role: .user, content: "hi")],
                tools: [tool],
                system: "",
                forceToolUse: false
            )
            XCTFail("Expected notImplemented; got success")
        } catch LlmBackendError.notImplemented {
            // expected
        } catch {
            XCTFail("Expected LlmBackendError.notImplemented, got \(error)")
        }
    }

    /// Pre-call `cancel()` does NOT abort the next call (per ζ-iOS.1
    /// contract — the generate loop resets the flag at entry, so a
    /// previously cancelled backend serves fresh requests).
    /// Because the tmp dir has no model, we expect the load-failure
    /// path, not `.cancelled`.
    func testGenerate_preCallCancel_doesNotAbort() async throws {
        let dir = try makeTempModelDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let backend = try MLXLlamaBackend(modelPath: dir)
        backend.cancel()

        do {
            _ = try await backend.generate(
                messages: [LlmMessage(role: .user, content: "hi")],
                tools: [],
                system: "",
                forceToolUse: false
            )
            XCTFail("Expected modelLoadFailed; got success")
        } catch MLXLlamaBackendError.modelLoadFailed {
            // expected: load fails before any token loop runs
        } catch LlmBackendError.cancelled {
            XCTFail("ζ-iOS.2 contract: pre-call cancel must not abort the next call")
        } catch {
            XCTFail("Expected modelLoadFailed, got \(error)")
        }
    }

    func testShutdown_isIdempotent() throws {
        let dir = try makeTempModelDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let backend = try MLXLlamaBackend(modelPath: dir)
        backend.shutdown()
        backend.shutdown() // must not crash
        XCTAssertFalse(backend.isModelLoadedForTests)
    }

    // MARK: - Integration tests (require a real model on disk)

    /// Smoke test: real load against the published Llama-3.2-1B-4bit
    /// directory. Skipped unless `GHOLA_MLX_TEST_MODEL_PATH` points at
    /// a directory with `config.json` + safetensors.
    func testIntegration_loadRealModel() async throws {
        let modelPath = try realModelPath()
        let backend = try MLXLlamaBackend(modelPath: modelPath)

        // The model only loads on first generate(), so a no-op-ish
        // probe is the cheapest way to verify the load path. We send
        // a one-token prompt and discard the result.
        let response = try await backend.generate(
            messages: [LlmMessage(role: .user, content: "Hi")],
            tools: [],
            system: "",
            forceToolUse: false
        )
        XCTAssertEqual(response.contentBlocks.count, 1)
        XCTAssertTrue(backend.isModelLoadedForTests, "Container should be cached after generate")
        XCTAssertEqual(response.stopReason, "stop")
    }

    /// Real generation: "Say hi" should produce a non-empty assistant
    /// response. We do not assert on the *content* of the response —
    /// Llama 3.2 1B at temperature 0.7 is not deterministic enough to
    /// pin a string. We only check that *some* text came back.
    func testIntegration_generateProducesText() async throws {
        let modelPath = try realModelPath()
        let backend = try MLXLlamaBackend(modelPath: modelPath)

        let response = try await backend.generate(
            messages: [LlmMessage(role: .user, content: "Say hi in one word.")],
            tools: [],
            system: "You are a concise assistant.",
            forceToolUse: false
        )

        XCTAssertEqual(response.contentBlocks.count, 1)
        guard case .text(let body) = response.contentBlocks[0] else {
            return XCTFail("Expected text content, got \(response.contentBlocks[0])")
        }
        XCTAssertFalse(body.isEmpty, "Model should produce at least one token")
        XCTAssertNotNil(response.usage, "Usage should be populated after a real generation")
        XCTAssertGreaterThan(response.usage?.inputTokens ?? 0, 0)
        XCTAssertGreaterThan(response.usage?.outputTokens ?? 0, 0)
    }

    /// Cancellation mid-stream: kick off a long-ish generation, fire
    /// `cancel()` from a sibling Task, expect `LlmBackendError.cancelled`.
    /// The "long-ish" prompt asks for a 200-word essay so we have a
    /// reasonable token-stream window in which to flip the flag.
    func testIntegration_cancellationMidGeneration() async throws {
        let modelPath = try realModelPath()
        let backend = try MLXLlamaBackend(modelPath: modelPath)

        // Warm the model first so cancel doesn't race the load —
        // we want to cancel the *generation* loop, not the loader.
        _ = try await backend.generate(
            messages: [LlmMessage(role: .user, content: "Hi")],
            tools: [],
            system: "",
            forceToolUse: false
        )

        let cancelTask = Task {
            try? await Task.sleep(nanoseconds: 100_000_000) // 100 ms
            backend.cancel()
        }
        defer { cancelTask.cancel() }

        do {
            _ = try await backend.generate(
                messages: [LlmMessage(
                    role: .user,
                    content: "Write a 200-word essay on the history of bread."
                )],
                tools: [],
                system: "",
                forceToolUse: false
            )
            XCTFail("Expected cancelled; got full completion")
        } catch LlmBackendError.cancelled {
            // expected
        } catch {
            XCTFail("Expected LlmBackendError.cancelled, got \(error)")
        }
    }

    /// `shutdown()` drops the container reference; the next `generate()`
    /// re-loads it.
    func testIntegration_shutdownFreesAndReloads() async throws {
        let modelPath = try realModelPath()
        let backend = try MLXLlamaBackend(modelPath: modelPath)

        _ = try await backend.generate(
            messages: [LlmMessage(role: .user, content: "Hi")],
            tools: [],
            system: "",
            forceToolUse: false
        )
        XCTAssertTrue(backend.isModelLoadedForTests)

        backend.shutdown()
        XCTAssertFalse(backend.isModelLoadedForTests, "shutdown should drop the container")

        _ = try await backend.generate(
            messages: [LlmMessage(role: .user, content: "Hi")],
            tools: [],
            system: "",
            forceToolUse: false
        )
        XCTAssertTrue(backend.isModelLoadedForTests, "second generate should reload")
    }

    /// Reuse: two back-to-back `generate()` calls should reuse the
    /// loaded container. We can't measure load-wallclock directly from
    /// outside the class, so we assert on the `isModelLoadedForTests`
    /// flag (cached after call #1, still cached after call #2). The
    /// `os_log` line from the second call will show a load_ms ≈ 0,
    /// which the future battery profiler port will assert on.
    func testIntegration_reuseLoadedModel() async throws {
        let modelPath = try realModelPath()
        let backend = try MLXLlamaBackend(modelPath: modelPath)

        XCTAssertFalse(backend.isModelLoadedForTests)

        _ = try await backend.generate(
            messages: [LlmMessage(role: .user, content: "First")],
            tools: [],
            system: "",
            forceToolUse: false
        )
        XCTAssertTrue(backend.isModelLoadedForTests)

        _ = try await backend.generate(
            messages: [LlmMessage(role: .user, content: "Second")],
            tools: [],
            system: "",
            forceToolUse: false
        )
        XCTAssertTrue(backend.isModelLoadedForTests, "container should still be cached")
    }

    // MARK: - Helpers

    private func makeTempModelDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("ghola-mlx-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: dir,
            withIntermediateDirectories: true
        )
        return dir
    }

    /// Resolve a real model directory or `XCTSkip`. We refuse to
    /// fabricate safetensors bytes — MLX's loader will OOM or assert
    /// on garbage input rather than emit a clean error, and the
    /// resulting test failure is unhelpful.
    private func realModelPath() throws -> URL {
        guard let raw = ProcessInfo.processInfo.environment["GHOLA_MLX_TEST_MODEL_PATH"],
              !raw.isEmpty else {
            throw XCTSkip("""
                Set GHOLA_MLX_TEST_MODEL_PATH to a local mlx-community/Llama-3.2-1B-Instruct-4bit \
                directory to run integration tests. Download via: \
                huggingface-cli download mlx-community/Llama-3.2-1B-Instruct-4bit \
                --local-dir /tmp/ghola-mlx-llama32-1b-4bit
                """)
        }
        let url = URL(fileURLWithPath: raw, isDirectory: true)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir),
              isDir.boolValue,
              FileManager.default.fileExists(
                atPath: url.appendingPathComponent("config.json").path
              ) else {
            throw XCTSkip("GHOLA_MLX_TEST_MODEL_PATH=\(raw) is not a valid model directory (no config.json)")
        }
        return url
    }
}

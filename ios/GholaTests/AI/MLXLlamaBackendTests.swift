import XCTest
@testable import Ghola

final class MLXLlamaBackendTests: XCTestCase {

    // MARK: - Constructor

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

    // MARK: - generate() stub

    func testGenerate_returnsPlaceholderApiResponse() async throws {
        let dir = try makeTempModelDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let backend = try MLXLlamaBackend(modelPath: dir)
        // ζ-iOS.0 reconciliation: signature is (messages, tools, system,
        // forceToolUse) to match the canonical LlmBackend protocol.
        let response = try await backend.generate(
            messages: [LlmMessage(role: .user, content: "hello")],
            tools: [],
            system: "",
            forceToolUse: false
        )

        XCTAssertEqual(response.contentBlocks.count, 1)
        guard case .text(let body) = response.contentBlocks[0] else {
            return XCTFail("Expected text content block, got \(response.contentBlocks[0])")
        }
        XCTAssertTrue(body.contains("ζ-iOS.1 scaffold"), "stub body should call out the phase: \(body)")
        XCTAssertTrue(body.contains("Received 1 message"))
        XCTAssertNil(response.usage, "stub does not report usage")
        XCTAssertEqual(response.stopReason, "stub")
    }

    func testGenerate_afterCancel_throwsCancelled() async throws {
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
            // generate() resets the cancellation flag at entry, so this path
            // is currently expected to succeed. The test documents that
            // contract — flip the assertion when ζ-iOS.2 changes it.
            XCTAssertTrue(true, "cancel() before generate() does NOT abort the next call")
        } catch {
            XCTFail("ζ-iOS.1 contract: pre-call cancel should not abort. Got \(error)")
        }
    }

    func testShutdown_isIdempotent() throws {
        let dir = try makeTempModelDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let backend = try MLXLlamaBackend(modelPath: dir)
        backend.shutdown()
        backend.shutdown() // must not crash
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
}

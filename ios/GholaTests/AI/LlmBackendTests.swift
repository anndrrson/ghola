import XCTest
@testable import Ghola

/// Tests for the LlmBackend protocol surface and BackendRegistry
/// factory. These run without the network: the fake backend below
/// returns canned responses, so the protocol compile-time conformance
/// is what's really under test.
final class LlmBackendTests: XCTestCase {

    // MARK: - Fake backend

    /// Minimal `LlmBackend` impl used to prove the protocol shape and
    /// to drive in-memory tests. Tracks call counts so future tests
    /// (cancel/shutdown idempotency, AgentController loop, etc.) have
    /// a hook.
    final class FakeBackend: LlmBackend, @unchecked Sendable {
        let displayName: String = "Fake"
        let requiresInternet: Bool = false

        private(set) var generateCallCount = 0
        private(set) var cancelCallCount = 0
        private(set) var shutdownCallCount = 0
        var cannedResponse: ApiResponse = ApiResponse(
            contentBlocks: [.text("hello")],
            stopReason: "end_turn",
            usage: Usage(inputTokens: 1, outputTokens: 1)
        )

        func generate(
            messages: [LlmMessage],
            tools: [Tool],
            system: String,
            forceToolUse: Bool
        ) async throws -> ApiResponse {
            generateCallCount += 1
            return cannedResponse
        }

        func cancel() {
            cancelCallCount += 1
        }

        func shutdown() {
            shutdownCallCount += 1
        }
    }

    // MARK: - Protocol shape

    /// Compile-time + runtime check that a `LlmBackend` impl satisfies
    /// the protocol and that the default `generate(messages:tools:system:)`
    /// convenience overload reaches the four-arg requirement.
    func testProtocolShape_FakeBackendConformsAndRespondsToConvenience() async throws {
        let backend: LlmBackend = FakeBackend()
        XCTAssertEqual(backend.displayName, "Fake")
        XCTAssertFalse(backend.requiresInternet)

        let response = try await backend.generate(
            messages: [LlmMessage(role: .user, content: "hi")]
        )
        XCTAssertEqual(response.stopReason, "end_turn")
        if case .text(let s) = response.contentBlocks.first {
            XCTAssertEqual(s, "hello")
        } else {
            XCTFail("expected first content block to be .text")
        }
    }

    /// Cancel + shutdown must be idempotent (matches Kotlin contract).
    func testCancelAndShutdown_AreIdempotent() {
        let backend = FakeBackend()
        backend.cancel()
        backend.cancel()
        backend.shutdown()
        backend.shutdown()
        XCTAssertEqual(backend.cancelCallCount, 2)
        XCTAssertEqual(backend.shutdownCallCount, 2)
        // (Real impls must tolerate this; the fake just counts.)
    }

    // MARK: - BackendRegistry

    func testBackendRegistry_CloudModeReturnsCloudBackend() throws {
        let backend = try BackendRegistry.make(for: .cloud)
        XCTAssertTrue(backend is CloudLlmBackend)
        XCTAssertTrue(backend.requiresInternet)
        XCTAssertEqual(backend.displayName, "Claude (Cloud)")
    }

    func testBackendRegistry_MlxLocalModeThrowsNotImplemented() {
        XCTAssertThrowsError(try BackendRegistry.make(for: .mlxLocal)) { error in
            guard let backendErr = error as? LlmBackendError else {
                XCTFail("expected LlmBackendError, got \(error)")
                return
            }
            switch backendErr {
            case .notImplemented(let reason):
                XCTAssertTrue(
                    reason.lowercased().contains("mlx"),
                    "error reason should mention MLX, got: \(reason)"
                )
            default:
                XCTFail("expected .notImplemented, got \(backendErr)")
            }
        }
    }

    func testBackendMode_AllCasesIncludeCloudAndMlxLocal() {
        let cases = Set(BackendMode.allCases.map(\.rawValue))
        XCTAssertTrue(cases.contains("cloud"))
        XCTAssertTrue(cases.contains("mlxLocal"))
    }
}

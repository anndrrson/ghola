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
        var displayName: String = "Fake"
        var requiresInternet: Bool = false
        var runtimeBoundary: LlmRuntimeBoundary = .onDevice

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

    func testBackendMode_AllCasesIncludePrivacyAndExplicitCloudModes() {
        let cases = Set(BackendMode.allCases.map(\.rawValue))
        XCTAssertTrue(cases.contains("onDeviceFirst"))
        XCTAssertTrue(cases.contains("appleFoundation"))
        XCTAssertTrue(cases.contains("cloud"))
        XCTAssertTrue(cases.contains("mlxLocal"))
    }

    func testBackendRegistry_DefaultModeIsOnDeviceFirst() {
        XCTAssertEqual(
            BackendRegistry.defaultMode,
            .onDeviceFirst,
            "Default backend selection should preserve the on-device-first privacy boundary."
        )
    }

    func testRuntimeDisclosure_DetectsOnDeviceQuestion() {
        XCTAssertTrue(
            LlmRuntimeDisclosure.shouldAnswerDeterministically("are you running on device right now")
        )
        XCTAssertTrue(
            LlmRuntimeDisclosure.shouldAnswerDeterministically("is Ghola using cloud or my iPhone processor?")
        )
        XCTAssertFalse(
            LlmRuntimeDisclosure.shouldAnswerDeterministically("write a follow-up email")
        )
    }

    func testRuntimeDisclosure_CloudAnswerIsExplicitlyNotOnDevice() {
        let backend = FakeBackend()
        backend.displayName = "Claude (Cloud)"
        backend.requiresInternet = true
        backend.runtimeBoundary = .gholaCloud

        let answer = LlmRuntimeDisclosure.answer(
            selectedMode: .cloud,
            backend: backend,
            backendError: nil,
            localServerName: nil,
            isLocalServerMode: false
        )

        XCTAssertTrue(answer.contains("No. Chat inference is currently using Claude (Cloud)"))
        XCTAssertTrue(answer.contains("virtualized environment"))
        XCTAssertTrue(answer.contains("native iOS app on this iPhone"))
    }

    func testRuntimeDisclosure_OnDeviceUnavailableExplainsFailClosed() {
        let answer = LlmRuntimeDisclosure.answer(
            selectedMode: .onDeviceFirst,
            backend: nil,
            backendError: "No verified MLX model is installed.",
            localServerName: nil,
            isLocalServerMode: false
        )

        XCTAssertTrue(answer.contains("not currently running in cloud fallback"))
        XCTAssertTrue(answer.contains("fails closed"))
        XCTAssertTrue(answer.contains("No verified MLX model is installed"))
    }

    // MARK: - Privacy / on-device-first policy

    func testBackendRegistry_MlxLocalModeNeverFallsBackToCloudWhenUnavailable() {
        do {
            let backend = try BackendRegistry.make(for: .mlxLocal)
            XCTAssertFalse(
                backend is CloudLlmBackend,
                "A local/on-device selection must not silently fall back to cloud."
            )
            XCTAssertFalse(
                backend.requiresInternet,
                "A local/on-device selection must remain non-networked when it succeeds."
            )
        } catch let error as LlmBackendError {
            switch error {
            case .notImplemented, .modelNotReady:
                break
            default:
                XCTFail("expected explicit local-unavailable error, got \(error)")
            }
        } catch {
            XCTFail("expected LlmBackendError, got \(error)")
        }
    }

    func testBackendMode_OnDeviceFirstPrivacyModeExistsAndDoesNotResolveToCloud() throws {
        guard let mode = BackendMode(rawValue: "onDeviceFirst") else {
            XCTFail(
                "Expected BackendMode.onDeviceFirst privacy mode. It should prefer on-device " +
                "execution and throw explicitly when unavailable, never fall back to cloud."
            )
            return
        }

        do {
            let backend = try BackendRegistry.make(for: mode)
            XCTAssertFalse(
                backend is CloudLlmBackend,
                "onDeviceFirst must not silently resolve to CloudLlmBackend."
            )
            XCTAssertFalse(
                backend.requiresInternet,
                "onDeviceFirst must not select a network-required backend."
            )
        } catch let error as LlmBackendError {
            switch error {
            case .notImplemented, .modelNotReady:
                break
            default:
                XCTFail("expected explicit on-device-unavailable error, got \(error)")
            }
        }
    }

    func testPrivacyGate_DefaultModeIsStrictLocal() {
        let previous = UserDefaults.standard.string(forKey: GholaPrivacyMode.storageKey)
        UserDefaults.standard.removeObject(forKey: GholaPrivacyMode.storageKey)
        defer {
            if let previous {
                UserDefaults.standard.set(previous, forKey: GholaPrivacyMode.storageKey)
            } else {
                UserDefaults.standard.removeObject(forKey: GholaPrivacyMode.storageKey)
            }
        }

        XCTAssertEqual(PrivacyGate.currentMode, .strictLocal)
    }

    func testPrivacyGate_BlocksExternalActionWithoutApproval() {
        XCTAssertThrowsError(try PrivacyGate.authorize(scope: .callExecution)) { error in
            XCTAssertTrue(error.localizedDescription.contains("requires explicit approval"))
        }
    }

    func testPrivacyGate_AllowsMatchingExternalApproval() {
        let approval = PrivacyGate.makeApproval(
            scope: .callExecution,
            summary: "User approved call execution."
        )
        XCTAssertNoThrow(try PrivacyGate.authorize(scope: .callExecution, approval: approval))
    }

    func testPrivacyGate_BlocksCloudChatUnlessCloudSelected() {
        let previous = BackendRegistry.selectedMode
        BackendRegistry.selectedMode = .onDeviceFirst
        defer { BackendRegistry.selectedMode = previous }

        let approval = PrivacyGate.makeApproval(
            scope: .cloudChat,
            summary: "User approved cloud chat."
        )
        XCTAssertThrowsError(try PrivacyGate.authorize(scope: .cloudChat, approval: approval)) { error in
            XCTAssertTrue(error.localizedDescription.contains("Cloud chat is blocked"))
        }
    }

    func testWalletUSDCAmountParser_ConvertsToMicros() {
        XCTAssertEqual(USDCAmountParser.microUSDC(from: "1"), 1_000_000)
        XCTAssertEqual(USDCAmountParser.microUSDC(from: "1.23"), 1_230_000)
        XCTAssertEqual(USDCAmountParser.microUSDC(from: "0.000001"), 1)
    }

    func testWalletUSDCAmountParser_RejectsInvalidValues() {
        XCTAssertNil(USDCAmountParser.microUSDC(from: "0"))
        XCTAssertNil(USDCAmountParser.microUSDC(from: "-1"))
        XCTAssertNil(USDCAmountParser.microUSDC(from: "1.0000001"))
        XCTAssertNil(USDCAmountParser.microUSDC(from: "not money"))
    }

    func testSolanaAddressValidator_AllowsBase58PublicKeysOnly() {
        XCTAssertTrue(SolanaAddressValidator.looksValid("11111111111111111111111111111111"))
        XCTAssertFalse(SolanaAddressValidator.looksValid("0OIl1111111111111111111111111111"))
        XCTAssertFalse(SolanaAddressValidator.looksValid("short"))
    }

    func testWalletContact_NormalizesNameHandleAndAddress() throws {
        let contact = try WalletContact.make(
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!,
            displayName: "  Sarah  ",
            handle: " @Sarah ",
            address: " 11111111111111111111111111111111 ",
            shieldedAddress: " aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq ",
            now: Date(timeIntervalSince1970: 1_000)
        )

        XCTAssertEqual(contact.displayName, "Sarah")
        XCTAssertEqual(contact.handle, "sarah")
        XCTAssertEqual(contact.address, "11111111111111111111111111111111")
        XCTAssertEqual(contact.shieldedAddress, "aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq")
    }

    func testWalletContact_RejectsInvalidAddress() {
        XCTAssertThrowsError(
            try WalletContact.make(displayName: "Sarah", handle: nil, address: "not-a-solana-address")
        )
    }

    func testWalletContact_RejectsInvalidShieldedAddress() {
        XCTAssertThrowsError(
            try WalletContact.make(
                displayName: "Sarah",
                handle: nil,
                address: "11111111111111111111111111111111",
                shieldedAddress: "11111111111111111111111111111111"
            )
        )
    }

    func testWalletContactsCodec_RoundTripsLocalContacts() throws {
        let contact = try WalletContact.make(
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000002")!,
            displayName: "Turnkey Friend",
            handle: "friend",
            address: "11111111111111111111111111111111",
            now: Date(timeIntervalSince1970: 2_000)
        )

        let data = try WalletContactsCodec.encode([contact])
        let decoded = try WalletContactsCodec.decode(data)
        XCTAssertEqual(decoded, [contact])
    }

    func testPendingPrivateTransferCodec_RoundTripsLocalIntent() throws {
        let intent = PendingPrivateTransfer(
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000003")!,
            recipientAddress: "aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
            recipientPreview: "aleo1qqq...qqqqqq",
            amountMicroUSDC: 1_000_000,
            network: "aleo:mainnet",
            asset: "USDCx",
            createdAt: Date(timeIntervalSince1970: 3_000),
            expiresAt: Date(timeIntervalSince1970: 3_600)
        )

        let data = try WalletContactsCodec.encodePendingPrivateTransfers([intent])
        let decoded = try WalletContactsCodec.decodePendingPrivateTransfers(data)
        XCTAssertEqual(decoded, [intent])
    }

    func testPrivacyGate_AllowsWalletApprovalsOnlyForMatchingScope() {
        let transferApproval = PrivacyGate.makeApproval(
            scope: .walletTransfer,
            summary: "User approved a public Solana USDC transfer."
        )
        XCTAssertNoThrow(try PrivacyGate.authorize(scope: .walletTransfer, approval: transferApproval))
        XCTAssertThrowsError(try PrivacyGate.authorize(scope: .walletProvision, approval: transferApproval))

        let provisionApproval = PrivacyGate.makeApproval(
            scope: .walletProvision,
            summary: "User approved wallet provisioning."
        )
        XCTAssertNoThrow(try PrivacyGate.authorize(scope: .walletProvision, approval: provisionApproval))
    }
}

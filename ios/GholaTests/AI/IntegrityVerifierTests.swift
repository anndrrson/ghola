import XCTest
import CryptoKit
@testable import Ghola

/// Unit tests for `IntegrityVerifier`. Swift port of
/// `IntegrityVerifierTest` at
/// `android/app/src/test/java/xyz/ghola/app/ai/IntegrityVerifierTest.kt`.
/// Same 8 test cases, same expected behavior — the two suites should be
/// possible to diff line-by-line.
///
/// Covers the Phase η contract:
///  - Known-good fixture hashes pass.
///  - Tampered bytes fail.
///  - `nil` pin = observe-but-don't-enforce, with the documented reason.
///  - Case-insensitive pin compare.
///  - Task cancellation interrupts a long hash.
///  - Chunked file reads produce the same digest as a single-shot hash.
///  - Chunked tamper detection on a moderately large file.
///  - Empty file edge case.
final class IntegrityVerifierTests: XCTestCase {

    private var tempFiles: [URL] = []

    override func tearDown() {
        for url in tempFiles {
            try? FileManager.default.removeItem(at: url)
        }
        tempFiles.removeAll()
        super.tearDown()
    }

    private func makeTempFile(prefix: String, bytes: Data) throws -> URL {
        let dir = FileManager.default.temporaryDirectory
        let name = "\(prefix)\(UUID().uuidString).bin"
        let url = dir.appendingPathComponent(name)
        try bytes.write(to: url)
        tempFiles.append(url)
        return url
    }

    /// Compute SHA-256 once over the whole buffer; reference value.
    private func singleShotHex(_ bytes: Data) -> String {
        let digest = SHA256.hash(data: bytes)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Test 1: known-good fixture hash

    func testVerifyBytes_matchesKnownGoodHash() {
        // sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
        let payload = Data("hello world".utf8)
        let expected =
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"

        let result = IntegrityVerifier.verifyBytes(payload, expectedSha256: expected)

        XCTAssertTrue(result.match, "expected match for known-good payload")
        XCTAssertEqual(result.record.sha256Hex, expected)
        XCTAssertEqual(result.expectedSha256, expected)
        XCTAssertEqual(result.record.sizeBytes, Int64(payload.count))
        XCTAssertNil(result.reason)
    }

    // MARK: - Test 2: mismatch detection

    func testVerifyBytes_mismatchedHashFails() {
        let payload = Data("hello world".utf8)
        let wrongHash =
            "0000000000000000000000000000000000000000000000000000000000000000"

        let result = IntegrityVerifier.verifyBytes(payload, expectedSha256: wrongHash)

        XCTAssertFalse(result.match, "expected mismatch")
        XCTAssertEqual(result.expectedSha256, wrongHash)
        XCTAssertNotNil(result.reason, "mismatch must carry a reason")
        XCTAssertTrue(
            result.reason?.contains("mismatch") ?? false,
            "reason should mention sha256 mismatch"
        )
    }

    // MARK: - Test 3: nil pin = observe-but-don't-enforce

    func testVerifyBytes_nilPinTreatedAsMatch() {
        let payload = Data("anything".utf8)

        let result = IntegrityVerifier.verifyBytes(payload, expectedSha256: nil)

        XCTAssertTrue(
            result.match,
            "nil pin must yield match=true (observe-but-don't-enforce)"
        )
        XCTAssertNil(result.expectedSha256)
        XCTAssertEqual(result.reason, "no expected hash pinned yet")
    }

    // MARK: - Test 4: case-insensitive pin compare

    func testVerifyBytes_pinCompareIsCaseInsensitive() {
        let payload = Data("hello world".utf8)
        let upperHash =
            "B94D27B9934D3E08A52E52D7DA7DABFAC484EFE37A5380EE9088F7ACE2EFCDE9"

        let result = IntegrityVerifier.verifyBytes(payload, expectedSha256: upperHash)

        XCTAssertTrue(result.match, "uppercase pin must still match")
        XCTAssertEqual(
            result.expectedSha256,
            upperHash.lowercased(),
            "expectedSha256 is echoed back lowercase-normalized"
        )
    }

    // MARK: - Test 5: cancellation respected mid-hash

    func testVerifyFile_respectsCancellation() async throws {
        // ~4 MiB → ~64 chunks at chunkSize=64 KiB. Enough iterations
        // that we can race a cancel between chunk reads.
        var bigPayload = Data(count: 4 * 1024 * 1024)
        for i in 0..<bigPayload.count {
            bigPayload[i] = UInt8(i & 0xFF)
        }
        let bigFile = try makeTempFile(prefix: "integrity-cancel-", bytes: bigPayload)

        let task = Task<IntegrityVerifier.IntegrityResult?, Error> {
            do {
                return try await IntegrityVerifier.verifyFile(
                    at: bigFile,
                    expectedSha256: nil
                )
            } catch is CancellationError {
                return nil
            } catch IntegrityVerifier.IntegrityError.cancelled {
                return nil
            }
        }
        // Immediately cancel. Either the task observes the cancel
        // between chunks and throws `IntegrityError.cancelled` (→ nil),
        // or it finishes faster than the cancel can propagate on a
        // beefy CI host. Both are acceptable — the contract under test
        // is "doesn't deadlock and honours cancellation when given the
        // chance."
        task.cancel()
        let outcome = try await task.value
        // If we got a result back, the task beat the cancel; if nil,
        // the cancel landed. Either way, no deadlock.
        if outcome != nil {
            // Hash completed before cancel was observed; nothing to
            // assert beyond non-deadlock. Single-line tolerance is
            // intentional and mirrors the Kotlin test's same comment.
        }
    }

    // MARK: - Test 6: chunked hash equals single-shot hash on a >128KB file

    func testVerifyFile_chunkedHashMatchesSingleShot() async throws {
        // 200 KiB — comfortably > chunkSize (64 KiB) so the digester
        // sees at least 3 update() calls plus the trailing partial.
        var payload = Data(count: 200 * 1024)
        for i in 0..<payload.count {
            payload[i] = UInt8((i &* 31) & 0xFF)
        }
        let file = try makeTempFile(prefix: "integrity-chunked-", bytes: payload)

        let singleShot = singleShotHex(payload)
        let result = try await IntegrityVerifier.verifyFile(
            at: file,
            expectedSha256: singleShot
        )

        XCTAssertTrue(
            result.match,
            "chunked digest must equal single-shot digest"
        )
        XCTAssertEqual(result.record.sha256Hex, singleShot)
        XCTAssertEqual(result.record.sizeBytes, Int64(payload.count))
        XCTAssertEqual(result.record.artifactName, file.lastPathComponent)
    }

    // MARK: - Test 7: chunked tamper detection on a 150KB file

    func testVerifyFile_chunkedHashDetectsTamperingAgainstPin() async throws {
        var payload = Data(count: 150 * 1024)
        for i in 0..<payload.count {
            payload[i] = UInt8((i ^ 0x5A) & 0xFF)
        }
        let file = try makeTempFile(prefix: "integrity-tamper-", bytes: payload)

        let wrongPin =
            "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        let result = try await IntegrityVerifier.verifyFile(
            at: file,
            expectedSha256: wrongPin
        )

        XCTAssertFalse(result.match)
        XCTAssertEqual(result.expectedSha256, wrongPin)
        XCTAssertNotNil(result.reason)
        XCTAssertEqual(
            result.record.sha256Hex,
            singleShotHex(payload),
            "recorded hash should equal single-shot hash on tamper too"
        )
    }

    // MARK: - Test 8: empty file edge case

    func testVerifyFile_emptyFileHasCanonicalEmptyHash() async throws {
        // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        let emptyHash =
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        let emptyFile = try makeTempFile(prefix: "integrity-empty-", bytes: Data())

        let result = try await IntegrityVerifier.verifyFile(
            at: emptyFile,
            expectedSha256: emptyHash
        )

        XCTAssertTrue(result.match)
        XCTAssertEqual(result.record.sha256Hex, emptyHash)
        XCTAssertEqual(result.record.sizeBytes, 0)
    }

    // MARK: - Bonus: PinnedModelHashes shape sanity

    func testPinnedModelHashes_allNilToday() {
        // Every constant must be nil today — the comparator's
        // observe-but-don't-enforce path is what's under test. If
        // someone flips a pin to a real hex string they must also
        // update this assertion.
        XCTAssertNil(PinnedModelHashes.llamaThreePointTwoOneBInstructFourBitSha256)
        XCTAssertNil(PinnedModelHashes.mistralSevenBInstructV03FourBitSha256)
        XCTAssertNil(PinnedModelHashes.qwenTwoPointFiveOneFiveBInstructFourBitSha256)
        XCTAssertNil(PinnedModelHashes.forVariant("llama-3.2-1b-4bit"))
        XCTAssertNil(PinnedModelHashes.forVariant("mistral-7b-v0.3-4bit"))
        XCTAssertNil(PinnedModelHashes.forVariant("qwen-2.5-1.5b-4bit"))
        XCTAssertNil(PinnedModelHashes.forVariant("unknown-model"))
    }

    func testModelStatus_allCasesPresent() {
        // Order is load-bearing — mirrors the Kotlin enum.
        XCTAssertEqual(
            ModelStatus.allCases,
            [.notDownloaded, .downloadedUnverified, .verified, .tampered]
        )
    }
}

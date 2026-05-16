import Foundation
import CryptoKit

/// On-device model integrity verifier.
///
/// Swift port of `IntegrityVerifier` at
/// `android/app/src/main/java/xyz/ghola/app/ai/IntegrityVerifier.kt`
/// (Phase η on Android, commits `d734805` / `9e51fdc` / `3ecf551`). The
/// Kotlin counterpart is the source of truth; this file mirrors its API
/// and behavior so a security reviewer can diff the two and convince
/// themselves the comparators cannot drift.
///
/// The web counterpart lives at
/// `apps/web/src/lib/webgpu-inference.ts`
/// (`computeLoadedWeightFingerprint`). All three platforms produce the
/// same canonical SHA-256 over the same file bytes, so a single pin in
/// the `ghola-model-registry` Anchor program is sufficient to anchor
/// every client.
///
/// Threat model:
///   - We assume the disk is trustworthy enough to read but not
///     trustworthy enough to *be* the source of truth. A pinned hash
///     (compiled into the IPA, eventually anchored on Solana via
///     `programs/ghola-model-registry/src/lib.rs`) is the source of
///     truth; this enum is the comparator.
///   - A `nil` pinned hash means "no expectation yet" — the result is
///     `match=true` with a `reason` string so callers can ship today
///     and start enforcing on the day the registry path lands without
///     a behavior change in the comparator itself.
///
/// Implementation notes:
///   - Uses `CryptoKit.SHA256` rather than CommonCrypto's `CC_SHA256`
///     because CryptoKit is the documented framework for new code on
///     iOS 13+ / macOS 10.15+ and is name-checked in
///     `docs/security/ios-privacy-posture.md` (commit `b29c4c1`).
///   - `verifyFile(at:expectedSha256:)` streams the file in 64 KiB
///     chunks through `SHA256.update(data:)` so multi-GB artifacts do
///     not allocate a single buffer the size of the file.
///   - Cooperates with Swift's structured concurrency: `Task.isCancelled`
///     is consulted between chunks. We do not check inside `read(...)`
///     because `FileHandle.read(upToCount:)` is uninterruptible on
///     darwin; checking between chunks bounds the worst-case latency
///     to a single 64 KiB read.
///
/// TODO(ζ-iOS.2 wire-in): when the parallel ζ.2 agent's commit lands
/// real MLX model loading in `MLXLlamaBackend`, add a single call to
/// `IntegrityVerifier.verifyFile(at:expectedSha256:)` inside the load
/// path immediately after the safetensors directory is resolved and
/// before any weights are read. The expected pin comes from
/// `PinnedModelHashes.forVariant("llama-3.2-1b-4bit")` — today `nil`,
/// so the call is a no-op other than computing the hash. If the result
/// has `match == false` AND `expectedSha256 != nil`, throw
/// `LlmBackendError.modelNotReady("integrity check failed")` (or the
/// equivalent variant ζ.2 names). This file deliberately does not
/// touch `MLXLlamaBackend.swift` to avoid stepping on the ζ.2 agent's
/// working tree.
public enum IntegrityVerifier {

    /// Chunk size for streaming the file into the SHA-256 digester.
    /// 64 KiB matches the Android constant (`IntegrityVerifier.CHUNK_SIZE`).
    /// Large enough that `SHA256.update(data:)` dominates per-iteration
    /// syscall overhead on the multi-GB safetensors artifact, small
    /// enough that we never allocate the whole 1.6 GB model in a
    /// single buffer.
    internal static let chunkSize: Int = 64 * 1024

    /// The record of a single integrity check. Mirrors the per-file
    /// shape inside `WeightFingerprint` in the web counterpart at
    /// `apps/web/src/lib/webgpu-inference.ts` and the
    /// `IntegrityRecord` Kotlin data class.
    ///
    /// - `artifactName`: human-readable artifact identifier (typically
    ///   the file basename). Equivalent to the `url` field on the web.
    /// - `sizeBytes`: file size in bytes at the moment the hash was
    ///   computed. Equivalent to `byteLength` on the web. Modelled as
    ///   `Int64` to match Kotlin's `Long`.
    /// - `sha256Hex`: lowercase hexadecimal SHA-256 digest, no `0x`
    ///   prefix, 64 chars.
    /// - `verifiedAt`: completion timestamp. Useful when surfaced in
    ///   audit logs.
    public struct IntegrityRecord: Sendable, Equatable {
        public let artifactName: String
        public let sizeBytes: Int64
        public let sha256Hex: String
        public let verifiedAt: Date

        public init(
            artifactName: String,
            sizeBytes: Int64,
            sha256Hex: String,
            verifiedAt: Date
        ) {
            self.artifactName = artifactName
            self.sizeBytes = sizeBytes
            self.sha256Hex = sha256Hex
            self.verifiedAt = verifiedAt
        }
    }

    /// Outcome of a verification call. The `record` field is always
    /// populated (the hash was computed regardless of whether a pin
    /// exists); `match` reflects the comparison against `expectedSha256`.
    ///
    /// When `expectedSha256` is `nil`, the verifier is in
    /// "observe-but-don't-enforce" mode: `match` is `true` and `reason`
    /// explains why. This is intentional — see the type-level doc and
    /// the Kotlin counterpart.
    public struct IntegrityResult: Sendable, Equatable {
        public let match: Bool
        public let record: IntegrityRecord
        public let expectedSha256: String?
        public let reason: String?

        public init(
            match: Bool,
            record: IntegrityRecord,
            expectedSha256: String?,
            reason: String?
        ) {
            self.match = match
            self.record = record
            self.expectedSha256 = expectedSha256
            self.reason = reason
        }
    }

    /// Errors raised by the file-streaming path.
    public enum IntegrityError: Error, Equatable {
        /// The file at the given URL could not be opened or read.
        case ioFailure(path: String, underlying: String)
        /// The calling `Task` was cancelled mid-hash.
        case cancelled(bytesRead: Int64)
    }

    /// Hash `url` in `chunkSize`-byte chunks and compare to
    /// `expectedSha256`.
    ///
    /// Cooperates with Swift structured concurrency: between chunks we
    /// check `Task.isCancelled` and throw `IntegrityError.cancelled` if
    /// the caller has cancelled. We do not check inside the underlying
    /// `read(upToCount:)` call because Darwin's `read(2)` is
    /// uninterruptible from Swift; checking between chunks bounds the
    /// worst-case latency to a single 64 KiB read.
    ///
    /// - Parameters:
    ///   - url: file URL to hash. Must be a regular file (not a
    ///     directory or symlink to one).
    ///   - expectedSha256: expected lowercase or uppercase hex SHA-256.
    ///     Case-insensitive. Pass `nil` to compute the hash without
    ///     enforcing a comparison (returns `match == true` with a
    ///     non-nil `reason`).
    /// - Throws: `IntegrityError.ioFailure` if the file cannot be
    ///   opened or read. `IntegrityError.cancelled` if the calling
    ///   `Task` is cancelled mid-hash.
    ///
    /// Kotlin counterpart: `IntegrityVerifier.verifyFile(file, expectedSha256)`.
    public static func verifyFile(
        at url: URL,
        expectedSha256: String?
    ) async throws -> IntegrityResult {
        let handle: FileHandle
        do {
            handle = try FileHandle(forReadingFrom: url)
        } catch {
            throw IntegrityError.ioFailure(
                path: url.path,
                underlying: String(describing: error)
            )
        }
        defer { try? handle.close() }

        var hasher = SHA256()
        var totalRead: Int64 = 0

        while true {
            // Cooperate with cancellation between chunks. Single-shot
            // throw site for both the cooperative and pre-emption
            // paths so test expectations can match on one error case.
            if Task.isCancelled {
                throw IntegrityError.cancelled(bytesRead: totalRead)
            }

            let chunk: Data
            do {
                // `read(upToCount:)` is the documented API on iOS 13.4+
                // / macOS 10.15.4+. Returns nil at EOF on some SDKs;
                // returns an empty Data on others. We handle both.
                chunk = try handle.read(upToCount: chunkSize) ?? Data()
            } catch {
                throw IntegrityError.ioFailure(
                    path: url.path,
                    underlying: String(describing: error)
                )
            }

            if chunk.isEmpty {
                break
            }

            hasher.update(data: chunk)
            totalRead += Int64(chunk.count)
        }

        let digest = hasher.finalize()
        let hex = hexString(from: digest)
        let record = IntegrityRecord(
            artifactName: url.lastPathComponent,
            sizeBytes: totalRead,
            sha256Hex: hex,
            verifiedAt: Date()
        )
        return compare(record: record, expectedSha256: expectedSha256)
    }

    /// In-memory variant of `verifyFile(at:expectedSha256:)`. Convenient
    /// for tests and for small artifacts (config JSON, tokenizer.json)
    /// where holding the whole payload in a `Data` is reasonable. For
    /// the multi-GB model weight files, always use
    /// `verifyFile(at:expectedSha256:)`.
    ///
    /// Synchronous because the input is already resident — there is no
    /// I/O to cancel.
    ///
    /// Kotlin counterpart: `IntegrityVerifier.verifyBytes(bytes, expectedSha256)`.
    public static func verifyBytes(
        _ data: Data,
        expectedSha256: String?
    ) -> IntegrityResult {
        let digest = SHA256.hash(data: data)
        let record = IntegrityRecord(
            artifactName: "<in-memory>",
            sizeBytes: Int64(data.count),
            sha256Hex: hexString(from: digest),
            verifiedAt: Date()
        )
        return compare(record: record, expectedSha256: expectedSha256)
    }

    // MARK: - Internals

    /// Shared comparator. Centralizes the case-insensitive hex
    /// comparison + the null-pin escape hatch so `verifyFile` and
    /// `verifyBytes` cannot drift. Mirrors the private Kotlin `compare`.
    private static func compare(
        record: IntegrityRecord,
        expectedSha256: String?
    ) -> IntegrityResult {
        guard let pin = expectedSha256 else {
            return IntegrityResult(
                match: true,
                record: record,
                expectedSha256: nil,
                reason: "no expected hash pinned yet"
            )
        }
        let normalized = pin.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let actual = record.sha256Hex  // already lowercase per hexString
        if normalized == actual {
            return IntegrityResult(
                match: true,
                record: record,
                expectedSha256: normalized,
                reason: nil
            )
        } else {
            return IntegrityResult(
                match: false,
                record: record,
                expectedSha256: normalized,
                reason: "sha256 mismatch: expected=\(normalized) actual=\(actual)"
            )
        }
    }

    /// Lowercase-hex encoder. Mirrors `bytesToHex` in the Kotlin
    /// counterpart and the web bundle. CryptoKit's `Digest` is a
    /// `Sequence<UInt8>` so we iterate it directly without the
    /// intermediate `Data` copy.
    private static func hexString<D: Digest>(from digest: D) -> String {
        var s = String()
        s.reserveCapacity(D.byteCount * 2)
        for byte in digest {
            let hi = Int(byte >> 4) & 0x0F
            let lo = Int(byte) & 0x0F
            s.append(hexChar(hi))
            s.append(hexChar(lo))
        }
        return s
    }

    private static func hexChar(_ nibble: Int) -> Character {
        switch nibble {
        case 0...9: return Character(UnicodeScalar(0x30 + nibble)!)
        case 10...15: return Character(UnicodeScalar(0x61 + nibble - 10)!)
        default: return "?"
        }
    }
}

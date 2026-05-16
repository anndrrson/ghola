import Foundation

/// Canonical coarse-grained status for an on-device model artifact,
/// combining presence-on-disk with the Phase η integrity check
/// performed by `IntegrityVerifier`.
///
/// Swift port of the Kotlin enum defined at
/// `android/app/src/main/java/xyz/ghola/app/ai/ModelStatus.kt`
/// (introduced in commit `3ecf551`). The two enums share semantics 1:1:
/// any logic predicated on a particular status value should behave
/// identically on iOS and Android. When the Phase η-iOS UI ships
/// (`IntegrityBadge` analogue), it consumes this enum the same way the
/// Android `IntegrityBadge` consumes the Kotlin one.
///
/// Producers (today: stubs / future work):
/// - The iOS analogue of `ModelManager.isModelVerified` once the MLX
///   downloader lands (ζ-iOS.2).
/// - The iOS analogue of `LiteRtModelManager.isModelVerified` — n/a on
///   iOS since the Apple GPU/Metal path replaces LiteRT-LM.
///
/// Cases (order is load-bearing — mirrors the Kotlin enum and the
/// `IntegrityBadge` test that iterates `allCases`):
/// - `notDownloaded` — file is missing or zero-byte.
/// - `downloadedUnverified` — file is present but the pinned SHA-256 in
///   `PinnedModelHashes` is still nil (i.e. we ship today without
///   enforcement; behavior is identical to the legacy "downloaded"
///   case).
/// - `verified` — file present AND its SHA-256 matches the pin.
/// - `tampered` — file present, pin present, hashes disagree. The
///   caller MUST NOT load this artifact into a runtime.
///
/// The `rawValue` strings double as wire labels for analytics /
/// diagnostics surfaces (e.g. the planned ζ.6 "Privacy Verification"
/// screen) so they intentionally match the camelCase Swift names rather
/// than Kotlin's SHOUT_CASE — call sites that need cross-platform
/// equality should normalize through a known mapping.
public enum ModelStatus: String, CaseIterable, Sendable, Equatable {
    case notDownloaded
    case downloadedUnverified
    case verified
    case tampered
}

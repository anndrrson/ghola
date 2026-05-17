import Foundation

/// Pinned SHA-256 hashes for every native model artifact Ghola ships on
/// iOS. Swift port of `PinnedModelHashes` at
/// `android/app/src/main/java/xyz/ghola/app/ai/PinnedModelHashes.kt`
/// (Phase η + Multi-SoC L1, commits `d734805` / `9e51fdc`). The web
/// counterpart is the SRI-style pin block `DEFAULT_WEBGPU_MODEL_INTEGRITY`
/// at the top of `apps/web/src/lib/webgpu-inference.ts`.
///
/// Today every value is `nil` — that intentionally puts
/// `IntegrityVerifier` in observe-but-don't-enforce mode (see the
/// type-level doc on `IntegrityVerifier`). Behavior on disk is
/// unchanged: the comparator returns `match=true` with a clear
/// `reason="no expected hash pinned yet"` so callers can wire the
/// verifier into the model lifecycle today and flip enforcement on as
/// a follow-up patch that simply changes these constants from `nil` to
/// real hex strings.
///
/// The corresponding hashes will be anchored in the
/// `ghola-model-registry` Anchor program (see
/// `programs/ghola-model-registry/src/lib.rs`) and re-derivable via the
/// `scripts/compute-weights-manifest.mjs` helper. Until that path lands,
/// the values here are also `nil`.
///
/// "Flip from nil to real hex" workflow:
///   1. Compute the SHA-256 of the safetensors directory's canonical
///      tarball (or single-file artifact) via `shasum -a 256` or
///      `CryptoKit.SHA256`.
///   2. Verify the same value appears in the `weights_hash` field of
///      the corresponding `ghola-model-registry` PDA.
///   3. Replace `nil` below with `"<64-char-lowercase-hex>"`.
///   4. The next build enforces; no other code change required.
public enum PinnedModelHashes {

    /// Pinned SHA-256 for the v0.6 MLX default model:
    /// `mlx-community/Llama-3.2-1B-Instruct-4bit` (~695 MB safetensors).
    ///
    /// Source URL (see `MLXLlamaBackend.modelPath`):
    ///   https://huggingface.co/mlx-community/Llama-3.2-1B-Instruct-4bit
    ///
    /// TODO(ζ-iOS.η): populate from the on-chain
    /// `ghola-model-registry` record once the safetensors bundle is
    /// anchored. Until then this is `nil` and `IntegrityVerifier`
    /// returns `match=true` with `reason="no expected hash pinned yet"`.
    public static let llamaThreePointTwoOneBInstructFourBitSha256: String? = nil

    /// Pinned SHA-256 for `mlx-community/Mistral-7B-Instruct-v0.3-4bit`.
    /// Reserved for the ζ-iOS power-user tier — the privacy posture doc
    /// (`docs/security/ios-privacy-posture.md`) lists it alongside the
    /// 1B Llama as a planned MLX target. `nil` today; same
    /// observe-but-don't-enforce posture.
    public static let mistralSevenBInstructV03FourBitSha256: String? = nil

    /// Pinned SHA-256 for `mlx-community/Qwen2.5-1.5B-Instruct-4bit`.
    /// Mirror of the Android Qwen 2.5 1.5B GGUF pin so the iOS build
    /// can ship the same default model if the Llama path slips. `nil`
    /// today; same observe-but-don't-enforce posture.
    public static let qwenTwoPointFiveOneFiveBInstructFourBitSha256: String? = nil

    /// Lookup a pinned SHA-256 by a stable string key. Returns `nil`
    /// for any variant that doesn't yet have a published pin (today:
    /// all of them — observe-but-don't-enforce). Mirrors the Kotlin
    /// `forVariant(LiteRtVariant)` accessor in shape, but keyed by
    /// `String` instead of an enum because the iOS side does not have
    /// a `LiteRtVariant` analogue (MLX targets the Apple GPU directly
    /// rather than a per-SoC NPU).
    ///
    /// Recognized keys (case-insensitive):
    ///   - `"llama-3.2-1b-4bit"` → `llamaThreePointTwoOneBInstructFourBitSha256`
    ///   - `"mistral-7b-v0.3-4bit"` → `mistralSevenBInstructV03FourBitSha256`
    ///   - `"qwen-2.5-1.5b-4bit"` → `qwenTwoPointFiveOneFiveBInstructFourBitSha256`
    ///   - anything else → `nil`
    ///
    /// Used by the `MLXLlamaBackend` load path (TODO: ζ-iOS.2) to gate
    /// the post-download integrity check without a giant switch
    /// statement at the call site.
    public static func forVariant(_ model: String) -> String? {
        switch model.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "llama-3.2-1b-4bit",
             "llama-3.2-1b-instruct-4bit":
            return llamaThreePointTwoOneBInstructFourBitSha256
        case "mistral-7b-v0.3-4bit",
             "mistral-7b-instruct-v0.3-4bit":
            return mistralSevenBInstructV03FourBitSha256
        case "qwen-2.5-1.5b-4bit",
             "qwen2.5-1.5b-instruct-4bit":
            return qwenTwoPointFiveOneFiveBInstructFourBitSha256
        default:
            return nil
        }
    }
}

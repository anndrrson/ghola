import Foundation

// NOTE: MLX module imports are intentionally NOT pulled in this turn. The SPM
// scaffold lands the dependencies (see ios/project.yml), but actual model
// loading + inference is ζ-iOS.2's responsibility. Keeping the imports out
// here means this file compiles even before SPM resolution completes, which
// matters for parallel agents working on the same checkout.
//
// When ζ-iOS.2 lands, replace the stub `generate(...)` body with the real
// implementation and uncomment:
// import MLX
// import MLXLLM
// import MLXLMCommon
// import MLXNN
// import MLXRandom

/// On-device LLM backend powered by MLX Swift running on Apple Silicon Metal
/// GPUs. Cross-platform analog of Android's
/// `xyz.ghola.app.ai.litert.LiteRTNeuroPilotBackend` — both ship 4-bit
/// quantised LLMs on the device's accelerator (MediaTek NPU on Android,
/// Apple GPU on iOS).
///
/// **Phase:** ζ-iOS.1 scaffold. `generate(...)` returns a hardcoded stub
/// `ApiResponse` until ζ-iOS.2 wires `LLMModelFactory` and the streaming
/// generation loop. See `docs/perf/ios-phase-zeta-mlx-plan.md` §8.
///
/// Target model: `mlx-community/Llama-3.2-1B-Instruct-4bit`
/// (~695 MB safetensors, Q4 groupwise).
///
/// Thread-safety: instance is `Sendable` via the `final class` + actor-style
/// cancellation flag. The MLX `ModelContainer` (when wired) is itself an
/// actor in `MLXLMCommon`.
final class MLXLlamaBackend: LlmBackend, @unchecked Sendable {

    // MARK: - LlmBackend contract

    /// Cross-ref: Android `LiteRTNeuroPilotBackend.displayName` returns
    /// "On-device (Gemma-3 1B 4-bit · MediaTek NPU)". iOS variant pinpoints
    /// the MLX runtime + Llama 3.2 1B because the SmallThinker MoE that
    /// Android ships has no MLX conversion yet (plan §4 headline gap).
    let displayName: String = "On-device (Llama 3.2 1B 4-bit · MLX)"

    /// Cross-ref: Android `LiteRTNeuroPilotBackend.requiresInternet == false`.
    /// On-device inference never touches the network after the initial
    /// weight download (which is owned by ζ-iOS.2's downloader, not this
    /// backend).
    let requiresInternet: Bool = false

    // MARK: - State

    /// Filesystem path to the unpacked safetensors directory. Set at init,
    /// validated to exist. Subsequent reload-from-disk happens lazily in
    /// ζ-iOS.2's `ensureModelLoaded()`.
    private let modelPath: URL

    /// Cancellation flag observed by the in-flight generate loop. Set true
    /// by `cancel()`. Reset to false at the top of every `generate(...)`.
    /// `Atomic` semantics achieved via `NSLock`-guarded scalar so we do not
    /// pull in `Atomics` for a single bool.
    private let cancelLock = NSLock()
    private var _cancelled: Bool = false

    /// Holds the lazily-loaded MLX model container. Typed as `Any?` for now
    /// to avoid importing `MLXLMCommon.ModelContainer` until ζ-iOS.2 — keeps
    /// the build green when SPM resolution is offline.
    private var modelContainer: Any?

    // MARK: - Lifecycle

    /// Construct against an already-downloaded model directory.
    ///
    /// - Parameter modelPath: directory containing `model.safetensors`,
    ///   `tokenizer.json`, and `config.json` as published by
    ///   `mlx-community/Llama-3.2-1B-Instruct-4bit`.
    /// - Throws: `MLXLlamaBackendError.modelPathMissing` if the directory
    ///   does not exist. ζ-iOS.2 will additionally validate
    ///   the integrity hash against the on-chain pinned table (plan §7).
    ///
    /// Cross-ref: Android `LiteRTNeuroPilotBackend(modelDir: File)` throws
    /// `IOException` on missing path; iOS uses Swift `throws` for symmetry.
    init(modelPath: URL) throws {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(
            atPath: modelPath.path,
            isDirectory: &isDir
        ), isDir.boolValue else {
            throw MLXLlamaBackendError.modelPathMissing(modelPath)
        }
        self.modelPath = modelPath
    }

    // MARK: - Generation

    /// Run a chat completion on-device.
    ///
    /// **ζ-iOS.1 scaffold:** returns a single-block placeholder. No model is
    /// loaded, no Metal kernels are dispatched, no tokens are generated.
    /// `cancel()` is honoured at entry but never observed mid-stream.
    ///
    /// Cross-ref: Android `LiteRTNeuroPilotBackend.generate(...)` returns
    /// `ApiResponse(content = listOf(ContentBlock.Text(...)), usage = Usage(...))`.
    /// ζ-iOS.0 reconciliation note: the canonical `LlmBackend.generate`
    /// signature (matching Android `xyz.ghola.app.ai.LlmBackend`) takes
    /// `(messages, tools, system, forceToolUse)`. `maxTokens` is therefore
    /// not on the protocol surface — ζ-iOS.2 will read it from a
    /// per-backend config (e.g. UserDefaults) the same way Android's
    /// LiteRTNeuroPilotBackend does.
    func generate(
        messages: [LlmMessage],
        tools: [Tool],
        system: String,
        forceToolUse: Bool
    ) async throws -> ApiResponse {
        // Reset cancellation at the start of every call so a previously
        // cancelled backend can serve fresh requests. NSLock is not safe
        // to hold across `await`, but we never do — we lock, mutate, and
        // unlock synchronously, all from the same continuation.
        resetCancellation()

        // Honour an immediate post-init cancel (paranoia; the real loop in
        // ζ-iOS.2 polls this between every decoded token).
        if isCancelled() {
            throw MLXLlamaBackendError.cancelled
        }

        // STUB. Real implementation in ζ-iOS.2:
        //   1. ensureModelLoaded() lazy-loads via LLMModelFactory
        //   2. format prompt with Llama 3.2 chat template
        //   3. stream-generate with MLXLMCommon.generate(...)
        //   4. accumulate tokens + emit Usage with input/output counts
        let placeholder = ContentBlock.text(
            "MLX backend not yet wired — ζ-iOS.1 scaffold only. " +
            "Received \(messages.count) message(s), system=\(system.isEmpty ? "<none>" : "<set>"), " +
            "tools=\(tools.count). " +
            "Real inference lands in ζ-iOS.2 against \(modelPath.lastPathComponent)."
        )
        return ApiResponse(
            contentBlocks: [placeholder],
            stopReason: "stub",
            usage: nil
        )
    }

    /// Request that the next safe point in the generate loop bail out.
    /// Idempotent. Has no effect outside a `generate(...)` call.
    ///
    /// Cross-ref: Android `LiteRTNeuroPilotBackend.cancel()` flips an
    /// `AtomicBoolean`.
    func cancel() {
        cancelLock.lock()
        _cancelled = true
        cancelLock.unlock()
    }

    /// Drop the model container reference so MLX can release Metal buffers.
    /// Subsequent `generate(...)` calls will re-load lazily (ζ-iOS.2).
    /// Idempotent.
    ///
    /// Cross-ref: Android `LiteRTNeuroPilotBackend.shutdown()` closes the
    /// LiteRT `InterpreterApi` handle.
    func shutdown() {
        modelContainer = nil
    }

    // MARK: - Helpers

    /// Test/internal accessor for the path bound at init.
    /// Not part of the LlmBackend contract.
    var resolvedModelPath: URL { modelPath }

    private func isCancelled() -> Bool {
        cancelLock.lock()
        defer { cancelLock.unlock() }
        return _cancelled
    }

    /// Reset cancellation flag. Synchronous wrapper around the lock so the
    /// caller (`generate`) never holds the lock across an `await`. This
    /// silences the Swift 6 "lock unavailable from async context" diagnostic.
    private func resetCancellation() {
        cancelLock.lock()
        _cancelled = false
        cancelLock.unlock()
    }
}

/// Errors emitted by `MLXLlamaBackend`. Distinct from
/// `LlmBackendError` so `BackendRegistry.make(for: .mlxLocal)` can
/// translate "model missing on disk" (download prompt) into a
/// `LlmBackendError.notImplemented` with a useful path hint, while
/// other failure modes flow up as-is.
enum MLXLlamaBackendError: Error, Equatable {
    /// `modelPath` does not exist or is not a directory.
    case modelPathMissing(URL)
    /// `generate(...)` aborted because `cancel()` fired.
    case cancelled
    /// Reserved for ζ-iOS.2 model-load failures.
    case modelLoadFailed(String)
}

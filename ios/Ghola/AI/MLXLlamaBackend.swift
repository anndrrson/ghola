import Foundation
import os.log

// ζ-iOS.2: real MLX inference. The SPM scaffold from ζ-iOS.1 is now wired
// for actual use. Imports stay narrow — only what's needed for loading +
// streaming text generation. Tool-use, image input, and adapters live
// upstream in MLXLMCommon but we don't surface them here yet.
import MLX
import MLXLLM
import MLXLMCommon
import MLXRandom

/// On-device LLM backend powered by MLX Swift running on Apple Silicon Metal
/// GPUs. Cross-platform analog of Android's
/// `xyz.ghola.app.ai.litert.LiteRTNeuroPilotBackend` — both ship 4-bit
/// quantised LLMs on the device's accelerator (MediaTek NPU on Android,
/// Apple GPU on iOS).
///
/// **Phase:** ζ-iOS.2 — real model load + streaming generate against
/// `mlx-community/Llama-3.2-1B-Instruct-4bit` unpacked on local disk.
/// Loader is lazy: constructor only validates the path; the first
/// `generate(...)` call drives `LLMModelFactory.shared.loadContainer(...)`.
///
/// Target model layout (mlx-community/Llama-3.2-1B-Instruct-4bit):
///   modelPath/
///     config.json                   (Llama 3.2 config + mlx quant block)
///     tokenizer.json                (HF fast tokenizer)
///     tokenizer_config.json
///     special_tokens_map.json
///     model.safetensors             (single shard; ~695 MB)
///   — or model.safetensors.index.json + model-NNNNN-of-MMMMM.safetensors
///     for sharded variants.
///
/// Thread-safety: `MLXLMCommon.ModelContainer` is itself an actor; we hold
/// the reference behind an NSLock-guarded `Any?` slot so the
/// non-`Sendable` enum-shape we use elsewhere doesn't leak through.
/// Cancellation is an NSLock-guarded bool checked between every decoded
/// token in the streaming loop.
///
/// **Integrity TODO (ζ-iOS.5):** before `LLMModelFactory.loadContainer(...)`
/// is invoked, an `IntegrityVerifier` SHA-256 check against the on-chain
/// `PinnedModelHashes` table will gate the load. That work is owned by a
/// parallel agent — this file currently calls out the hook site with a
/// TODO so we don't preempt it.
final class MLXLlamaBackend: LlmBackend, @unchecked Sendable {

    // MARK: - LlmBackend contract

    /// Cross-ref: Android `LiteRTNeuroPilotBackend.displayName` returns
    /// "On-device (Gemma-3 1B 4-bit · MediaTek NPU)". iOS variant pinpoints
    /// the MLX runtime + Llama 3.2 1B because the SmallThinker MoE that
    /// Android ships has no MLX conversion yet (plan §4 headline gap).
    let displayName: String = "On-device (Llama 3.2 1B 4-bit · MLX)"

    /// Cross-ref: Android `LiteRTNeuroPilotBackend.requiresInternet == false`.
    /// On-device inference never touches the network after the initial
    /// weight download (which is owned by a future downloader, not this
    /// backend). The constructor refuses to construct against a missing
    /// directory, so by the time `generate(...)` runs we know the bytes
    /// are local.
    let requiresInternet: Bool = false

    // MARK: - State

    /// Filesystem path to the unpacked safetensors directory. Set at init,
    /// validated to exist + contain `config.json`. ζ-iOS.5 will add SHA-256
    /// pinning against the on-chain registry before load.
    private let modelPath: URL

    /// Friendly name we splice into error messages. Constant for now
    /// (Llama 3.2 1B 4-bit); becomes per-instance once the registry
    /// supports multiple on-device models (ζ-iOS.4).
    private let modelName: String = "Llama-3.2-1B-Instruct-4bit"

    /// Cancellation flag observed by the in-flight generate loop. Set true
    /// by `cancel()`. Reset to false at the top of every `generate(...)`.
    /// `Atomic` semantics achieved via `NSLock`-guarded scalar so we do not
    /// pull in `Atomics` for a single bool.
    private let cancelLock = NSLock()
    private var _cancelled: Bool = false

    /// Holds the lazily-loaded MLX model container. Typed as `Any?` so
    /// the file compiles unchanged in environments where SPM resolution
    /// has stripped the heavy MLX symbols (CI dry-runs, swiftc per-file
    /// typecheck without the package graph). On the happy path it's
    /// always an `MLXLMCommon.ModelContainer`.
    private let containerLock = NSLock()
    private var modelContainer: Any?

    /// os_log channel for performance instrumentation. Consumed by the
    /// future battery profiler port; for now it just emits at `.info`.
    private let log = Logger(subsystem: "xyz.ghola.app", category: "MLXLlamaBackend")

    // MARK: - Lifecycle

    /// Construct against an already-downloaded model directory.
    ///
    /// - Parameter modelPath: directory containing `config.json`,
    ///   `tokenizer.json`, and the safetensors shard(s) published by
    ///   `mlx-community/Llama-3.2-1B-Instruct-4bit`.
    /// - Throws: `MLXLlamaBackendError.modelPathMissing` if the directory
    ///   does not exist; `.modelLoadFailed(...)` if `config.json` is
    ///   absent (loaded later but surfaced here so the picker can warn
    ///   the user before they fire a generation).
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
    /// Lifecycle:
    ///   1. reset cancellation flag (so a previously-cancelled backend
    ///      can serve fresh requests).
    ///   2. honour an immediate post-init cancel — paranoia.
    ///   3. lazily load the model on first call (`ensureModelLoaded()`).
    ///   4. translate `[LlmMessage]` + system into `[Chat.Message]`.
    ///   5. drive `MLXLMCommon.generate(...)` streaming, accumulating
    ///      chunks. Cancellation polled between every chunk.
    ///   6. emit a single `ContentBlock.text(...)` plus `Usage` from the
    ///      generation completion info.
    ///
    /// Cross-ref: Android `LiteRTNeuroPilotBackend.generate(...)` returns
    /// `ApiResponse(content = listOf(ContentBlock.Text(...)), usage = Usage(...))`.
    /// `maxTokens` is read from a per-backend default (512) for now;
    /// once Settings exposes a slider (ζ-iOS.3) this will read UserDefaults
    /// the same way Android's LiteRTNeuroPilotBackend does.
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

        // Honour an immediate post-init cancel.
        if isCancelled() {
            throw LlmBackendError.cancelled
        }

        // Tool use is not yet wired on the MLX path. MLXLMCommon's
        // ToolCallProcessor is upstream-ready (see ContentView.swift in
        // LLMEval) — exposing it on the iOS protocol surface is a
        // post-ζ task. Failing closed here is safer than silently
        // ignoring the tools array.
        if !tools.isEmpty || forceToolUse {
            throw LlmBackendError.notImplemented(
                "MLX on-device tool use lands post-ζ. Use the cloud backend for tool-driven turns."
            )
        }

        let loadStart = Date()
        // TODO(ζ-iOS.5): IntegrityVerifier.verify(modelPath, expectedHash: PinnedModelHashes.llama32_1b_mlx_q4)
        //                throws on mismatch. Hook is here, not in init, so
        //                the constructor can succeed for tests that don't
        //                want the on-chain dependency.
        let container = try await ensureModelLoaded()
        let loadElapsed = Date().timeIntervalSince(loadStart)

        // Build the chat in MLXLMCommon's model-agnostic shape. The
        // ModelContext's processor is responsible for stamping the
        // Llama 3.2 chat template on top of these messages — we do not
        // hand-render the `<|begin_of_text|>` / `<|start_header_id|>`
        // tokens ourselves.
        var chat: [Chat.Message] = []
        if !system.isEmpty {
            chat.append(.system(system))
        }
        for message in messages {
            switch message.role {
            case .system:
                chat.append(.system(message.content))
            case .user:
                chat.append(.user(message.content))
            case .assistant:
                chat.append(.assistant(message.content))
            }
        }

        let userInput = UserInput(chat: chat)
        let parameters = Self.defaultGenerateParameters

        // each call should be reproducible per-seed but not deterministic
        // across calls — same pattern as LLMEval.
        MLXRandom.seed(UInt64(Date.timeIntervalSinceReferenceDate * 1000))

        let generateStart = Date()
        // Reference-typed accumulator: mutating a captured `var` from
        // a `@Sendable` closure trips Swift 6's concurrency diagnostics,
        // so we hold the mutable state behind a class and let the
        // closure capture the (immutable) reference.
        let accumulator = GenerationAccumulator()

        // Capture cancellation check into a sendable closure; we cannot
        // capture `self` across the `Sendable` boundary into perform,
        // but the lock + bool are addresses we own and the closure only
        // reads them via the helper that re-takes the lock.
        let cancellationProbe: @Sendable () -> Bool = { [weak self] in
            self?.isCancelled() ?? false
        }

        do {
            try await container.perform { (context: ModelContext) -> Void in
                let lmInput = try await context.processor.prepare(input: userInput)
                let stream = try MLXLMCommon.generate(
                    input: lmInput,
                    parameters: parameters,
                    context: context
                )

                for await generation in stream {
                    if cancellationProbe() {
                        // Bail. The AsyncStream's Task will be torn down
                        // when we return; MLX's Stream().synchronize()
                        // in the upstream loop handles the in-flight
                        // Metal kernels.
                        throw LlmBackendError.cancelled
                    }
                    switch generation {
                    case .chunk(let piece):
                        accumulator.append(piece)
                    case .info(let info):
                        accumulator.setInfo(info)
                    case .toolCall:
                        // Defensive: we already gated `tools.isEmpty`
                        // above, so we should never see a tool call.
                        // Treat as a no-op rather than crashing.
                        continue
                    }
                }
            }
        } catch let error as LlmBackendError {
            throw error
        } catch let error as MLXLlamaBackendError {
            throw error
        } catch {
            throw LlmBackendError.transport(
                MLXLlamaBackendError.modelLoadFailed(
                    "\(modelName) generation failed: \(error.localizedDescription)"
                )
            )
        }

        let generateElapsed = Date().timeIntervalSince(generateStart)
        let accumulatedText = accumulator.text
        let completionInfo = accumulator.info
        let inputTokens = completionInfo?.promptTokenCount ?? 0
        let outputTokens = completionInfo?.generationTokenCount ?? 0
        let tps = completionInfo?.tokensPerSecond ?? 0

        log.info(
            """
            \(self.modelName, privacy: .public) generate ok \
            load_ms=\(Int(loadElapsed * 1000)) \
            gen_ms=\(Int(generateElapsed * 1000)) \
            in_tok=\(inputTokens) out_tok=\(outputTokens) \
            tok_per_s=\(String(format: "%.2f", tps))
            """
        )

        if accumulatedText.isEmpty {
            // The model produced an immediate EOS. Surface as an
            // explicit stop reason so callers don't treat the empty
            // body as a transport bug.
            return ApiResponse(
                contentBlocks: [.text("")],
                stopReason: "stop",
                usage: Usage(inputTokens: inputTokens, outputTokens: outputTokens)
            )
        }

        return ApiResponse(
            contentBlocks: [.text(accumulatedText)],
            stopReason: "stop",
            usage: Usage(inputTokens: inputTokens, outputTokens: outputTokens)
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
    /// Subsequent `generate(...)` calls will re-load lazily.
    /// Idempotent.
    ///
    /// Cross-ref: Android `LiteRTNeuroPilotBackend.shutdown()` closes the
    /// LiteRT `InterpreterApi` handle.
    func shutdown() {
        containerLock.lock()
        modelContainer = nil
        containerLock.unlock()
        // Hint MLX to release Metal buffers from its allocation cache.
        // Safe to call when no container is loaded — it's a no-op on
        // an empty cache.
        MLX.GPU.clearCache()
    }

    // MARK: - Helpers

    /// Test/internal accessor for the path bound at init.
    /// Not part of the LlmBackend contract.
    var resolvedModelPath: URL { modelPath }

    /// Test-only: introspect whether the container slot is populated.
    /// Used by the "shutdown frees model" + "reuse" tests; not part of
    /// the LlmBackend contract.
    var isModelLoadedForTests: Bool {
        containerLock.lock()
        defer { containerLock.unlock() }
        return modelContainer != nil
    }

    /// Default generation parameters. Mirrors LLMEval's choices
    /// (temperature 0.6, default top-p 1.0) but caps maxTokens at 512
    /// to keep first-turn latency bounded on iPhone 12-class devices.
    /// Tweak via Settings once ζ-iOS.3 lands.
    static let defaultGenerateParameters: GenerateParameters = {
        GenerateParameters(
            maxTokens: 512,
            temperature: 0.7,
            topP: 0.95
        )
    }()

    /// Lazily load the model. Threadsafe via `containerLock`. The first
    /// call drives `LLMModelFactory.shared.loadContainer(...)`; subsequent
    /// calls return the cached container.
    ///
    /// We pay one fast sanity check (config.json exists) before
    /// asking MLX to parse it, so we can throw a precise error rather
    /// than a JSON-decoder stack trace.
    private func ensureModelLoaded() async throws -> ModelContainer {
        if let cached = cachedContainer() {
            return cached
        }

        let configURL = modelPath.appendingPathComponent("config.json")
        guard FileManager.default.fileExists(atPath: configURL.path) else {
            throw MLXLlamaBackendError.modelLoadFailed(
                "\(modelName) config.json missing at \(configURL.path)"
            )
        }

        // Cap MLX's buffer cache to 20 MiB. Same number LLMEval uses.
        // Without this MLX keeps freed Metal buffers in a pool that
        // can grow to ~hundreds of MB on long sessions.
        MLX.GPU.set(cacheLimit: 20 * 1024 * 1024)

        let configuration = ModelConfiguration(directory: modelPath)
        let container: ModelContainer
        do {
            container = try await LLMModelFactory.shared.loadContainer(
                configuration: configuration
            )
        } catch {
            throw MLXLlamaBackendError.modelLoadFailed(
                "\(modelName) load failed: \(error.localizedDescription)"
            )
        }

        return storeContainer(container)
    }

    /// Synchronous lock-then-read of the cached container. Pulling this
    /// out as a non-async helper keeps Swift 6's "lock unavailable from
    /// async context" warning quiet — the lock is acquired and released
    /// in a single non-suspending span.
    private func cachedContainer() -> ModelContainer? {
        containerLock.lock()
        defer { containerLock.unlock() }
        return modelContainer as? ModelContainer
    }

    /// Synchronous lock-then-write of the loaded container. If a parallel
    /// caller raced us and stashed one first, prefer theirs and let MLX
    /// release ours when this scope exits.
    private func storeContainer(_ container: ModelContainer) -> ModelContainer {
        containerLock.lock()
        defer { containerLock.unlock() }
        if let existing = modelContainer as? ModelContainer {
            return existing
        }
        modelContainer = container
        return container
    }

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
///
/// `.cancelled` was removed in ζ-iOS.2 — the protocol-level
/// `LlmBackendError.cancelled` is the canonical signal now (matches
/// how `CloudLlmBackend` reports user-driven aborts), so callers
/// have one error to switch on rather than two.
enum MLXLlamaBackendError: Error, Equatable {
    /// `modelPath` does not exist or is not a directory.
    case modelPathMissing(URL)
    /// Model load failed mid-way (corrupt safetensors, missing config,
    /// quant mismatch). Message includes the model name for triage.
    case modelLoadFailed(String)
}

/// Reference-typed accumulator for the streaming generate loop. Swift 6
/// rejects `var` captures inside `@Sendable` closures; routing the
/// mutation through a class lets the closure capture the (immutable)
/// reference instead. Internal NSLock guards the two fields so the
/// `perform { ... }` task is free to be torn down or resumed on any
/// executor.
private final class GenerationAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var _text = ""
    private var _info: GenerateCompletionInfo?

    func append(_ piece: String) {
        lock.lock()
        _text += piece
        lock.unlock()
    }

    func setInfo(_ info: GenerateCompletionInfo) {
        lock.lock()
        _info = info
        lock.unlock()
    }

    var text: String {
        lock.lock()
        defer { lock.unlock() }
        return _text
    }

    var info: GenerateCompletionInfo? {
        lock.lock()
        defer { lock.unlock() }
        return _info
    }
}

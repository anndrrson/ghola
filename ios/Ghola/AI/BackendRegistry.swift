import Foundation

/// Modes that the user can pick for chat. Add new cases here when new
/// backends land. The string raw value is also used as the persisted
/// UserDefaults value for the user's preference.
public enum BackendMode: String, CaseIterable, Sendable {
    case cloud
    case mlxLocal
}

/// Central factory for `LlmBackend` instances.
///
/// The iOS side follows the same pattern as Android's
/// `AgentController.makeBackend(...)` — one place that turns a mode
/// enum into a concrete backend, so the rest of the app never knows
/// which backend it's talking to.
public enum BackendRegistry {

    /// Build a backend for the given mode.
    ///
    /// - Parameter mode: which backend the caller wants.
    /// - Throws: `LlmBackendError.notImplemented` for cases that are
    ///   reserved but not yet wired (currently `.mlxLocal`).
    public static func make(for mode: BackendMode) throws -> LlmBackend {
        switch mode {
        case .cloud:
            return CloudLlmBackend()
        case .mlxLocal:
            // Phase ζ-iOS.1 (MLX scaffold). The SPM dependency is wired
            // and `MLXLlamaBackend` exists, but `generate(...)` is still
            // a stub returning a placeholder ContentBlock — real
            // inference lands in ζ-iOS.2. If the model weights have not
            // been downloaded to disk yet, surface that as
            // `LlmBackendError.notImplemented` so the chat UI shows a
            // useful hint instead of a crashy IO error.
            guard isMLXBackendEnabled else {
                throw LlmBackendError.notImplemented(
                    "MLX local backend is gated off (isMLXBackendEnabled=false)."
                )
            }
            let path = defaultMLXModelPath()
            do {
                return try MLXLlamaBackend(modelPath: path)
            } catch MLXLlamaBackendError.modelPathMissing(let url) {
                throw LlmBackendError.notImplemented(
                    "MLX model not yet downloaded — expected at \(url.path). " +
                    "Run the model download flow (ζ-iOS.2)."
                )
            }
        }
    }

    /// The mode the app boots into when the user hasn't picked one.
    /// Cloud is the only working backend today.
    public static let defaultMode: BackendMode = .cloud

    // MARK: - MLX feature flag (ζ-iOS.1)

    /// Gate for the on-device MLX backend in chat UI. Flip to `false` to
    /// hide the option entirely (e.g. App Store hot-fix if the entitlement
    /// is denied or the runtime regresses). Defaults to `true` so the
    /// scaffold is reachable in dev builds.
    public static let isMLXBackendEnabled: Bool = true

    /// Default on-disk location for the MLX safetensors directory. Lives
    /// under Application Support so iOS does not purge it like Caches.
    /// ζ-iOS.2 owns the downloader that populates this path.
    public static func defaultMLXModelPath() -> URL {
        let support = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return support
            .appendingPathComponent("ghola", isDirectory: true)
            .appendingPathComponent("mlx", isDirectory: true)
            .appendingPathComponent("llama-3.2-1b-instruct-4bit", isDirectory: true)
    }
}

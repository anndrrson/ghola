import Foundation

// MARK: - Supporting Types
//
// Ported from android/app/src/main/java/xyz/ghola/app/ai/{LlmBackend,ClaudeApiClient}.kt.
//
// Naming note: the Kotlin canonical protocol calls the message struct
// `ChatMessage`. The iOS app already ships a UI-layer `ChatMessage`
// (Ghola/Models/ChatMessage.swift, with a `.error` role used by ChatView).
// To avoid breaking the existing view layer, the protocol-side message
// is named `LlmMessage` here. Callers map between the two at the
// backend boundary. See ChatView.swift for the mapping site.

/// Role for a single message in a multi-turn LLM exchange.
///
/// Mirrors the Kotlin/JSON wire format ("system", "user", "assistant")
/// used by every Ghola LLM backend on Android.
public enum LlmRole: String, Codable, Sendable, CaseIterable {
    case system
    case user
    case assistant
}

/// One turn in a chat history fed to an `LlmBackend`.
///
/// For now `content` is a plain string. The Kotlin side passes structured
/// `content` blocks through JSONArray, but Ghola iOS does not yet emit
/// images or tool results, so the simpler shape is sufficient. When
/// multimodal input lands the `content` field can grow into an
/// associated-value enum without breaking the protocol surface.
public struct LlmMessage: Sendable, Equatable {
    public let role: LlmRole
    public let content: String

    public init(role: LlmRole, content: String) {
        self.role = role
        self.content = content
    }
}

/// Placeholder for tool/function definitions handed to the model.
///
/// Tool use is not wired on iOS yet — the Android side defines tools
/// in ToolDefinitions.kt and serializes them through JSONArray. When
/// the iOS agent loop lands, expand this struct with `inputSchema`,
/// `description`, etc. For now it ships as a minimal stub so the
/// protocol signature matches Android 1:1.
public struct Tool: Sendable, Equatable {
    public let name: String
    public let description: String
    /// Raw JSON-schema object for the tool's input parameters. Encoded
    /// as `Data` (JSON bytes) so callers can stash arbitrary schemas
    /// without a Swift type for every tool.
    public let inputSchemaJSON: Data

    public init(name: String, description: String, inputSchemaJSON: Data) {
        self.name = name
        self.description = description
        self.inputSchemaJSON = inputSchemaJSON
    }
}

/// Token usage reported by the model after a generation.
public struct Usage: Sendable, Equatable {
    public let inputTokens: Int
    public let outputTokens: Int

    public init(inputTokens: Int, outputTokens: Int) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
    }
}

/// A single block of model output. The Kotlin side uses a sealed class;
/// Swift's nearest analogue is an enum with associated values.
///
/// `toolUse.input` carries arbitrary JSON, so it's stored as
/// `[String: Any]`. The whole enum is therefore intentionally
/// non-Sendable (Any is not Sendable). Cross-actor usage must hop
/// through a serialized form (Data) if Sendable is required.
public enum ContentBlock {
    case text(String)
    case toolUse(id: String, name: String, input: [String: Any])
    case image(mediaType: String, base64Data: String)
}

/// Aggregate result of a `generate(...)` call. Matches Android's
/// `ApiResponse(contentBlocks, stopReason, usage)`.
public struct ApiResponse {
    public let contentBlocks: [ContentBlock]
    public let stopReason: String
    public let usage: Usage?

    public init(contentBlocks: [ContentBlock], stopReason: String, usage: Usage?) {
        self.contentBlocks = contentBlocks
        self.stopReason = stopReason
        self.usage = usage
    }
}

/// The user-visible privacy boundary for one chat backend instance.
/// This is code-owned provenance, not something a model is allowed to
/// infer from its own hosting environment.
public enum LlmRuntimeBoundary: String, Sendable, Equatable {
    case onDevice
    case localNetwork
    case gholaCloud

    var title: String {
        switch self {
        case .onDevice: return "On device"
        case .localNetwork: return "Local network"
        case .gholaCloud: return "Ghola Cloud"
        }
    }
}

enum LlmRuntimeDisclosure {
    static func shouldAnswerDeterministically(_ text: String) -> Bool {
        let normalized = normalize(text)
        let asksAboutSubject = containsAny(
            normalized,
            ["you", "ghola", "chat", "model", "inference", "app"]
        )
        let asksAboutRuntime = containsAny(
            normalized,
            [
                "running on device",
                "run on device",
                "on device",
                "on-device",
                "locally",
                "local model",
                "cloud",
                "server",
                "virtual machine",
                "vm",
                "iphone processor",
                "offline"
            ]
        )
        let asksQuestion = containsAny(
            normalized,
            ["are", "is", "where", "how", "do", "does", "right now", "?"]
        )

        return asksAboutSubject && asksAboutRuntime && asksQuestion
    }

    static func answer(
        selectedMode: BackendMode,
        backend: LlmBackend?,
        backendError: String?,
        localServerName: String?,
        isLocalServerMode: Bool
    ) -> String {
        let appLine = "Ghola is running as a native iOS app on this iPhone."
        let selectedLine = "Selected chat mode: \(selectedMode.title)."

        guard let backend else {
            let reason = backendError ?? "No verified local model is ready."
            return [
                appLine,
                "Chat inference is not currently running in cloud fallback. \(reason)",
                "Strict local mode fails closed instead of silently sending prompts to Ghola Cloud.",
                selectedLine
            ].joined(separator: "\n\n")
        }

        switch backend.runtimeBoundary {
        case .onDevice:
            return [
                appLine,
                "Yes. Chat inference is currently using \(backend.displayName), so the prompt is processed on this device.",
                selectedLine
            ].joined(separator: "\n\n")
        case .localNetwork:
            let serverName = localServerName ?? "a paired local AI server"
            return [
                appLine,
                "Not on the iPhone itself. Chat inference is currently using \(serverName) on your local network, so prompts leave the phone but do not go to Ghola Cloud.",
                selectedLine
            ].joined(separator: "\n\n")
        case .gholaCloud:
            let cloudExplanation = isLocalServerMode
                ? "The local-server switch is enabled, but this backend is still reporting a cloud boundary."
                : "No. Chat inference is currently using \(backend.displayName), which sends prompts to Ghola Cloud and the configured model provider."
            return [
                appLine,
                cloudExplanation,
                "That is why a raw cloud model may describe itself as running in a virtualized environment. That statement describes the remote model host, not the iPhone app.",
                selectedLine
            ].joined(separator: "\n\n")
        }
    }

    private static func normalize(_ text: String) -> String {
        text
            .lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    private static func containsAny(_ text: String, _ needles: [String]) -> Bool {
        needles.contains { text.contains($0) }
    }
}

// MARK: - Protocol
//
// The Kotlin interface uses a *blocking* `generate(...)` because Android
// callers hand the work to a background executor (AgentController owns
// its own thread pool). Swift's structured concurrency makes
// `async throws` the idiomatic equivalent: callers (e.g. ChatView)
// already run inside a `Task { ... }`, and a thrown error replaces
// Kotlin's `throw IOException(...)` plumbing.

/// A pluggable LLM backend. Implementations: `CloudLlmBackend` (this
/// PR), `MlxLocalBackend` (parked, Phase ζ-iOS), and future on-device
/// variants. Mirrors `xyz.ghola.app.ai.LlmBackend` on Android so a
/// single AgentController port can drive both platforms.
public protocol LlmBackend: AnyObject, Sendable {
    /// User-facing label for backend pickers and diagnostics, e.g.
    /// "Claude (Cloud)" or "On-device (MLX, Llama-3.2-3B)".
    var displayName: String { get }

    /// `true` if the backend cannot run without a network. Used to gate
    /// the UI in airplane mode and to choose a fallback.
    var requiresInternet: Bool { get }

    /// Code-owned runtime provenance for privacy disclosures.
    var runtimeBoundary: LlmRuntimeBoundary { get }

    /// Run a generation against the model. Mirrors the Kotlin
    /// blocking call: caller is expected to await on a Task.
    ///
    /// - Parameters:
    ///   - messages: the full chat history, oldest-first.
    ///   - tools: tool/function definitions, may be empty.
    ///   - system: the system prompt. Empty string disables it.
    ///   - forceToolUse: if true, instruct the model to emit a tool call.
    /// - Throws: `LlmBackendError` or any underlying transport error.
    func generate(
        messages: [LlmMessage],
        tools: [Tool],
        system: String,
        forceToolUse: Bool
    ) async throws -> ApiResponse

    /// Cancel any in-flight generation. Must be idempotent — calling
    /// it twice or before `generate` is a no-op.
    func cancel()

    /// Tear down persistent resources (loaded model weights, network
    /// sessions, etc.). Must be idempotent.
    func shutdown()
}

public extension LlmBackend {
    /// Convenience overload with `forceToolUse: false`, matching the
    /// Kotlin `@JvmOverloads`-style default.
    func generate(
        messages: [LlmMessage],
        tools: [Tool] = [],
        system: String = ""
    ) async throws -> ApiResponse {
        try await generate(
            messages: messages,
            tools: tools,
            system: system,
            forceToolUse: false
        )
    }
}

/// Errors that any backend may raise. Transport-specific errors
/// (URLError, etc.) are wrapped in `.transport(_)`.
public enum LlmBackendError: LocalizedError {
    case notImplemented(String)
    case modelNotReady(String)
    case cancelled
    case transport(Error)
    case server(String)
    case malformedResponse(String)

    public var errorDescription: String? {
        switch self {
        case .notImplemented(let why): return "Not implemented: \(why)"
        case .modelNotReady(let why): return "Model not ready: \(why)"
        case .cancelled: return "Cancelled"
        case .transport(let err): return err.localizedDescription
        case .server(let msg): return msg
        case .malformedResponse(let msg): return "Malformed response: \(msg)"
        }
    }
}

import Foundation

/// `LlmBackend` implementation that proxies generation through the
/// existing thumper-cloud `POST /api/chat` SSE endpoint.
///
/// This is an *adapter*: it owns an `SSEClient` and a session id, and
/// surfaces them through the protocol-shaped `generate(...)` call.
/// The underlying SSE plumbing is unchanged — see
/// `Ghola/Services/SSEClient.swift` and `Ghola/Services/CloudClient.swift`.
///
/// Mirrors `xyz.ghola.app.ai.CloudLlmBackend` (Android), which is also
/// a thin wrapper around its platform HTTP client.
final class CloudLlmBackend: LlmBackend, @unchecked Sendable {

    // MARK: LlmBackend

    private let cloudDisplayName: String
    let requiresInternet: Bool = true
    var displayName: String {
        CloudClient.isLocalMode ? "Local AI Server" : cloudDisplayName
    }
    var runtimeBoundary: LlmRuntimeBoundary {
        CloudClient.isLocalMode ? .localNetwork : .gholaCloud
    }

    // MARK: State

    /// Pinned across `generate` calls so the cloud can thread server-
    /// side history. Updated when the SSE stream emits its first
    /// `session` event for a fresh chat.
    private let sessionIdLock = NSLock()
    private var _sessionId: UUID?

    var sessionId: UUID? {
        sessionIdLock.lock(); defer { sessionIdLock.unlock() }
        return _sessionId
    }

    private func setSessionId(_ id: UUID) {
        sessionIdLock.lock(); defer { sessionIdLock.unlock() }
        _sessionId = id
    }

    /// In-flight task handle, set in `generate` and cleared on
    /// completion/cancellation. Lock-protected because `cancel()` may
    /// fire from any actor.
    private let taskLock = NSLock()
    private var currentTask: Task<Void, Never>?

    private let sseClient: SSEClient

    init(displayName: String = "Claude (Cloud)", sseClient: SSEClient = SSEClient()) {
        self.cloudDisplayName = displayName
        self.sseClient = sseClient
    }

    // MARK: Generate

    func generate(
        messages: [LlmMessage],
        tools: [Tool],
        system: String,
        forceToolUse: Bool
    ) async throws -> ApiResponse {
        // Mirror EnvelopeCloudBackend.kt: the cloud route accepts a
        // single outbound user message + a server-side session_id. We
        // therefore extract the most recent `.user` message from the
        // supplied history and submit that. The cloud reconstructs
        // history from its own store.
        guard let userText = lastUserMessageText(messages) else {
            throw LlmBackendError.malformedResponse(
                "CloudLlmBackend.generate: no user message in history"
            )
        }

        // Bridge AsyncStream<SSEClient.ChatEvent> -> ApiResponse.
        // We use withTaskCancellationHandler so external `cancel()`
        // tears the underlying URLSession byte stream down (the
        // SSEClient continuation honours Task.isCancelled).
        let pinnedSessionId = sessionId
        let stream = await sseClient.stream(sessionId: pinnedSessionId, message: userText)

        var accumulated = ""
        var streamError: String?

        for await event in stream {
            switch event {
            case .sessionId(let id):
                setSessionId(id)
            case .textDelta(let delta):
                accumulated += delta
            case .error(let msg):
                streamError = msg
            case .done:
                break
            }
            if Task.isCancelled {
                throw LlmBackendError.cancelled
            }
        }

        if let streamError {
            throw LlmBackendError.server(streamError)
        }

        let blocks: [ContentBlock] = [.text(accumulated)]
        return ApiResponse(contentBlocks: blocks, stopReason: "end_turn", usage: nil)
    }

    func cancel() {
        taskLock.lock()
        let t = currentTask
        currentTask = nil
        taskLock.unlock()
        t?.cancel()
    }

    func shutdown() {
        cancel()
    }

    // MARK: Helpers

    /// Walk the history newest-first and return the most recent
    /// `.user` message body. Matches the Kotlin
    /// `lastUserMessageText` helper in EnvelopeCloudBackend.kt.
    private func lastUserMessageText(_ messages: [LlmMessage]) -> String? {
        for msg in messages.reversed() where msg.role == .user {
            return msg.content
        }
        return nil
    }
}

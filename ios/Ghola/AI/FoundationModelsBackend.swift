import Foundation

#if canImport(FoundationModels) && !os(tvOS) && !os(watchOS)
import FoundationModels
#endif

/// On-device LLM backend backed by Apple's Foundation Models framework.
///
/// The framework is only present in newer Apple SDKs and only runs on
/// eligible devices with Apple Intelligence enabled, so every use of the
/// public API is guarded by both `canImport(FoundationModels)` and runtime
/// availability checks. Older SDKs still compile this file; they get a
/// backend that reports a precise `.notImplemented` error.
final class FoundationModelsBackend: LlmBackend, @unchecked Sendable {

    let displayName: String = "System on-device model"
    let requiresInternet: Bool = false
    let runtimeBoundary: LlmRuntimeBoundary = .onDevice

    private let taskLock = NSLock()
    private var currentTask: InFlightGeneration?

    static var isAvailable: Bool {
        #if canImport(FoundationModels) && !os(tvOS) && !os(watchOS)
        if #available(iOS 26.0, macOS 26.0, visionOS 26.0, *) {
            return SystemLanguageModel.default.isAvailable
        }
        #endif
        return false
    }

    static var availabilityDescription: String {
        #if canImport(FoundationModels) && !os(tvOS) && !os(watchOS)
        if #available(iOS 26.0, macOS 26.0, visionOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return "System on-device model is available."
            case .unavailable(let reason):
                return "System on-device model unavailable: \(reason.description)."
            @unknown default:
                return "System on-device model is unavailable."
            }
        }
        #endif
        return "System on-device model requires iOS 26, macOS 26, or visionOS 26."
    }

    func generate(
        messages: [LlmMessage],
        tools: [Tool],
        system: String,
        forceToolUse: Bool
    ) async throws -> ApiResponse {
        if !tools.isEmpty || forceToolUse {
            throw LlmBackendError.notImplemented(
                "System on-device tool use is not wired to Ghola's Tool schema yet."
            )
        }

        let prompt = Self.prompt(from: messages)
        guard !prompt.isEmpty else {
            throw LlmBackendError.malformedResponse(
                "SystemOnDeviceBackend.generate: no promptable chat messages"
            )
        }

        let task = Task<String, Error> {
            try Task.checkCancellation()
            return try await Self.respond(prompt: prompt, system: system)
        }

        let inFlight = InFlightGeneration(task: task)
        storeTask(inFlight)

        do {
            let text = try await task.value
            clearTask(inFlight)
            return ApiResponse(
                contentBlocks: [.text(text)],
                stopReason: "stop",
                usage: nil
            )
        } catch is CancellationError {
            clearTask(inFlight)
            throw LlmBackendError.cancelled
        } catch let error as LlmBackendError {
            clearTask(inFlight)
            throw error
        } catch {
            clearTask(inFlight)
            throw LlmBackendError.transport(error)
        }
    }

    func cancel() {
        taskLock.lock()
        let task = currentTask?.task
        currentTask = nil
        taskLock.unlock()
        task?.cancel()
    }

    func shutdown() {
        cancel()
    }

    private func storeTask(_ task: InFlightGeneration) {
        taskLock.lock()
        currentTask?.task.cancel()
        currentTask = task
        taskLock.unlock()
    }

    private func clearTask(_ task: InFlightGeneration) {
        taskLock.lock()
        if currentTask === task {
            currentTask = nil
        }
        taskLock.unlock()
    }

    private static func prompt(from messages: [LlmMessage]) -> String {
        messages
            .filter { $0.role != .system }
            .map { message in
                switch message.role {
                case .system:
                    return ""
                case .user:
                    return "User:\n\(message.content)"
                case .assistant:
                    return "Assistant:\n\(message.content)"
                }
            }
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
    }

    private static func unavailable(_ reason: String) -> LlmBackendError {
        .notImplemented("System on-device model unavailable: \(reason)")
    }
}

private final class InFlightGeneration: @unchecked Sendable {
    let task: Task<String, Error>

    init(task: Task<String, Error>) {
        self.task = task
    }
}

#if canImport(FoundationModels) && !os(tvOS) && !os(watchOS)
@available(iOS 26.0, macOS 26.0, visionOS 26.0, *)
private extension FoundationModelsBackend {
    static let defaultOptions = GenerationOptions(
        sampling: .greedy,
        temperature: nil,
        maximumResponseTokens: 512
    )

    static func makeSession(system: String) throws -> LanguageModelSession {
        let model = SystemLanguageModel.default
        switch model.availability {
        case .available:
            break
        case .unavailable(let reason):
            throw unavailable(reason.description)
        }

        if system.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return LanguageModelSession(model: model)
        }
        return LanguageModelSession(model: model, instructions: system)
    }
}

private extension FoundationModelsBackend {
    static func respond(prompt: String, system: String) async throws -> String {
        guard #available(iOS 26.0, macOS 26.0, visionOS 26.0, *) else {
            throw unavailable("requires iOS 26, macOS 26, or visionOS 26 at runtime")
        }

        let session = try makeSession(system: system)
        let response = try await session.respond(to: prompt, options: defaultOptions)
        return response.content
    }
}

@available(iOS 26.0, macOS 26.0, visionOS 26.0, *)
private extension SystemLanguageModel.Availability.UnavailableReason {
    var description: String {
        switch self {
        case .deviceNotEligible:
            return "device is not eligible"
        case .appleIntelligenceNotEnabled:
            return "Apple Intelligence is not enabled"
        case .modelNotReady:
            return "model assets are not ready"
        @unknown default:
            return "unknown reason"
        }
    }
}
#else
private extension FoundationModelsBackend {
    static func respond(prompt: String, system: String) async throws -> String {
        throw unavailable("framework is not present in this SDK")
    }
}
#endif

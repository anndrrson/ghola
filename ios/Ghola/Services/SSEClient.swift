import Foundation

/// Parses Server-Sent Events from an HTTP response stream.
actor SSEClient {
    enum ChatEvent {
        case sessionId(UUID)
        case textDelta(String)
        case error(String)
        case done
    }

    /// Stream chat events from the /api/chat endpoint.
    func stream(sessionId: UUID?, message: String) -> AsyncStream<ChatEvent> {
        AsyncStream { continuation in
            let task = Task {
                do {
                    let request = try await CloudClient.shared.chatSSERequest(
                        sessionId: sessionId,
                        message: message
                    )

                    let (bytes, response) = try await URLSession.shared.bytes(for: request)

                    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                        // Try to parse JSON error body for a better message
                        var errorMsg = "Server returned \(code)"
                        var bodyData = Data()
                        for try await byte in bytes {
                            bodyData.append(byte)
                            if bodyData.count > 4096 { break }
                        }
                        if let json = try? JSONSerialization.jsonObject(with: bodyData) as? [String: Any],
                           let serverError = json["error"] as? String {
                            errorMsg = serverError
                        }
                        continuation.yield(.error(errorMsg))
                        continuation.finish()
                        return
                    }

                    var buffer = ""

                    for try await line in bytes.lines {
                        if line.isEmpty {
                            // End of event block
                            if let event = parseEvent(buffer) {
                                continuation.yield(event)
                                if case .done = event { break }
                            }
                            buffer = ""
                        } else {
                            if !buffer.isEmpty { buffer += "\n" }
                            buffer += line
                        }
                    }

                    continuation.finish()
                } catch {
                    if !Task.isCancelled {
                        continuation.yield(.error(error.localizedDescription))
                    }
                    continuation.finish()
                }
            }

            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    private func parseEvent(_ block: String) -> ChatEvent? {
        var eventType = ""
        var data = ""

        for line in block.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(line)
            if line.hasPrefix("event: ") {
                eventType = String(line.dropFirst(7))
            } else if line.hasPrefix("data: ") {
                data = String(line.dropFirst(6))
            }
        }

        guard !data.isEmpty else { return nil }

        switch eventType {
        case "session":
            if let json = try? JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any],
               let idStr = json["session_id"] as? String,
               let uuid = UUID(uuidString: idStr) {
                return .sessionId(uuid)
            }
        case "text_delta":
            if let json = try? JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any],
               let text = json["text"] as? String {
                return .textDelta(text)
            }
        case "error":
            if let json = try? JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any],
               let msg = json["error"] as? String {
                return .error(msg)
            }
        case "done":
            return .done
        default:
            break
        }

        return nil
    }
}

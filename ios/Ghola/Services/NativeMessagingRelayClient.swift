import Foundation

final class NativeMessagingRelayClient: @unchecked Sendable {
    static let shared = NativeMessagingRelayClient()
    static let defaultRelayURL = "https://thumper-cloud.onrender.com"

    private let session: URLSession
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            if let date = NativeMessagingRelayClient.iso8601WithFractional.date(from: raw)
                ?? NativeMessagingRelayClient.iso8601.date(from: raw) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid RFC3339 date: \(raw)"
            )
        }
        return decoder
    }()
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(NativeMessagingRelayClient.iso8601WithFractional.string(from: date))
        }
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    private static let iso8601WithFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    init(session: URLSession = .shared) {
        self.session = session
    }

    func publishDeviceKeys(identity: NativeMessagingIdentity) async throws {
        let _: RegisterDeviceResponse = try await post(
            "/api/messages/devices",
            body: identity.keyBundle
        )
    }

    func fetchDeviceKeys(for did: String) async throws -> [NativeMessagingDeviceKey] {
        let response: PrekeysResponse = try await get("/api/messages/prekeys/\(urlEncodePath(did))")
        return response.devices.map(\.deviceKey)
    }

    func send(_ envelope: NativeMessageEnvelope) async throws -> NativeMessageSendReceipt {
        let response: PostEnvelopeResponse = try await post(
            "/api/messages/envelopes",
            body: PostEnvelopeRequest(envelope: envelope)
        )
        return NativeMessageSendReceipt(
            relayMessageId: response.messageId,
            acceptedAt: response.queuedAt
        )
    }

    func inbox(limit: Int = 50) async throws -> [NativeMessageInboxItem] {
        let response: [SyncEnvelopeResponse] = try await get("/api/messages/sync?limit=\(max(1, min(limit, 100)))")
        return response.map { item in
            NativeMessageInboxItem(
                relayMessageId: item.messageId,
                envelope: item.envelope
            )
        }
    }

    func acknowledge(relayMessageId: UUID) async throws {
        let _: AckResponse = try await post(
            "/api/messages/\(relayMessageId.uuidString)/ack",
            body: EmptyBody()
        )
    }

    func block(senderDID: String) async throws {
        let _: BlockSenderResponse = try await post(
            "/api/messages/block",
            body: BlockSenderRequest(senderDID: senderDID)
        )
    }

    func reportAbuse(messageId: UUID?, senderDID: String?, reason: String, ciphertextMetadata: [String: String]) async throws -> UUID {
        let response: ReportAbuseResponse = try await post(
            "/api/messages/report",
            body: ReportAbuseRequest(
                messageId: messageId,
                senderDID: senderDID,
                reason: reason,
                ciphertextMetadata: ciphertextMetadata
            )
        )
        return response.reportId
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let request = try makeRequest(path: path, method: "GET")
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(T.self, from: data)
    }

    private func post<T: Decodable, Body: Encodable>(_ path: String, body: Body) async throws -> T {
        let encoded = try encoder.encode(body)
        try validateNoPlaintext(encoded)
        var request = try makeRequest(path: path, method: "POST")
        request.httpBody = encoded
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(T.self, from: data)
    }

    private func makeRequest(path: String, method: String) throws -> URLRequest {
        do {
            try PrivacyGate.authorize(scope: .nativeMessagingRelay)
        } catch {
            throw NativeMessagingError.privacyBlocked(error.localizedDescription)
        }
        guard let token = KeychainHelper.loadString("jwt_token") else {
            throw NativeMessagingError.unauthorized
        }
        guard let url = URL(string: "\(Self.defaultRelayURL)\(path)") else {
            throw NativeMessagingError.invalidResponse
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func validate(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw NativeMessagingError.invalidResponse
        }
        switch http.statusCode {
        case 200..<300:
            return
        case 401:
            throw NativeMessagingError.unauthorized
        default:
            let body = String(data: data, encoding: .utf8) ?? "unknown"
            throw NativeMessagingError.server(http.statusCode, body)
        }
    }

    private func validateNoPlaintext(_ data: Data) throws {
        let object = try JSONSerialization.jsonObject(with: data)
        try validateNoPlaintext(object)
    }

    private func validateNoPlaintext(_ value: Any) throws {
        if let dictionary = value as? [String: Any] {
            for (key, nested) in dictionary {
                let normalized = key.lowercased()
                if normalized == "body"
                    || normalized == "content"
                    || normalized == "plaintext"
                    || normalized == "subject"
                    || normalized == "text"
                    || normalized == "approval_nonce" {
                    throw NativeMessagingError.encryptionFailed
                }
                try validateNoPlaintext(nested)
            }
        } else if let array = value as? [Any] {
            for nested in array {
                try validateNoPlaintext(nested)
            }
        }
    }

    private func urlEncodePath(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}

private struct RegisterDeviceResponse: Codable {
    let ok: Bool
    let userDID: String
    let deviceId: String
    let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case ok
        case userDID = "user_did"
        case deviceId = "device_id"
        case updatedAt = "updated_at"
    }
}

private struct PrekeysResponse: Codable {
    let userDID: String
    let devices: [DeviceKeyBundleV1]

    enum CodingKeys: String, CodingKey {
        case userDID = "user_did"
        case devices
    }
}

private struct PostEnvelopeRequest: Codable {
    let messageId: UUID
    let threadId: UUID
    let senderDID: String
    let senderDeviceId: String
    let recipientDID: String
    let recipientDeviceId: String?
    let kind: NativeMessageKind
    let sealedEnvelopeBase64: String
    let approvalReceiptHash: String?

    init(envelope: NativeMessageEnvelope) {
        self.messageId = envelope.id
        self.threadId = envelope.threadId
        self.senderDID = envelope.senderDID
        self.senderDeviceId = envelope.senderDeviceId
        self.recipientDID = envelope.recipientDID
        self.recipientDeviceId = envelope.recipientDeviceId
        self.kind = envelope.kind
        self.sealedEnvelopeBase64 = envelope.sealedEnvelopeBase64
        self.approvalReceiptHash = envelope.approvalReceiptHash
    }

    enum CodingKeys: String, CodingKey {
        case messageId = "message_id"
        case threadId = "thread_id"
        case senderDID = "sender_did"
        case senderDeviceId = "sender_device_id"
        case recipientDID = "recipient_did"
        case recipientDeviceId = "recipient_device_id"
        case kind
        case sealedEnvelopeBase64 = "sealed_envelope_b64"
        case approvalReceiptHash = "approval_receipt_hash"
    }
}

private struct PostEnvelopeResponse: Codable {
    let messageId: UUID
    let queuedAt: Date
    let status: String

    enum CodingKeys: String, CodingKey {
        case messageId = "message_id"
        case queuedAt = "queued_at"
        case status
    }
}

private struct SyncEnvelopeResponse: Codable {
    let messageId: UUID
    let threadId: UUID?
    let senderDID: String?
    let senderDeviceId: String?
    let recipientDID: String
    let recipientDeviceId: String?
    let kind: NativeMessageKind
    let sealedEnvelopeBase64: String
    let approvalReceiptHash: String?
    let createdAt: Date
    let ackedAt: Date?

    var envelope: NativeMessageEnvelope {
        NativeMessageEnvelope(
            id: messageId,
            threadId: threadId ?? messageId,
            senderDID: senderDID ?? "did:unknown",
            recipientDID: recipientDID,
            senderDeviceId: senderDeviceId ?? "unknown",
            recipientDeviceId: recipientDeviceId,
            kind: kind,
            sealedEnvelopeBase64: sealedEnvelopeBase64,
            approvalReceiptHash: approvalReceiptHash,
            createdAt: createdAt,
            relayMessageId: messageId
        )
    }

    enum CodingKeys: String, CodingKey {
        case messageId = "message_id"
        case threadId = "thread_id"
        case senderDID = "sender_did"
        case senderDeviceId = "sender_device_id"
        case recipientDID = "recipient_did"
        case recipientDeviceId = "recipient_device_id"
        case kind
        case sealedEnvelopeBase64 = "sealed_envelope_b64"
        case approvalReceiptHash = "approval_receipt_hash"
        case createdAt = "created_at"
        case ackedAt = "acked_at"
    }
}

private struct AckResponse: Codable {
    let ok: Bool
    let messageId: UUID
    let ackedAt: Date

    enum CodingKeys: String, CodingKey {
        case ok
        case messageId = "message_id"
        case ackedAt = "acked_at"
    }
}

private struct EmptyBody: Codable {}

private struct BlockSenderRequest: Codable {
    let senderDID: String

    enum CodingKeys: String, CodingKey {
        case senderDID = "sender_did"
    }
}

private struct BlockSenderResponse: Codable {
    let ok: Bool
}

private struct ReportAbuseRequest: Codable {
    let messageId: UUID?
    let senderDID: String?
    let reason: String
    let ciphertextMetadata: [String: String]

    enum CodingKeys: String, CodingKey {
        case messageId = "message_id"
        case senderDID = "sender_did"
        case reason
        case ciphertextMetadata = "ciphertext_metadata"
    }
}

private struct ReportAbuseResponse: Codable {
    let ok: Bool
    let reportId: UUID

    enum CodingKeys: String, CodingKey {
        case ok
        case reportId = "report_id"
    }
}

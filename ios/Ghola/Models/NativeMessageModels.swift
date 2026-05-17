import Foundation

enum NativeMessagingVerificationState: String, Codable, CaseIterable, Sendable, Hashable {
    case unverified
    case verified
    case blocked

    var label: String {
        switch self {
        case .unverified: return "Unverified"
        case .verified: return "Verified"
        case .blocked: return "Blocked"
        }
    }
}

struct NativeMessagingDeviceKey: Codable, Equatable, Hashable, Identifiable, Sendable {
    let id: String
    let algorithm: String
    let signingPubkeyBase64: String?
    let publicKeyBase64: String
    let deviceLabel: String?
    let relayURLs: [String]
    let createdAt: Date
    let expiresAt: Date?

    init(
        id: String,
        algorithm: String = "SEv1.X25519+Ed25519+AESGCM",
        signingPubkeyBase64: String? = nil,
        publicKeyBase64: String,
        deviceLabel: String? = nil,
        relayURLs: [String] = [],
        createdAt: Date = Date(),
        expiresAt: Date? = nil
    ) {
        self.id = id
        self.algorithm = algorithm
        self.signingPubkeyBase64 = signingPubkeyBase64
        self.publicKeyBase64 = publicKeyBase64
        self.deviceLabel = deviceLabel
        self.relayURLs = relayURLs
        self.createdAt = createdAt
        self.expiresAt = expiresAt
    }

    enum CodingKeys: String, CodingKey {
        case id
        case algorithm
        case signingPubkeyBase64 = "signing_pubkey"
        case publicKeyBase64 = "x25519_prekey_pub"
        case deviceLabel = "device_label"
        case relayURLs = "relay_urls"
        case createdAt = "created_at"
        case expiresAt = "expires_at"
    }
}

struct DeviceKeyBundleV1: Codable, Equatable, Sendable {
    let userDID: String
    let deviceId: String
    let deviceLabel: String
    let signingPubkeyBase64: String
    let x25519PrekeyPubBase64: String
    let relayURLs: [String]
    let createdAt: Date
    let expiresAt: Date
    let signature: String

    var deviceKey: NativeMessagingDeviceKey {
        NativeMessagingDeviceKey(
            id: deviceId,
            signingPubkeyBase64: signingPubkeyBase64,
            publicKeyBase64: x25519PrekeyPubBase64,
            deviceLabel: deviceLabel,
            relayURLs: relayURLs,
            createdAt: createdAt,
            expiresAt: expiresAt
        )
    }

    enum CodingKeys: String, CodingKey {
        case userDID = "user_did"
        case deviceId = "device_id"
        case deviceLabel = "device_label"
        case signingPubkeyBase64 = "signing_pubkey"
        case x25519PrekeyPubBase64 = "x25519_prekey_pub"
        case relayURLs = "relay_urls"
        case createdAt = "created_at"
        case expiresAt = "expires_at"
        case signature
    }
}

struct NativeMessagingIdentity: Codable, Equatable, Sendable {
    let did: String
    let deviceId: String
    let deviceLabel: String
    let signingPubkeyBase64: String
    let x25519PrekeyPubBase64: String
    let relayURLs: [String]
    let createdAt: Date
    let expiresAt: Date
    let signature: String

    var deviceKey: NativeMessagingDeviceKey {
        NativeMessagingDeviceKey(
            id: deviceId,
            signingPubkeyBase64: signingPubkeyBase64,
            publicKeyBase64: x25519PrekeyPubBase64,
            deviceLabel: deviceLabel,
            relayURLs: relayURLs,
            createdAt: createdAt,
            expiresAt: expiresAt
        )
    }

    var keyBundle: DeviceKeyBundleV1 {
        DeviceKeyBundleV1(
            userDID: did,
            deviceId: deviceId,
            deviceLabel: deviceLabel,
            signingPubkeyBase64: signingPubkeyBase64,
            x25519PrekeyPubBase64: x25519PrekeyPubBase64,
            relayURLs: relayURLs,
            createdAt: createdAt,
            expiresAt: expiresAt,
            signature: signature
        )
    }

    enum CodingKeys: String, CodingKey {
        case did
        case deviceId = "device_id"
        case deviceLabel = "device_label"
        case signingPubkeyBase64 = "signing_pubkey"
        case x25519PrekeyPubBase64 = "x25519_prekey_pub"
        case relayURLs = "relay_urls"
        case createdAt = "created_at"
        case expiresAt = "expires_at"
        case signature
    }
}

enum NativeMessageDirection: String, Codable, Sendable {
    case inbound
    case outbound
}

enum NativeMessageDeliveryState: String, Codable, Sendable {
    case draft
    case sending
    case sent
    case delivered
    case failed
}

enum NativeMessageKind: String, Codable, CaseIterable, Sendable {
    case human
    case agentApproved = "agent_approved"
    case agentGenerated = "agent_generated"

    var badgeLabel: String {
        switch self {
        case .human: return "Verified human"
        case .agentApproved: return "Human-approved agent"
        case .agentGenerated: return "Unknown automation"
        }
    }

    var systemImage: String {
        switch self {
        case .human: return "person.fill.checkmark"
        case .agentApproved: return "checkmark.shield.fill"
        case .agentGenerated: return "exclamationmark.triangle.fill"
        }
    }
}

struct NativeMessageEnvelope: Codable, Equatable, Identifiable, Sendable {
    let id: UUID
    let threadId: UUID
    let senderDID: String
    let recipientDID: String
    let senderDeviceId: String
    let recipientDeviceId: String?
    let kind: NativeMessageKind
    let sealedEnvelopeBase64: String
    let approvalReceiptHash: String?
    let createdAt: Date
    let relayMessageId: UUID?

    init(
        id: UUID = UUID(),
        threadId: UUID = UUID(),
        senderDID: String,
        recipientDID: String,
        senderDeviceId: String,
        recipientDeviceId: String?,
        kind: NativeMessageKind = .human,
        sealedEnvelopeBase64: String,
        approvalReceiptHash: String? = nil,
        createdAt: Date = Date(),
        relayMessageId: UUID? = nil
    ) {
        self.id = id
        self.threadId = threadId
        self.senderDID = senderDID
        self.recipientDID = recipientDID
        self.senderDeviceId = senderDeviceId
        self.recipientDeviceId = recipientDeviceId
        self.kind = kind
        self.sealedEnvelopeBase64 = sealedEnvelopeBase64
        self.approvalReceiptHash = approvalReceiptHash
        self.createdAt = createdAt
        self.relayMessageId = relayMessageId
    }

    enum CodingKeys: String, CodingKey {
        case id
        case threadId = "thread_id"
        case senderDID = "sender_did"
        case recipientDID = "recipient_did"
        case senderDeviceId = "sender_device_id"
        case recipientDeviceId = "recipient_device_id"
        case kind
        case sealedEnvelopeBase64 = "sealed_envelope_b64"
        case approvalReceiptHash = "approval_receipt_hash"
        case createdAt = "created_at"
        case relayMessageId = "relay_message_id"
    }
}

struct NativeMessagePayload: Codable, Equatable, Sendable {
    struct Body: Codable, Equatable, Sendable {
        let kind: String
        let text: String
    }

    let v: Int
    let type: String
    let conversationId: String
    let messageId: String
    let senderDID: String
    let senderDeviceId: String
    let createdAt: Date
    let body: Body
    let replyTo: String?
    let attachments: [String]

    enum CodingKeys: String, CodingKey {
        case v
        case type
        case conversationId = "conversation_id"
        case messageId = "message_id"
        case senderDID = "sender_did"
        case senderDeviceId = "sender_device_id"
        case createdAt = "created_at"
        case body
        case replyTo = "reply_to"
        case attachments
    }
}

struct NativeMessage: Codable, Equatable, Identifiable, Sendable {
    let id: UUID
    let contactId: UUID
    let direction: NativeMessageDirection
    let envelope: NativeMessageEnvelope
    let localCiphertextBase64: String
    let sentAt: Date
    let receivedAt: Date?
    var deliveryState: NativeMessageDeliveryState

    var remoteDID: String {
        direction == .outbound ? envelope.recipientDID : envelope.senderDID
    }

    enum CodingKeys: String, CodingKey {
        case id
        case contactId = "contact_id"
        case direction
        case envelope
        case localCiphertextBase64 = "local_ciphertext"
        case sentAt = "sent_at"
        case receivedAt = "received_at"
        case deliveryState = "delivery_state"
    }
}

struct NativeMessageDraft: Sendable {
    let contact: WalletContact
    let plaintext: String
}

struct NativeMessageInboxItem: Codable, Equatable, Sendable {
    let relayMessageId: UUID
    let envelope: NativeMessageEnvelope

    enum CodingKeys: String, CodingKey {
        case relayMessageId = "relay_message_id"
        case envelope
    }
}

struct NativeMessageSendReceipt: Codable, Equatable, Sendable {
    let relayMessageId: UUID
    let acceptedAt: Date?

    enum CodingKeys: String, CodingKey {
        case relayMessageId = "relay_message_id"
        case acceptedAt = "accepted_at"
    }
}

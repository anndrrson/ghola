import Foundation

struct TaskResponse: Codable, Identifiable {
    let id: UUID
    let taskType: String
    let templateId: String?
    let status: String
    let params: [String: AnyCodable]?
    let result: [String: AnyCodable]?
    let errorMessage: String?
    let privacyMode: String?
    let networkScope: String?
    let approvalSummary: String?
    let privacyBoundary: String?
    let createdAt: String
    let updatedAt: String
    let completedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, status, params, result
        case taskType = "task_type"
        case templateId = "template_id"
        case errorMessage = "error_message"
        case privacyMode = "privacy_mode"
        case networkScope = "network_scope"
        case approvalSummary = "approval_summary"
        case privacyBoundary = "privacy_boundary"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case completedAt = "completed_at"
    }

    var statusEmoji: String {
        switch status {
        case "pending": return "clock"
        case "in_progress": return "arrow.triangle.2.circlepath"
        case "awaiting_approval": return "hand.raised"
        case "completed": return "checkmark.circle.fill"
        case "failed": return "xmark.circle.fill"
        case "cancelled": return "minus.circle"
        default: return "questionmark.circle"
        }
    }

    var typeIcon: String {
        switch taskType {
        case "call": return "phone.fill"
        case "email": return "envelope.fill"
        case "calendar": return "calendar"
        case "search": return "magnifyingglass"
        default: return "gearshape"
        }
    }
}

struct TaskStepResponse: Codable, Identifiable {
    let id: UUID
    let stepNumber: Int
    let actionType: String
    let status: String
    let input: [String: AnyCodable]?
    let output: [String: AnyCodable]?

    enum CodingKeys: String, CodingKey {
        case id, status, input, output
        case stepNumber = "step_number"
        case actionType = "action_type"
    }
}

struct EmailResponse: Codable, Identifiable {
    let id: UUID
    let taskId: UUID?
    let toAddress: String
    let subject: String
    let body: String
    let status: String
    let createdAt: String
    let sentAt: String?

    enum CodingKeys: String, CodingKey {
        case id, subject, body, status
        case taskId = "task_id"
        case toAddress = "to_address"
        case createdAt = "created_at"
        case sentAt = "sent_at"
    }
}

struct WalletInfoResponse: Codable {
    let address: String
    let network: String
}

struct WalletBalancesResponse: Codable {
    let sol: Double
    let usdc: Double
    let address: String
    let network: String?
}

struct WalletTransactionResponse: Codable, Identifiable {
    let id: UUID
    let txType: String
    let currency: String
    let amount: Int64
    let toAddressPreview: String?
    let signature: String?
    let status: String
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, currency, amount, signature, status
        case txType = "tx_type"
        case toAddressPreview = "to_address_preview"
        case createdAt = "created_at"
    }
}

struct WalletTransferResponse: Codable {
    let signature: String
    let explorerURL: String

    enum CodingKeys: String, CodingKey {
        case signature
        case explorerURL = "explorer_url"
    }
}

struct ProviderHealthResponse: Codable {
    let google: Bool?
    let apple: Bool?
    let stripe: Bool?
    let blandAI: Bool?
    let claude: Bool?
    let gmail: Bool?
    let telegram: Bool?
    let groq: Bool?
    let cerebras: Bool?
    let gemini: Bool?
    let openrouter: Bool?

    enum CodingKeys: String, CodingKey {
        case google, apple, stripe, claude, gmail, telegram, groq, cerebras, gemini, openrouter
        case blandAI = "bland_ai"
    }

    var hasCloudModelProvider: Bool {
        claude == true || groq == true || cerebras == true || gemini == true || openrouter == true
    }
}

struct ConnectedAccountStatus: Codable, Identifiable {
    let provider: String
    let connected: Bool
    let connectedAt: String?

    var id: String { provider }

    enum CodingKeys: String, CodingKey {
        case provider, connected
        case connectedAt = "connected_at"
    }
}

struct AuthorizeAccountResponse: Codable {
    let authorizeURL: String

    enum CodingKeys: String, CodingKey {
        case authorizeURL = "authorize_url"
    }
}

struct PaymentHealthResponse: Codable {
    let defaultRail: String?
    let rails: [String: PaymentRailStatus]

    enum CodingKeys: String, CodingKey {
        case defaultRail = "default_rail"
        case rails
    }

    var privateUSDCx: PaymentRailStatus? {
        rails["aleo_usdcx_shielded"] ?? rails["shielded_stablecoin"]
    }

    var publicUSDC: PaymentRailStatus? {
        rails["solana_public_usdc"] ?? rails["solana_public_stablecoin"]
    }
}

struct PaymentRailStatus: Codable {
    let configured: Bool?
    let ready: Bool?
    let provider: String?
    let network: String?
    let asset: String?
    let rail: String?
    let canonicalRail: String?
    let fallbackAllowed: Bool?
    let unavailableReason: String?
    let privacyDisclosure: String?

    enum CodingKeys: String, CodingKey {
        case configured, ready, provider, network, asset, rail
        case canonicalRail = "canonical_rail"
        case fallbackAllowed = "fallback_allowed"
        case unavailableReason = "unavailable_reason"
        case privacyDisclosure = "privacy_disclosure"
    }

    var isReady: Bool {
        ready ?? configured ?? false
    }
}

enum PrivatePaymentSigningMode: String, Codable, CaseIterable {
    case turnkeyUser = "turnkey_user"
    case aleoDevice = "aleo_device"

    var title: String {
        switch self {
        case .turnkeyUser: return "Turnkey user-held signer"
        case .aleoDevice: return "Aleo device signer"
        }
    }
}

struct PrivateSignerStatus: Codable, Equatable {
    let ready: Bool
    let signingMode: PrivatePaymentSigningMode
    let signerKeyID: String?
    let unavailableReason: String?

    enum CodingKeys: String, CodingKey {
        case ready
        case signingMode = "signing_mode"
        case signerKeyID = "signer_key_id"
        case unavailableReason = "unavailable_reason"
    }
}

struct InstitutionalReadinessResponse: Codable {
    let ready: Bool
    let version: String
    let claim: String
    let privateRailReady: Bool
    let verifierReady: Bool
    let signerReady: Bool
    let fundedSmokeTestPassed: Bool
    let serverHeldSigningDisabled: Bool
    let auditExportEnabled: Bool
    let openHighCriticalFindings: Int
    let lastCanaryAt: String?
    let blockingReasons: [String]

    enum CodingKeys: String, CodingKey {
        case ready, version, claim
        case privateRailReady = "private_rail_ready"
        case verifierReady = "verifier_ready"
        case signerReady = "signer_ready"
        case fundedSmokeTestPassed = "funded_smoke_test_passed"
        case serverHeldSigningDisabled = "server_held_signing_disabled"
        case auditExportEnabled = "audit_export_enabled"
        case openHighCriticalFindings = "open_high_critical_findings"
        case lastCanaryAt = "last_canary_at"
        case blockingReasons = "blocking_reasons"
    }
}

struct PrivateTransferIntentResponse: Codable, Identifiable {
    let id: UUID
    let rail: String
    let canonicalRail: String
    let provider: String
    let network: String
    let asset: String
    let amountMicroUSDC: Int64
    let recipientPreview: String
    let status: String
    let expiresAt: String
    let privacyDisclosure: String
    let fallbackAllowed: Bool
    let signingMode: String?
    let signerKeyID: String?
    let policyHash: String?
    let institutionalReadinessVersion: String?

    enum CodingKeys: String, CodingKey {
        case id, rail, provider, network, asset, status
        case canonicalRail = "canonical_rail"
        case amountMicroUSDC = "amount_micro_usdc"
        case recipientPreview = "recipient_preview"
        case expiresAt = "expires_at"
        case privacyDisclosure = "privacy_disclosure"
        case fallbackAllowed = "fallback_allowed"
        case signingMode = "signing_mode"
        case signerKeyID = "signer_key_id"
        case policyHash = "policy_hash"
        case institutionalReadinessVersion = "institutional_readiness_version"
    }
}

struct ShieldedPaymentProofPayload: Codable {
    let txSignature: String?
    let shieldedReceiptId: String?
    let proofB64: String?
    let nullifierHex: String?

    enum CodingKeys: String, CodingKey {
        case txSignature = "tx_signature"
        case shieldedReceiptId = "shielded_receipt_id"
        case proofB64 = "proof_b64"
        case nullifierHex = "nullifier_hex"
    }

    var jsonFields: [String: Any] {
        var fields: [String: Any] = [:]
        if let txSignature { fields["tx_signature"] = txSignature }
        if let shieldedReceiptId { fields["shielded_receipt_id"] = shieldedReceiptId }
        if let proofB64 { fields["proof_b64"] = proofB64 }
        if let nullifierHex { fields["nullifier_hex"] = nullifierHex }
        return fields
    }
}

struct ShieldedPaymentProof: Codable {
    let scheme: String
    let network: String
    let payload: ShieldedPaymentProofPayload

    init(network: String, payload: ShieldedPaymentProofPayload) {
        self.scheme = "shielded_stablecoin"
        self.network = network
        self.payload = payload
    }

    var jsonFields: [String: Any] {
        [
            "scheme": scheme,
            "network": network,
            "payload": payload.jsonFields,
        ]
    }
}

struct PrivateTransferProofResponse: Codable, Identifiable {
    let id: UUID
    let rail: String
    let canonicalRail: String
    let provider: String
    let network: String
    let asset: String
    let amountMicroUSDC: Int64
    let recipientPreview: String
    let adapterReceiptRef: String
    let status: String
    let privacyDisclosure: String
    let signingMode: String?
    let signerKeyID: String?
    let policyHash: String?
    let selectiveDisclosureReceiptHash: String?
    let institutionalReadinessVersion: String?

    enum CodingKeys: String, CodingKey {
        case id, rail, provider, network, asset, status
        case canonicalRail = "canonical_rail"
        case amountMicroUSDC = "amount_micro_usdc"
        case recipientPreview = "recipient_preview"
        case adapterReceiptRef = "adapter_receipt_ref"
        case privacyDisclosure = "privacy_disclosure"
        case signingMode = "signing_mode"
        case signerKeyID = "signer_key_id"
        case policyHash = "policy_hash"
        case selectiveDisclosureReceiptHash = "selective_disclosure_receipt_hash"
        case institutionalReadinessVersion = "institutional_readiness_version"
    }
}

struct PrivateTransferHistoryResponse: Codable, Identifiable {
    let id: UUID
    let rail: String
    let provider: String
    let network: String
    let asset: String
    let amountMicroUSDC: Int64
    let recipientPreview: String
    let status: String
    let adapterReceiptRef: String?
    let signingMode: String?
    let signerKeyID: String?
    let policyHash: String?
    let selectiveDisclosureReceiptHash: String?
    let institutionalReadinessVersion: String?
    let createdAt: String
    let verifiedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, rail, provider, network, asset, status
        case amountMicroUSDC = "amount_micro_usdc"
        case recipientPreview = "recipient_preview"
        case adapterReceiptRef = "adapter_receipt_ref"
        case signingMode = "signing_mode"
        case signerKeyID = "signer_key_id"
        case policyHash = "policy_hash"
        case selectiveDisclosureReceiptHash = "selective_disclosure_receipt_hash"
        case institutionalReadinessVersion = "institutional_readiness_version"
        case createdAt = "created_at"
        case verifiedAt = "verified_at"
    }
}

struct PrivateTransferReceiptResponse: Codable, Identifiable {
    let id: UUID
    let rail: String
    let provider: String
    let network: String
    let asset: String
    let amountMicroUSDC: Int64
    let recipientPreview: String
    let status: String
    let adapterReceiptRef: String?
    let signingMode: String?
    let signerKeyID: String?
    let policyHash: String?
    let selectiveDisclosureReceiptHash: String?
    let institutionalReadinessVersion: String?
    let verifiedAt: String?
    let privacyDisclosure: String

    enum CodingKeys: String, CodingKey {
        case id, rail, provider, network, asset, status
        case amountMicroUSDC = "amount_micro_usdc"
        case recipientPreview = "recipient_preview"
        case adapterReceiptRef = "adapter_receipt_ref"
        case signingMode = "signing_mode"
        case signerKeyID = "signer_key_id"
        case policyHash = "policy_hash"
        case selectiveDisclosureReceiptHash = "selective_disclosure_receipt_hash"
        case institutionalReadinessVersion = "institutional_readiness_version"
        case verifiedAt = "verified_at"
        case privacyDisclosure = "privacy_disclosure"
    }
}

struct PrivateTransferReceiptExportResponse: Codable {
    let exportID: UUID
    let transfer: PrivateTransferReceiptResponse
    let exportDisclosure: String
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case transfer
        case exportID = "export_id"
        case exportDisclosure = "export_disclosure"
        case createdAt = "created_at"
    }
}

struct CreateTaskRequest: Codable {
    let taskType: String
    let templateId: String?
    let params: [String: AnyCodable]

    enum CodingKeys: String, CodingKey {
        case taskType = "task_type"
        case templateId = "template_id"
        case params
    }
}

// MARK: - AnyCodable helper for dynamic JSON
struct AnyCodable: Codable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let str = try? container.decode(String.self) { value = str }
        else if let int = try? container.decode(Int.self) { value = int }
        else if let dbl = try? container.decode(Double.self) { value = dbl }
        else if let bool = try? container.decode(Bool.self) { value = bool }
        else if let dict = try? container.decode([String: AnyCodable].self) { value = dict }
        else if let arr = try? container.decode([AnyCodable].self) { value = arr }
        else { value = NSNull() }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let str as String: try container.encode(str)
        case let int as Int: try container.encode(int)
        case let dbl as Double: try container.encode(dbl)
        case let bool as Bool: try container.encode(bool)
        case let dict as [String: AnyCodable]: try container.encode(dict)
        case let arr as [AnyCodable]: try container.encode(arr)
        default: try container.encodeNil()
        }
    }
}

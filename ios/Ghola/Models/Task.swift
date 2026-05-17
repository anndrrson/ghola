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

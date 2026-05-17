import Foundation

struct TaskResponse: Codable, Identifiable {
    let id: UUID
    let taskType: String
    let templateId: String?
    let status: String
    let params: [String: AnyCodable]?
    let result: [String: AnyCodable]?
    let errorMessage: String?
    let createdAt: String
    let updatedAt: String
    let completedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, status, params, result
        case taskType = "task_type"
        case templateId = "template_id"
        case errorMessage = "error_message"
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

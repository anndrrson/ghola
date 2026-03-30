import Foundation

struct UserProfile: Codable {
    let id: UUID
    let email: String?
    let displayName: String?
    let phoneNumber: String?
    let timezone: String
    let tier: String
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, email, timezone, tier
        case displayName = "display_name"
        case phoneNumber = "phone_number"
        case createdAt = "created_at"
    }
}

struct AuthResponse: Codable {
    let token: String
    let userId: UUID
    let isNewUser: Bool

    enum CodingKeys: String, CodingKey {
        case token
        case userId = "user_id"
        case isNewUser = "is_new_user"
    }
}

struct UsageResponse: Codable {
    let callCount: Int
    let callMinutes: Int
    let emailCount: Int
    let maxCalls: Int
    let maxEmails: Int
    let tier: String

    enum CodingKeys: String, CodingKey {
        case tier
        case callCount = "call_count"
        case callMinutes = "call_minutes"
        case emailCount = "email_count"
        case maxCalls = "max_calls"
        case maxEmails = "max_emails"
    }
}

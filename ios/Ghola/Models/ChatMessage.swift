import Foundation

struct ChatMessage: Identifiable {
    let id = UUID()
    let role: Role
    var content: String
    let timestamp: Date

    enum Role {
        case user
        case assistant
        case error
    }

    var isUser: Bool { role == .user }
    var isAssistant: Bool { role == .assistant }
}

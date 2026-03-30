import Foundation

struct LlmConfigResponse: Codable {
    let provider: String
    let model: String
    let hasApiKey: Bool
    let baseUrl: String

    enum CodingKeys: String, CodingKey {
        case provider, model
        case hasApiKey = "has_api_key"
        case baseUrl = "base_url"
    }
}

struct ProviderInfo: Codable, Identifiable {
    let id: String
    let name: String
    let models: [String]
    let requiresApiKey: Bool

    enum CodingKeys: String, CodingKey {
        case id, name, models
        case requiresApiKey = "requires_api_key"
    }
}

struct UpdateLlmConfigRequest: Codable {
    var provider: String?
    var model: String?
    var apiKey: String?
    var baseUrl: String?

    enum CodingKeys: String, CodingKey {
        case provider, model
        case apiKey = "api_key"
        case baseUrl = "base_url"
    }
}

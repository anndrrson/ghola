import Foundation

/// REST client for the said-cloud backend — mirror of `SaidCloudClient.kt`.
///
/// Phase M10 stub: this compiles without an Apple Developer team so we can
/// validate the networking + Codable layer while Team 8RRWJ4U2L7 membership
/// is still pending. Once it unblocks, this becomes the canonical iOS path
/// for the agent ownership product.
///
/// Parallel to (not unified with) the thumper-cloud client: said-cloud and
/// thumper-cloud have separate JWT secrets and separate user tables, so the
/// iOS app holds two tokens just like Android does.
final class SaidCloudClient {

    static let defaultBaseURL = URL(string: "https://ghola-api.onrender.com/v1")!

    let baseURL: URL
    let authToken: String?
    private let session: URLSession

    init(baseURL: URL = SaidCloudClient.defaultBaseURL, authToken: String? = nil) {
        self.baseURL = baseURL
        self.authToken = authToken
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: config)
    }

    // MARK: - Auth

    /// POST /v1/auth/google — exchange a Google ID token for a said-cloud JWT.
    /// Idempotent: returning users get their existing user_id back.
    func googleSignIn(idToken: String) async throws -> AuthResponse {
        struct Request: Encodable { let id_token: String }
        return try await post("/auth/google", body: Request(id_token: idToken), authed: false)
    }

    // MARK: - Agents

    func listAgents() async throws -> [Agent] {
        try await get("/agents")
    }

    func getAgent(id: String) async throws -> AgentDetail {
        try await get("/agents/\(id)")
    }

    func createAgent(slug: String, displayName: String, bio: String? = nil, avatarUrl: String? = nil) async throws -> Agent {
        struct Request: Encodable {
            let slug: String
            let display_name: String
            let bio: String?
            let avatar_url: String?
        }
        return try await post(
            "/agents",
            body: Request(slug: slug, display_name: displayName, bio: bio, avatar_url: avatarUrl),
            authed: true
        )
    }

    func updateAgent(
        id: String,
        displayName: String? = nil,
        bio: String? = nil,
        avatarUrl: String? = nil,
        status: String? = nil
    ) async throws -> Agent {
        struct Request: Encodable {
            let display_name: String?
            let bio: String?
            let avatar_url: String?
            let status: String?
        }
        return try await patch(
            "/agents/\(id)",
            body: Request(display_name: displayName, bio: bio, avatar_url: avatarUrl, status: status)
        )
    }

    func archiveAgent(id: String) async throws {
        _ = try await send(
            path: "/agents/\(id)",
            method: "DELETE",
            body: Optional<EmptyBody>.none,
            decodeAs: EmptyResponse.self,
            authed: true
        )
    }

    func getAgentEarnings(id: String) async throws -> AgentEarnings {
        try await get("/agents/\(id)/earnings")
    }

    func getAgentReputation(id: String) async throws -> AgentReputation {
        try await get("/agents/\(id)/reputation")
    }

    func listAgentServices(id: String) async throws -> [AgentService] {
        try await get("/agents/\(id)/services")
    }

    // MARK: - Generic helpers

    private struct EmptyBody: Encodable {}
    private struct EmptyResponse: Decodable {}

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await send(path: path, method: "GET", body: Optional<EmptyBody>.none, decodeAs: T.self, authed: true)
    }

    private func post<B: Encodable, T: Decodable>(_ path: String, body: B, authed: Bool) async throws -> T {
        try await send(path: path, method: "POST", body: body, decodeAs: T.self, authed: authed)
    }

    private func patch<B: Encodable, T: Decodable>(_ path: String, body: B) async throws -> T {
        try await send(path: path, method: "PATCH", body: body, decodeAs: T.self, authed: true)
    }

    private func send<B: Encodable, T: Decodable>(
        path: String,
        method: String,
        body: B?,
        decodeAs: T.Type,
        authed: Bool
    ) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if authed, let token = authToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body = body {
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw SaidCloudError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "empty"
            throw SaidCloudError.http(status: http.statusCode, body: message)
        }
        if data.isEmpty, let empty = EmptyResponse() as? T {
            return empty
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

// MARK: - Response types

struct AuthResponse: Decodable {
    let token: String
    let user_id: String
    let did: String
}

struct Agent: Decodable, Identifiable {
    let id: String
    let user_id: String
    let slug: String
    let display_name: String
    let bio: String?
    let avatar_url: String?
    let did: String
    let solana_address: String
    let wallet_id: String?
    let onchain_identity_pda: String?
    let status: String
    let created_at: String
    let updated_at: String
}

struct AgentDetail: Decodable {
    let id: String
    let user_id: String
    let slug: String
    let display_name: String
    let bio: String?
    let avatar_url: String?
    let did: String
    let solana_address: String
    let wallet_id: String?
    let onchain_identity_pda: String?
    let status: String
    let created_at: String
    let updated_at: String
    let wallet: AgentWallet?
    let service_count: Int
    let reputation_score: Double?
}

struct AgentWallet: Decodable {
    let id: String
    let user_id: String
    let label: String
    let hd_index: Int
    let solana_address: String
    let active: Bool
    let agent_id: String?
    let created_at: String
    let updated_at: String
}

struct AgentEarnings: Decodable {
    let agent_id: String
    let total_received_micro_usdc: Int64
    let total_spent_micro_usdc: Int64
    let net_micro_usdc: Int64
    let transaction_count: Int64

    var balanceUsdc: Double {
        Double(net_micro_usdc) / 1_000_000.0
    }
}

struct AgentReputation: Decodable {
    let entity_did: String
    let entity_type: String
    let overall_score: Double
    let confidence: Double?
    let total_transactions: Int?
    let completed_transactions: Int?
    let review_count: Int?
}

struct AgentService: Decodable {
    let id: String
    let name: String
    let slug: String
    let price_micro_usdc: Int64
    let total_requests: Int64
}

enum SaidCloudError: Error, LocalizedError {
    case invalidResponse
    case http(status: Int, body: String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Invalid response from said-cloud"
        case .http(let status, let body):
            return "said-cloud returned \(status): \(body)"
        }
    }
}

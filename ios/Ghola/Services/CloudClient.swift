import Foundation

actor CloudClient {
    static let shared = CloudClient()

    // MARK: - Local mode

    static var isLocalMode: Bool {
        get { UserDefaults.standard.bool(forKey: "local_mode") }
        set { UserDefaults.standard.set(newValue, forKey: "local_mode") }
    }

    static var localServerName: String? {
        get { KeychainHelper.loadString("local_server_name") }
    }

    // TODO: Update to production URL
    private var baseURL = "https://api.ghola.xyz"
    private let session = URLSession.shared
    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        return d
    }()

    // MARK: - Token management

    private var token: String? {
        get { KeychainHelper.loadString("jwt_token") }
    }

    func setToken(_ token: String) {
        KeychainHelper.save(token, for: "jwt_token")
    }

    func clearToken() {
        KeychainHelper.delete("jwt_token")
    }

    var isAuthenticated: Bool {
        token != nil
    }

    func setBaseURL(_ url: String) {
        baseURL = url
    }

    // MARK: - Auth

    func emailSignUp(email: String, password: String, displayName: String?) async throws -> AuthResponse {
        var body: [String: Any] = ["email": email, "password": password]
        if let name = displayName { body["display_name"] = name }
        return try await post("/api/auth/email/signup", body: body, authenticated: false)
    }

    func emailSignIn(email: String, password: String) async throws -> AuthResponse {
        let body: [String: Any] = ["email": email, "password": password]
        return try await post("/api/auth/email/signin", body: body, authenticated: false)
    }

    func refreshToken() async throws -> AuthResponse {
        return try await post("/api/auth/refresh", body: [:], authenticated: true)
    }

    // MARK: - Tasks

    func createTask(type: String, templateId: String?, params: [String: Any]) async throws -> TaskResponse {
        var body: [String: Any] = ["task_type": type, "params": params]
        if let t = templateId { body["template_id"] = t }
        return try await post("/api/tasks", body: body)
    }

    func listTasks(status: String? = nil) async throws -> [TaskResponse] {
        var path = "/api/tasks"
        if let s = status { path += "?status=\(s)" }
        return try await get(path)
    }

    func getTask(id: UUID) async throws -> TaskResponse {
        return try await get("/api/tasks/\(id)")
    }

    func getTaskSteps(taskId: UUID) async throws -> [TaskStepResponse] {
        return try await get("/api/tasks/\(taskId)/steps")
    }

    func cancelTask(id: UUID) async throws {
        let _: [String: AnyCodable] = try await post("/api/tasks/\(id)/cancel", body: [:])
    }

    // MARK: - User

    func getProfile() async throws -> UserProfile {
        return try await get("/api/user/profile")
    }

    func updateProfile(displayName: String?, phoneNumber: String?, timezone: String?) async throws -> UserProfile {
        var body: [String: Any] = [:]
        if let n = displayName { body["display_name"] = n }
        if let p = phoneNumber { body["phone_number"] = p }
        if let t = timezone { body["timezone"] = t }
        return try await patch("/api/user/profile", body: body)
    }

    func getUsage() async throws -> UsageResponse {
        return try await get("/api/user/usage")
    }

    // MARK: - Devices

    func registerDevice(platform: String, deviceName: String?, pushToken: String?) async throws {
        var body: [String: Any] = ["platform": platform]
        if let n = deviceName { body["device_name"] = n }
        if let t = pushToken { body["push_token"] = t }
        let _: [String: AnyCodable] = try await post("/api/devices", body: body)
    }

    func updatePushToken(deviceId: UUID, token: String) async throws {
        let _: [String: AnyCodable] = try await post("/api/devices/\(deviceId)/push-token", body: ["push_token": token])
    }

    // MARK: - LLM Config (BYOM)

    func getLlmConfig() async throws -> LlmConfigResponse {
        return try await get("/api/llm/config")
    }

    func updateLlmConfig(_ config: UpdateLlmConfigRequest) async throws -> LlmConfigResponse {
        let data = try JSONEncoder().encode(config)
        let body = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        return try await patch("/api/llm/config", body: body)
    }

    func listProviders() async throws -> [ProviderInfo] {
        return try await get("/api/llm/providers")
    }

    // MARK: - Billing

    func createCheckout(tier: String) async throws -> String {
        let resp: [String: AnyCodable] = try await post("/api/billing/checkout", body: ["tier": tier])
        guard let url = resp["checkout_url"]?.value as? String else {
            throw CloudError.invalidResponse
        }
        return url
    }

    func billingStatus() async throws -> [String: AnyCodable] {
        return try await get("/api/billing/status")
    }

    // MARK: - Chat SSE URL

    func chatSSERequest(sessionId: UUID?, message: String) throws -> URLRequest {
        let (url, authToken): (String, String) = if CloudClient.isLocalMode {
            let localURL = KeychainHelper.loadString("local_base_url") ?? "http://localhost:3000"
            let localToken = KeychainHelper.loadString("local_token") ?? ""
            (localURL, localToken)
        } else {
            guard let t = token else { throw CloudError.unauthorized }
            (baseURL, t)
        }

        var request = URLRequest(url: URL(string: "\(url)/api/chat")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = ["message": message]
        if let sid = sessionId { body["session_id"] = sid.uuidString }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        return request
    }

    // MARK: - Local pairing

    func localPair(serverURL: String, pin: String, deviceName: String) async throws {
        guard let url = URL(string: "\(serverURL)/api/local/pair") else {
            throw CloudError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "pin": pin,
            "device_name": deviceName,
        ])

        let (data, response) = try await session.data(for: request)
        try validateResponse(response, data: data)

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["token"] as? String else {
            throw CloudError.invalidResponse
        }

        let serverName = json["server_name"] as? String ?? "Local Server"

        KeychainHelper.save(token, for: "local_token")
        KeychainHelper.save(serverURL, for: "local_base_url")
        KeychainHelper.save(serverName, for: "local_server_name")
        CloudClient.isLocalMode = true
    }

    func disconnectLocal() {
        KeychainHelper.delete("local_token")
        KeychainHelper.delete("local_base_url")
        KeychainHelper.delete("local_server_name")
        CloudClient.isLocalMode = false
    }

    // MARK: - HTTP helpers

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let request = try makeRequest(path, method: "GET")
        let (data, response) = try await session.data(for: request)
        try validateResponse(response, data: data)
        return try decoder.decode(T.self, from: data)
    }

    private func post<T: Decodable>(_ path: String, body: [String: Any], authenticated: Bool = true) async throws -> T {
        var request = try makeRequest(path, method: "POST", authenticated: authenticated)
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        try validateResponse(response, data: data)
        return try decoder.decode(T.self, from: data)
    }

    private func patch<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        var request = try makeRequest(path, method: "PATCH")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        try validateResponse(response, data: data)
        return try decoder.decode(T.self, from: data)
    }

    private func makeRequest(_ path: String, method: String, authenticated: Bool = true) throws -> URLRequest {
        guard let url = URL(string: "\(baseURL)\(path)") else {
            throw CloudError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if authenticated {
            guard let token = token else { throw CloudError.unauthorized }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        return request
    }

    private func validateResponse(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw CloudError.invalidResponse }
        switch http.statusCode {
        case 200..<300: return
        case 401: throw CloudError.unauthorized
        case 402: throw CloudError.paymentRequired
        case 429: throw CloudError.rateLimited
        default:
            let body = String(data: data, encoding: .utf8) ?? "unknown error"
            throw CloudError.server(http.statusCode, body)
        }
    }
}

enum CloudError: LocalizedError {
    case invalidURL
    case invalidResponse
    case unauthorized
    case paymentRequired
    case rateLimited
    case server(Int, String)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid URL"
        case .invalidResponse: return "Invalid response"
        case .unauthorized: return "Please sign in again"
        case .paymentRequired: return "Upgrade your plan to continue"
        case .rateLimited: return "Too many requests, please wait"
        case .server(let code, let msg): return "Error \(code): \(msg)"
        }
    }
}

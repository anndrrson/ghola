import Foundation

enum GholaPrivacyMode: String, CaseIterable, Sendable {
    case strictLocal = "strictLocal"

    static let storageKey = "ghola.privacy.mode"
}

enum NetworkScope: String, CaseIterable, Sendable {
    case auth
    case cloudChat
    case localServerChat
    case callExecution
    case emailDraft
    case emailSend
    case calendarExecution
    case walletProvision
    case walletTransfer
    case smsSend
    case nativeMessagingRelay
    case agentPlan
    case remoteAgentCompute
    case swarmExecution
    case billing
    case commerceExecution
    case providerConfig

    var title: String {
        switch self {
        case .auth: return "Authentication"
        case .cloudChat: return "Cloud chat"
        case .localServerChat: return "Local server chat"
        case .callExecution: return "Call execution"
        case .emailDraft: return "Email draft"
        case .emailSend: return "Email send"
        case .calendarExecution: return "Calendar execution"
        case .walletProvision: return "Wallet provision"
        case .walletTransfer: return "Wallet transfer"
        case .smsSend: return "SMS send"
        case .nativeMessagingRelay: return "Native messaging relay"
        case .agentPlan: return "Agent planning"
        case .remoteAgentCompute: return "Remote agent compute"
        case .swarmExecution: return "Swarm execution"
        case .billing: return "Billing"
        case .commerceExecution: return "Commerce execution"
        case .providerConfig: return "Provider config"
        }
    }

    var boundaryLabel: String {
        switch self {
        case .localServerChat:
            return "Local network"
        case .cloudChat, .auth, .nativeMessagingRelay, .agentPlan, .remoteAgentCompute, .swarmExecution, .billing, .providerConfig:
            return "Ghola Cloud"
        case .callExecution, .emailDraft, .emailSend, .calendarExecution, .walletProvision, .walletTransfer, .smsSend, .commerceExecution:
            return "External provider"
        }
    }

    var requiresExplicitApproval: Bool {
        switch self {
        case .callExecution, .emailDraft, .emailSend, .calendarExecution, .walletProvision, .walletTransfer, .smsSend, .cloudChat, .agentPlan, .remoteAgentCompute, .swarmExecution, .commerceExecution:
            return true
        case .auth, .localServerChat, .nativeMessagingRelay, .billing, .providerConfig:
            return false
        }
    }
}

struct PrivacyApproval: Sendable {
    let privacyMode: GholaPrivacyMode
    let networkScope: NetworkScope
    let userApprovedAt: Date
    let approvalNonce: String
    let approvalSummary: String

    init(
        scope: NetworkScope,
        summary: String,
        approvedAt: Date = Date(),
        nonce: String = UUID().uuidString
    ) {
        self.privacyMode = PrivacyGate.currentMode
        self.networkScope = scope
        self.userApprovedAt = approvedAt
        self.approvalNonce = nonce
        self.approvalSummary = summary.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var jsonFields: [String: Any] {
        [
            "privacy_mode": privacyMode.rawValue,
            "network_scope": networkScope.rawValue,
            "user_approved_at": ISO8601DateFormatter().string(from: userApprovedAt),
            "approval_nonce": approvalNonce,
            "approval_summary": approvalSummary,
        ]
    }
}

enum PrivacyGate {
    static var currentMode: GholaPrivacyMode {
        get {
            let raw = UserDefaults.standard.string(forKey: GholaPrivacyMode.storageKey)
            return raw.flatMap(GholaPrivacyMode.init(rawValue:)) ?? .strictLocal
        }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: GholaPrivacyMode.storageKey)
        }
    }

    static func makeApproval(scope: NetworkScope, summary: String) -> PrivacyApproval {
        PrivacyApproval(scope: scope, summary: summary)
    }

    static func authorize(scope: NetworkScope, approval: PrivacyApproval? = nil) throws {
        if scope == .cloudChat && BackendRegistry.selectedMode != .cloud {
            throw CloudError.privacyBlocked("Cloud chat is blocked unless Cloud mode is explicitly selected in Settings.")
        }

        guard scope.requiresExplicitApproval else { return }

        guard let approval else {
            throw CloudError.privacyBlocked("\(scope.title) requires explicit approval before network execution.")
        }
        guard approval.privacyMode == currentMode,
              approval.networkScope == scope,
              !approval.approvalSummary.isEmpty else {
            throw CloudError.privacyBlocked("Invalid privacy approval for \(scope.title).")
        }
    }
}

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

    // Direct thumper-cloud origin. `api.ghola.xyz/api/*` currently proxies here
    // through the web app, but its root health route is not the task backend.
    private var baseURL = "https://thumper-cloud.onrender.com"
    private let session = URLSession.shared
    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        return d
    }()
    private static let siwsChallengePrefix = "Sign in to Ghola\n"

    private struct SiwsChallengeResponse: Codable {
        let nonce: String
        let challenge: String
    }

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
        return try await post("/api/auth/email/signup", body: body, authenticated: false, scope: .auth)
    }

    func emailSignIn(email: String, password: String) async throws -> AuthResponse {
        let body: [String: Any] = ["email": email, "password": password]
        return try await post("/api/auth/email/signin", body: body, authenticated: false, scope: .auth)
    }

    func siwsSignInWithDeviceSigner(
        walletPubkey: String,
        signChallenge: @escaping @Sendable (String) async throws -> String
    ) async throws -> AuthResponse {
        let normalizedWallet = walletPubkey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedWallet.isEmpty else {
            throw CloudError.server(400, "A Ghola wallet address is required for sign-in")
        }

        let challenge: SiwsChallengeResponse = try await get("/api/auth/siws/challenge", authenticated: false, scope: .auth)
        guard challenge.challenge.hasPrefix(Self.siwsChallengePrefix),
              challenge.challenge.contains("Nonce: \(challenge.nonce)") else {
            throw CloudError.server(400, "Unexpected sign-in challenge")
        }
        let signature = try await signChallenge(challenge.challenge)

        let body: [String: Any] = [
            "wallet_pubkey": normalizedWallet,
            "nonce": challenge.nonce,
            "challenge": challenge.challenge,
            "signature": signature,
        ]
        return try await post("/api/auth/siws", body: body, authenticated: false, scope: .auth)
    }

    func appleSignIn(identityToken: String, userId: String, email: String?, fullName: String?) async throws -> AuthResponse {
        var body: [String: Any] = [
            "identity_token": identityToken,
            "user_id": userId,
        ]
        if let email, !email.isEmpty {
            body["email"] = email
        }
        if let fullName, !fullName.isEmpty {
            body["full_name"] = fullName
        }
        return try await post("/api/auth/apple", body: body, authenticated: false, scope: .auth)
    }

    func refreshToken() async throws -> AuthResponse {
        return try await post("/api/auth/refresh", body: [:], authenticated: true, scope: .auth)
    }

    // MARK: - Tasks

    func createTask(type: String, templateId: String?, params: [String: Any], approval: PrivacyApproval? = nil) async throws -> TaskResponse {
        guard let scope = NetworkScope.taskScope(type: type, params: params) else {
            throw CloudError.privacyBlocked("Unclassified task type '\(type)' is blocked by strict local privacy.")
        }
        try PrivacyGate.authorize(scope: scope, approval: approval)
        var body: [String: Any] = ["task_type": type, "params": params]
        if let approval {
            body.merge(approval.jsonFields) { _, new in new }
        }
        if let t = templateId { body["template_id"] = t }
        return try await post("/api/tasks", body: body, scope: scope, approval: approval)
    }

    func listTasks(status: String? = nil) async throws -> [TaskResponse] {
        var path = "/api/tasks"
        if let s = status { path += "?status=\(s)" }
        return try await get(path, scope: .auth)
    }

    func getTask(id: UUID) async throws -> TaskResponse {
        return try await get("/api/tasks/\(id)", scope: .auth)
    }

    func getTaskSteps(taskId: UUID) async throws -> [TaskStepResponse] {
        return try await get("/api/tasks/\(taskId)/steps", scope: .auth)
    }

    func cancelTask(id: UUID) async throws {
        let _: [String: AnyCodable] = try await post("/api/tasks/\(id)/cancel", body: [:], scope: .auth)
    }

    func sendEmail(id: UUID, approval: PrivacyApproval) async throws -> EmailResponse {
        try PrivacyGate.authorize(scope: .emailSend, approval: approval)
        return try await post("/api/emails/\(id)/send", body: approval.jsonFields, scope: .emailSend, approval: approval)
    }

    func getEmailDetail(id: UUID) async throws -> EmailResponse {
        return try await get("/api/emails/\(id)", scope: .auth)
    }

    // MARK: - Wallet

    func provisionWallet(approval: PrivacyApproval) async throws -> WalletInfoResponse {
        try PrivacyGate.authorize(scope: .walletProvision, approval: approval)
        return try await post("/api/wallet/provision", body: approval.jsonFields, scope: .walletProvision, approval: approval)
    }

    func getWalletAddress() async throws -> WalletInfoResponse {
        return try await get("/api/wallet/address", scope: .auth)
    }

    func getWalletBalances() async throws -> WalletBalancesResponse {
        return try await get("/api/wallet/balances", scope: .auth)
    }

    func getWalletHistory(limit: Int = 25) async throws -> [WalletTransactionResponse] {
        return try await get("/api/wallet/history?limit=\(limit)", scope: .auth)
    }

    func getPaymentHealth() async throws -> PaymentHealthResponse {
        return try await get("/health/payments", authenticated: false, scope: .auth)
    }

    func getPrivateUSDCxRecipient() async throws -> PrivateRailRecipientResponse {
        return try await get("/api/wallet/private/recipient", scope: .auth)
    }

    func getInstitutionalReadiness() async throws -> InstitutionalReadinessResponse {
        return try await get("/health/institutional", authenticated: false, scope: .auth)
    }

    func getProviderHealth() async throws -> ProviderHealthResponse {
        return try await get("/health/providers", authenticated: false, scope: .auth)
    }

    func getPrivacyHealth() async throws -> PrivacyHealthResponse {
        return try await get("/health/privacy", authenticated: false, scope: .auth)
    }

    func getConnectedAccounts() async throws -> [ConnectedAccountStatus] {
        return try await get("/api/accounts/status", scope: .providerConfig)
    }

    func getGmailAuthorizeURL() async throws -> URL {
        let response: AuthorizeAccountResponse = try await get("/api/accounts/authorize/gmail", scope: .providerConfig)
        guard let url = URL(string: response.authorizeURL) else {
            throw CloudError.invalidURL
        }
        return url
    }

    func sendUSDC(to address: String, amountMicroUSDC: Int64, approval: PrivacyApproval) async throws -> WalletTransferResponse {
        try PrivacyGate.authorize(scope: .walletTransfer, approval: approval)
        var body: [String: Any] = [
            "to": address,
            "amount": amountMicroUSDC,
            "currency": "USDC",
        ]
        body.merge(approval.jsonFields) { _, new in new }
        return try await post("/api/wallet/transfer", body: body, scope: .walletTransfer, approval: approval)
    }

    func createPrivateUSDCxIntent(
        to shieldedAddress: String,
        amountMicroUSDC: Int64,
        signingMode: PrivatePaymentSigningMode,
        signerKeyID: String,
        approval: PrivacyApproval
    ) async throws -> PrivateTransferIntentResponse {
        try PrivacyGate.authorize(scope: .walletTransfer, approval: approval)
        var body: [String: Any] = [
            "rail": "aleo_usdcx_shielded",
            "to_shielded_address": shieldedAddress,
            "amount_micro_usdc": amountMicroUSDC,
            "signing_mode": signingMode.rawValue,
            "signer_key_id": signerKeyID,
        ]
        body.merge(approval.jsonFields) { _, new in new }
        return try await post("/api/wallet/private/intent", body: body, scope: .walletTransfer, approval: approval)
    }

    func submitSignedPrivateUSDCxTransfer(
        intentId: UUID,
        to shieldedAddress: String,
        proof: ShieldedPaymentProof,
        signingMode: PrivatePaymentSigningMode,
        signerKeyID: String,
        signerAttestation: String?,
        approval: PrivacyApproval
    ) async throws -> PrivateTransferProofResponse {
        try PrivacyGate.authorize(scope: .walletTransfer, approval: approval)
        var body: [String: Any] = [
            "intent_id": intentId.uuidString,
            "to_shielded_address": shieldedAddress,
            "proof": proof.jsonFields,
            "signing_mode": signingMode.rawValue,
            "signer_key_id": signerKeyID,
        ]
        if let signerAttestation {
            body["signer_attestation"] = signerAttestation
        }
        body.merge(approval.jsonFields) { _, new in new }
        return try await post("/api/wallet/private/submit-signed-transfer", body: body, scope: .walletTransfer, approval: approval)
    }

    func submitPrivateUSDCxProof(intentId: UUID, to shieldedAddress: String, proof: ShieldedPaymentProof, approval: PrivacyApproval) async throws -> PrivateTransferProofResponse {
        try PrivacyGate.authorize(scope: .walletTransfer, approval: approval)
        var body: [String: Any] = [
            "intent_id": intentId.uuidString,
            "to_shielded_address": shieldedAddress,
            "proof": proof.jsonFields,
        ]
        body.merge(approval.jsonFields) { _, new in new }
        return try await post("/api/wallet/private/submit-proof", body: body, scope: .walletTransfer, approval: approval)
    }

    func getPrivateTransferHistory(limit: Int = 25) async throws -> [PrivateTransferHistoryResponse] {
        return try await get("/api/wallet/private/history?limit=\(limit)", scope: .auth)
    }

    func getPrivateTransferReceipt(id: UUID) async throws -> PrivateTransferReceiptResponse {
        return try await get("/api/wallet/private/receipts/\(id.uuidString)", scope: .auth)
    }

    func exportPrivateTransferReceipt(id: UUID, reason: String, approval: PrivacyApproval) async throws -> PrivateTransferReceiptExportResponse {
        try PrivacyGate.authorize(scope: .walletTransfer, approval: approval)
        var body: [String: Any] = [
            "reason": reason,
            "audience": "user",
        ]
        body.merge(approval.jsonFields) { _, new in new }
        return try await post("/api/wallet/private/receipts/\(id.uuidString)/export", body: body, scope: .walletTransfer, approval: approval)
    }

    // MARK: - Commerce

    func createCommerceIntent(
        goal: String,
        budgetMicroUSDC: Int64,
        privacyMode: String = "private",
        preferredRail: String = "aleo_usdcx_shielded",
        allowedAdapters: [String] = ["fixture_catalog", "x402_agent", "merchant_checkout"]
    ) async throws -> CommerceIntentResponse {
        let body: [String: Any] = [
            "goal": goal,
            "budget_micro_usdc": budgetMicroUSDC,
            "privacy_mode": privacyMode,
            "preferred_rail": preferredRail,
            "allowed_adapters": allowedAdapters,
        ]
        return try await post("/api/commerce/intents", body: body, scope: .auth)
    }

    func listCommerceOffers(intentId: UUID) async throws -> [CommerceOfferResponse] {
        return try await get("/api/commerce/intents/\(intentId.uuidString)/offers", scope: .auth)
    }

    func createCommerceQuote(intentId: UUID, offerId: String, rail: String?) async throws -> CommerceQuoteResponse {
        var body: [String: Any] = ["offer_id": offerId]
        if let rail {
            body["rail"] = rail
        }
        return try await post("/api/commerce/intents/\(intentId.uuidString)/quote", body: body, scope: .auth)
    }

    func executeCommerceQuote(intentId: UUID, quoteId: UUID, approval: PrivacyApproval) async throws -> CommerceExecutionResponse {
        try PrivacyGate.authorize(scope: .commerceExecution, approval: approval)
        var body = approval.jsonFields
        body["quote_id"] = quoteId.uuidString
        return try await post(
            "/api/commerce/intents/\(intentId.uuidString)/execute",
            body: body,
            scope: .commerceExecution,
            approval: approval
        )
    }

    func getCommerceReceipt(id: UUID) async throws -> CommerceReceiptResponse {
        return try await get("/api/commerce/receipts/\(id.uuidString)", scope: .auth)
    }

    func exportCommerceReceipt(id: UUID, reason: String, approval: PrivacyApproval) async throws -> CommerceReceiptExportResponse {
        try PrivacyGate.authorize(scope: .commerceExecution, approval: approval)
        var body: [String: Any] = [
            "reason": reason,
            "audience": "user",
        ]
        body.merge(approval.jsonFields) { _, new in new }
        return try await post(
            "/api/commerce/receipts/\(id.uuidString)/export",
            body: body,
            scope: .commerceExecution,
            approval: approval
        )
    }

    // MARK: - User

    func getProfile() async throws -> UserProfile {
        return try await get("/api/user/profile", scope: .auth)
    }

    func updateProfile(displayName: String?, phoneNumber: String?, timezone: String?) async throws -> UserProfile {
        var body: [String: Any] = [:]
        if let n = displayName { body["display_name"] = n }
        if let p = phoneNumber { body["phone_number"] = p }
        if let t = timezone { body["timezone"] = t }
        return try await patch("/api/user/profile", body: body, scope: .auth)
    }

    func getUsage() async throws -> UsageResponse {
        return try await get("/api/user/usage", scope: .auth)
    }

    // MARK: - Devices

    func registerDevice(platform: String, deviceName: String?, pushToken: String?) async throws {
        var body: [String: Any] = ["platform": platform]
        if let n = deviceName { body["device_name"] = n }
        if let t = pushToken { body["push_token"] = t }
        let _: [String: AnyCodable] = try await post("/api/devices", body: body, scope: .auth)
    }

    func updatePushToken(deviceId: UUID, token: String) async throws {
        let _: [String: AnyCodable] = try await post("/api/devices/\(deviceId)/push-token", body: ["push_token": token], scope: .auth)
    }

    // MARK: - LLM Config (BYOM)

    func getLlmConfig() async throws -> LlmConfigResponse {
        return try await get("/api/llm/config", scope: .providerConfig)
    }

    func updateLlmConfig(_ config: UpdateLlmConfigRequest) async throws -> LlmConfigResponse {
        let data = try JSONEncoder().encode(config)
        let body = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        return try await patch("/api/llm/config", body: body, scope: .providerConfig)
    }

    func listProviders() async throws -> [ProviderInfo] {
        return try await get("/api/llm/providers", scope: .providerConfig)
    }

    // MARK: - Billing

    func createCheckout(tier: String) async throws -> String {
        let resp: [String: AnyCodable] = try await post("/api/billing/checkout", body: ["tier": tier], scope: .billing)
        guard let url = resp["checkout_url"]?.value as? String else {
            throw CloudError.invalidResponse
        }
        return url
    }

    func billingStatus() async throws -> [String: AnyCodable] {
        return try await get("/api/billing/status", scope: .billing)
    }

    // MARK: - Chat SSE URL

    func chatSSERequest(sessionId: UUID?, message: String) throws -> URLRequest {
        let url: String
        let authToken: String
        let scope: NetworkScope
        let approval: PrivacyApproval?
        if CloudClient.isLocalMode {
            scope = .localServerChat
            approval = nil
            try PrivacyGate.authorize(scope: scope)
            url = KeychainHelper.loadString("local_base_url") ?? "http://localhost:3000"
            authToken = KeychainHelper.loadString("local_token") ?? ""
        } else {
            scope = .cloudChat
            approval = PrivacyGate.makeApproval(
                scope: .cloudChat,
                summary: "Send this chat prompt to Ghola Cloud and the configured model provider."
            )
            try PrivacyGate.authorize(scope: scope, approval: approval)
            guard let t = token else { throw CloudError.unauthorized }
            url = baseURL
            authToken = t
        }

        var request = URLRequest(url: URL(string: "\(url)/api/chat")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = ["message": message]
        if let sid = sessionId { body["session_id"] = sid.uuidString }
        if let approval {
            body.merge(approval.jsonFields) { _, new in new }
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        return request
    }

    // MARK: - Local pairing

    func localPair(serverURL: String, pin: String, deviceName: String) async throws {
        try PrivacyGate.authorize(scope: .localServerChat)
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

    private func get<T: Decodable>(_ path: String, scope: NetworkScope) async throws -> T {
        let request = try makeRequest(path, method: "GET", scope: scope)
        let (data, response) = try await session.data(for: request)
        try validateResponse(response, data: data)
        return try decoder.decode(T.self, from: data)
    }

    private func get<T: Decodable>(_ path: String, authenticated: Bool, scope: NetworkScope) async throws -> T {
        let request = try makeRequest(path, method: "GET", authenticated: authenticated, scope: scope)
        let (data, response) = try await session.data(for: request)
        try validateResponse(response, data: data)
        return try decoder.decode(T.self, from: data)
    }

    private func post<T: Decodable>(
        _ path: String,
        body: [String: Any],
        authenticated: Bool = true,
        scope: NetworkScope,
        approval: PrivacyApproval? = nil
    ) async throws -> T {
        var request = try makeRequest(path, method: "POST", authenticated: authenticated, scope: scope, approval: approval)
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        try validateResponse(response, data: data)
        return try decoder.decode(T.self, from: data)
    }

    private func patch<T: Decodable>(_ path: String, body: [String: Any], scope: NetworkScope) async throws -> T {
        var request = try makeRequest(path, method: "PATCH", scope: scope)
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        try validateResponse(response, data: data)
        return try decoder.decode(T.self, from: data)
    }

    private func makeRequest(
        _ path: String,
        method: String,
        authenticated: Bool = true,
        scope: NetworkScope,
        approval: PrivacyApproval? = nil
    ) throws -> URLRequest {
        try PrivacyGate.authorize(scope: scope, approval: approval)
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
        case 404:
            let body = String(data: data, encoding: .utf8) ?? "not found"
            throw CloudError.notFound(body)
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
    case notFound(String)
    case paymentRequired
    case rateLimited
    case privacyBlocked(String)
    case server(Int, String)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid URL"
        case .invalidResponse: return "Invalid response"
        case .unauthorized: return "Please sign in again"
        case .notFound(let message): return message
        case .paymentRequired: return "Upgrade your plan to continue"
        case .rateLimited: return "Too many requests, please wait"
        case .privacyBlocked(let message): return message
        case .server(let code, let msg): return "Error \(code): \(msg)"
        }
    }
}

private extension NetworkScope {
    static func taskScope(type: String, params: [String: Any]) -> NetworkScope? {
        switch type {
        case "call", "customer_service", "cancel_service", "request_refund", "complaint", "cancel_subscription":
            return .callExecution
        case "email", "follow_up":
            return .emailDraft
        case "calendar":
            return .calendarExecution
        case "crypto", "crypto_transfer", "send_crypto":
            let action = (params["action"] as? String) ?? type
            if action == "transfer" || type == "crypto_transfer" || type == "send_crypto" {
                return .walletTransfer
            }
            return .auth
        default:
            return nil
        }
    }
}

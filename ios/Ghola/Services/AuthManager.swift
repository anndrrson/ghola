import SwiftUI
#if os(iOS)
import AuthenticationServices
#endif

@MainActor
class AuthManager: ObservableObject {
    static let shared = AuthManager()

    @Published var isAuthenticated = false
    @Published var isLoading = false
    @Published var profile: UserProfile?
    @Published var error: String?

    private init() {
        Task {
            if await CloudClient.shared.isAuthenticated {
                await loadProfile()
            }
        }
    }

    // MARK: - Email/Password Auth

    func signUp(email: String, password: String, name: String?) async {
        isLoading = true
        error = nil
        defer { isLoading = false }

        do {
            let response = try await CloudClient.shared.emailSignUp(
                email: email,
                password: password,
                displayName: name
            )
            await CloudClient.shared.setToken(response.token)
            await loadProfile()
            await registerDevice()
            isAuthenticated = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    func signIn(email: String, password: String) async {
        isLoading = true
        error = nil
        defer { isLoading = false }

        do {
            let response = try await CloudClient.shared.emailSignIn(
                email: email,
                password: password
            )
            await CloudClient.shared.setToken(response.token)
            await loadProfile()
            await registerDevice()
            isAuthenticated = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    #if os(iOS)
    func signInWithTurnkey(anchor: ASPresentationAnchor) async {
        isLoading = true
        error = nil
        defer { isLoading = false }

        do {
            let session = try await NativeTurnkeyAuth.signIn(anchor: anchor)
            try await finishNativeGholaSignIn(session: session)
        } catch {
            self.error = Self.gholaSignInMessage(for: error)
        }
    }

    func requestGholaEmailCode(email: String) async -> NativeTurnkeyEmailChallenge? {
        isLoading = true
        error = nil
        defer { isLoading = false }

        do {
            return try await NativeTurnkeyAuth.startEmailSignIn(email: email)
        } catch {
            self.error = Self.gholaSignInMessage(for: error)
            return nil
        }
    }

    func completeGholaEmailSignIn(challenge: NativeTurnkeyEmailChallenge, code: String) async {
        isLoading = true
        error = nil
        defer { isLoading = false }

        do {
            let session = try await NativeTurnkeyAuth.completeEmailSignIn(
                challenge: challenge,
                code: code
            )
            try await finishNativeGholaSignIn(session: session)
        } catch {
            self.error = Self.gholaSignInMessage(for: error)
        }
    }

    func signInWithApple(credential: ASAuthorizationAppleIDCredential) async {
        isLoading = true
        error = nil
        defer { isLoading = false }

        guard let tokenData = credential.identityToken,
              let identityToken = String(data: tokenData, encoding: .utf8) else {
            self.error = "Sign in with Apple did not return a valid identity token."
            return
        }

        let fullName = credential.fullName
            .map { PersonNameComponentsFormatter().string(from: $0) }?
            .trimmingCharacters(in: .whitespacesAndNewlines)

        do {
            let response = try await CloudClient.shared.appleSignIn(
                identityToken: identityToken,
                userId: credential.user,
                email: credential.email,
                fullName: fullName?.isEmpty == false ? fullName : nil
            )
            await CloudClient.shared.setToken(response.token)
            await loadProfile()
            await registerDevice()
            isAuthenticated = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func finishNativeGholaSignIn(session: NativeTurnkeySession) async throws {
        let response = try await CloudClient.shared.siwsSignInWithDeviceSigner(
            walletPubkey: session.walletAddress
        ) { challenge in
            try await NativeTurnkeyAuth.signSIWSChallenge(
                challenge,
                walletAddress: session.walletAddress
            )
        }
        await CloudClient.shared.setToken(response.token)
        await loadProfile()
        await registerDevice()
        isAuthenticated = true
    }
    #endif

    private static func gholaSignInMessage(for error: Error) -> String {
        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else {
            return "Ghola couldn't complete sign-in. Please try again."
        }

        let lowercased = message.lowercased()
        if lowercased.contains("turnkey") ||
            lowercased.contains("auth proxy") ||
            lowercased.contains("organization") ||
            lowercased.contains("configured") {
            return "Ghola couldn't complete sign-in. Please try again."
        }

        return message
    }

    // MARK: - Sign Out

    func signOut() {
        Task {
            await CloudClient.shared.clearToken()
        }
        isAuthenticated = false
        profile = nil
    }

    // MARK: - Profile

    func loadProfile() async {
        do {
            let p = try await CloudClient.shared.getProfile()
            profile = p
            isAuthenticated = true
        } catch {
            isAuthenticated = false
            await CloudClient.shared.clearToken()
        }
    }

    // MARK: - Device Registration

    func registerDevice(pushToken: String? = nil) async {
        #if os(iOS)
        let platform = "ios"
        #elseif os(macOS)
        let platform = "macos"
        #else
        let platform = "ios"
        #endif

        let deviceName: String
        #if os(iOS)
        deviceName = await UIDevice.current.name
        #elseif os(macOS)
        deviceName = Host.current().localizedName ?? "Mac"
        #endif

        do {
            try await CloudClient.shared.registerDevice(
                platform: platform,
                deviceName: deviceName,
                pushToken: pushToken
            )
        } catch {
            // Non-critical
        }
    }
}

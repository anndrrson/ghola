import SwiftUI

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

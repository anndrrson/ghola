#if os(iOS)
import AuthenticationServices
import Foundation
import TurnkeySwift

struct NativeTurnkeySession {
    let walletAddress: String
    let walletId: String?
    let provider: String
    let displayName: String
}

struct NativeTurnkeyEmailChallenge: Sendable {
    let email: String
    let otpId: String
    let otpEncryptionTargetBundle: String
}

enum NativeTurnkeyAuthError: LocalizedError {
    case missingConfiguration
    case noPresentationAnchor
    case noSolanaWallet
    case invalidSignature
    case invalidEmail
    case invalidCode

    var errorDescription: String? {
        switch self {
        case .missingConfiguration:
            return "Ghola is not ready on this build yet."
        case .noPresentationAnchor:
            return "Couldn't open sign-in."
        case .noSolanaWallet:
            return "Ghola wallet is not ready."
        case .invalidSignature:
            return "Ghola could not complete wallet approval."
        case .invalidEmail:
            return "Enter a valid email."
        case .invalidCode:
            return "Enter the code from your email."
        }
    }
}

enum NativeTurnkeyAuth {
    private static let sessionKey = "ghola-ios-auth"
    private static let solanaPath = "m/44'/501'/0'/0'"
    private static let walletAddressKey = "ghola_wallet_address"
    private static let walletIdKey = "ghola_wallet_id"
    private static let providerKey = "ghola_provider"
    private static let displayNameKey = "ghola_display_name"
    private static let defaultOrganizationId = "c518c546-674f-466d-86dc-17ed819da23f"
    private static let defaultAuthProxyConfigId = "c488409f-bfac-4dd9-a935-b32488591646"

    struct RuntimeConfig {
        let organizationId: String
        let authProxyConfigId: String
        let rpId: String
        let appScheme: String

        var isConfigured: Bool {
            !organizationId.isEmpty && !authProxyConfigId.isEmpty && !rpId.isEmpty
        }
    }

    static func configure() {
        let config = runtimeConfig
        TurnkeyContext.configure(
            TurnkeyConfig(
                organizationId: config.organizationId,
                authProxyConfigId: config.authProxyConfigId.isEmpty ? nil : config.authProxyConfigId,
                rpId: config.rpId,
                auth: .init(
                    oauth: .init(appScheme: config.appScheme),
                    autoRefreshSession: true,
                    passkey: .init(passkeyName: "Ghola", rpId: config.rpId, rpName: "Ghola")
                ),
                autoRefreshManagedState: true
            )
        )
    }

    static var runtimeConfig: RuntimeConfig {
        RuntimeConfig(
            organizationId: configuredValue("GHOLATurnkeyOrganizationID", env: "GHOLA_TURNKEY_ORG_ID", fallback: defaultOrganizationId),
            authProxyConfigId: configuredValue("GHOLATurnkeyAuthProxyConfigID", env: "GHOLA_TURNKEY_AUTH_PROXY_CONFIG_ID", fallback: defaultAuthProxyConfigId),
            rpId: configuredValue("GHOLATurnkeyRPID", env: "GHOLA_TURNKEY_RP_ID", fallback: "ghola.xyz"),
            appScheme: configuredValue("GHOLATurnkeyAppScheme", env: "GHOLA_TURNKEY_APP_SCHEME", fallback: "ghola")
        )
    }

    static var isConfigured: Bool {
        runtimeConfig.isConfigured
    }

    @MainActor
    static func signIn(anchor: ASPresentationAnchor) async throws -> NativeTurnkeySession {
        guard isConfigured else {
            throw NativeTurnkeyAuthError.missingConfiguration
        }

        let turnkey = TurnkeyContext.shared
        if turnkey.authState != .authenticated {
            do {
                _ = try await turnkey.loginWithPasskey(anchor: anchor, sessionKey: sessionKey)
            } catch {
                _ = try await turnkey.signUpWithPasskey(
                    anchor: anchor,
                    passkeyDisplayName: "Ghola",
                    sessionKey: sessionKey
                )
            }
        }

        let account = try await resolveSolanaAccount(turnkey)
        let session = NativeTurnkeySession(
            walletAddress: account.address,
            walletId: account.walletId,
            provider: "ghola",
            displayName: "Ghola wallet"
        )
        persist(session)
        return session
    }

    static func startEmailSignIn(email: String) async throws -> NativeTurnkeyEmailChallenge {
        guard isConfigured else {
            throw NativeTurnkeyAuthError.missingConfiguration
        }

        let normalizedEmail = normalizedEmail(email)
        guard isValidEmail(normalizedEmail) else {
            throw NativeTurnkeyAuthError.invalidEmail
        }

        let result = try await TurnkeyContext.shared.initOtp(
            contact: normalizedEmail,
            otpType: .email
        )
        return NativeTurnkeyEmailChallenge(
            email: normalizedEmail,
            otpId: result.otpId,
            otpEncryptionTargetBundle: result.otpEncryptionTargetBundle
        )
    }

    static func completeEmailSignIn(challenge: NativeTurnkeyEmailChallenge, code: String) async throws -> NativeTurnkeySession {
        guard isConfigured else {
            throw NativeTurnkeyAuthError.missingConfiguration
        }

        let normalizedCode = code
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased()
        guard !normalizedCode.isEmpty else {
            throw NativeTurnkeyAuthError.invalidCode
        }

        let turnkey = TurnkeyContext.shared
        if turnkey.authState != .authenticated {
            turnkey.clearSession(for: sessionKey)
            _ = try await turnkey.completeOtp(
                otpId: challenge.otpId,
                otpCode: normalizedCode,
                otpEncryptionTargetBundle: challenge.otpEncryptionTargetBundle,
                contact: challenge.email,
                otpType: .email,
                sessionKey: sessionKey
            )
        }

        let account = try await resolveSolanaAccount(turnkey)
        let session = NativeTurnkeySession(
            walletAddress: account.address,
            walletId: account.walletId,
            provider: "ghola",
            displayName: "Ghola wallet"
        )
        persist(session)
        return session
    }

    static func signSIWSChallenge(_ challenge: String, walletAddress: String) async throws -> String {
        let signature = try await TurnkeyContext.shared.signRawPayload(
            signWith: walletAddress,
            payload: Data(challenge.utf8).hexString,
            encoding: .payload_encoding_hexadecimal,
            hashFunction: .hash_function_not_applicable
        )

        guard let signatureBytes = Data(hexString: signature.r + signature.s),
              signatureBytes.count == 64 else {
            throw NativeTurnkeyAuthError.invalidSignature
        }
        return signatureBytes.base64EncodedString()
    }

    private static func resolveSolanaAccount(_ turnkey: TurnkeyContext) async throws -> WalletAccount {
        try? await turnkey.refreshWallets()
        if let account = turnkey.wallets.flatMap(\.accounts).first(where: { $0.addressFormat == .address_format_solana }) {
            return account
        }

        try await turnkey.createWallet(
            walletName: "Ghola Wallet",
            accounts: [solanaAccountParams()],
            mnemonicLength: 12
        )
        guard let account = turnkey.wallets.flatMap(\.accounts).first(where: { $0.addressFormat == .address_format_solana }) else {
            throw NativeTurnkeyAuthError.noSolanaWallet
        }
        return account
    }

    private static func solanaAccountParams() -> WalletAccountParams {
        WalletAccountParams(
            addressFormat: .address_format_solana,
            curve: .curve_ed25519,
            path: solanaPath,
            pathFormat: .path_format_bip32
        )
    }

    private static func persist(_ session: NativeTurnkeySession) {
        KeychainHelper.save(session.walletAddress, for: walletAddressKey)
        if let walletId = session.walletId {
            KeychainHelper.save(walletId, for: walletIdKey)
        }
        KeychainHelper.save(session.provider, for: providerKey)
        KeychainHelper.save(session.displayName, for: displayNameKey)
    }

    private static func configuredValue(_ plistKey: String, env: String, fallback: String = "") -> String {
        let plistValue = Bundle.main.object(forInfoDictionaryKey: plistKey) as? String
        let envValue = ProcessInfo.processInfo.environment[env]
        return (plistValue?.nilIfPlaceholder ?? envValue?.nilIfPlaceholder ?? fallback)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func normalizedEmail(_ email: String) -> String {
        email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private static func isValidEmail(_ email: String) -> Bool {
        let parts = email.split(separator: "@", omittingEmptySubsequences: true)
        guard parts.count == 2,
              parts[0].count >= 1,
              parts[1].contains(".") else {
            return false
        }
        return true
    }
}

private extension String {
    var nilIfPlaceholder: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              !trimmed.hasPrefix("$("),
              !trimmed.hasPrefix("<") else {
            return nil
        }
        return trimmed
    }
}

private extension Data {
    init?(hexString: String) {
        let clean = hexString
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "0x", with: "")
        guard clean.count.isMultiple(of: 2) else { return nil }

        var bytes: [UInt8] = []
        bytes.reserveCapacity(clean.count / 2)

        var index = clean.startIndex
        while index < clean.endIndex {
            let next = clean.index(index, offsetBy: 2)
            guard let byte = UInt8(clean[index..<next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        self.init(bytes)
    }

    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
#endif

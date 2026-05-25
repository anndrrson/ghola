import Foundation
import Security

enum KeychainHelper {
    static let service = "xyz.ghola.app"

    static func save(_ data: Data, for key: String) -> Bool {
        delete(key)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
            // SECURITY: these items hold the Ed25519 signing key, X25519
            // agreement key, AES local-store key, and the private-payment
            // signing key. WhenUnlockedThisDeviceOnly keeps them out of
            // encrypted device backups and prevents restore onto another
            // device; Synchronizable=false keeps them off iCloud Keychain.
            // No background-access need exists (sign/decrypt happen in
            // foreground user flows), so the strictest "WhenUnlocked" tier
            // is correct rather than "AfterFirstUnlock".
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecAttrSynchronizable as String: false,
        ]
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    static func save(_ string: String, for key: String) -> Bool {
        guard let data = string.data(using: .utf8) else { return false }
        return save(data, for: key)
    }

    static func load(_ key: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else { return nil }
        return result as? Data
    }

    static func loadString(_ key: String) -> String? {
        guard let data = load(key) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func delete(_ key: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        return SecItemDelete(query as CFDictionary) == errSecSuccess
    }
}

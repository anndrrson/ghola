import Foundation
import SwiftUI

struct WalletContact: Codable, Identifiable, Equatable, Hashable {
    let id: UUID
    let displayName: String
    let handle: String?
    let address: String
    let shieldedAddress: String?
    let messagingDID: String?
    let messagingDeviceKeys: [NativeMessagingDeviceKey]
    let messagingRelayURLs: [String]
    let messagingVerificationState: NativeMessagingVerificationState
    let createdAt: Date
    let updatedAt: Date

    var subtitle: String {
        if let handle, !handle.isEmpty {
            return "@\(handle)"
        }
        return maskWalletContactAddress(address)
    }

    var shieldedSubtitle: String {
        guard let shieldedAddress, !shieldedAddress.isEmpty else {
            return "No private address"
        }
        return maskWalletContactAddress(shieldedAddress)
    }

    var canReceiveNativeMessages: Bool {
        messagingDID?.isEmpty == false && !messagingDeviceKeys.isEmpty
    }

    static func make(
        id: UUID = UUID(),
        displayName: String,
        handle: String?,
        address: String,
        shieldedAddress: String? = nil,
        now: Date = Date()
    ) throws -> WalletContact {
        let normalizedName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedName.isEmpty else {
            throw WalletContactError.invalidName
        }

        let normalizedAddress = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard SolanaAddressValidator.looksValid(normalizedAddress) else {
            throw WalletContactError.invalidAddress
        }

        let normalizedHandle = handle?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "@"))
            .lowercased()
        let normalizedShielded = shieldedAddress?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let normalizedShielded, !normalizedShielded.isEmpty,
           (!normalizedShielded.starts(with: "aleo1") || normalizedShielded.count < 32) {
            throw WalletContactError.invalidShieldedAddress
        }

        return WalletContact(
            id: id,
            displayName: normalizedName,
            handle: normalizedHandle?.isEmpty == true ? nil : normalizedHandle,
            address: normalizedAddress,
            shieldedAddress: normalizedShielded?.isEmpty == true ? nil : normalizedShielded,
            messagingDID: nil,
            messagingDeviceKeys: [],
            messagingRelayURLs: [],
            messagingVerificationState: .unverified,
            createdAt: now,
            updatedAt: now
        )
    }

    func updatingMessagingProfile(
        did: String?,
        deviceKeys: [NativeMessagingDeviceKey],
        relayURLs: [String],
        verificationState: NativeMessagingVerificationState,
        now: Date = Date()
    ) -> WalletContact {
        WalletContact(
            id: id,
            displayName: displayName,
            handle: handle,
            address: address,
            shieldedAddress: shieldedAddress,
            messagingDID: did?.trimmingCharacters(in: .whitespacesAndNewlines),
            messagingDeviceKeys: deviceKeys,
            messagingRelayURLs: relayURLs.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty },
            messagingVerificationState: verificationState,
            createdAt: createdAt,
            updatedAt: now
        )
    }
}

enum WalletContactError: LocalizedError {
    case invalidName
    case invalidAddress
    case invalidShieldedAddress
    case persistenceFailed

    var errorDescription: String? {
        switch self {
        case .invalidName:
            return "Enter a contact name."
        case .invalidAddress:
            return "Enter a valid Solana wallet address."
        case .invalidShieldedAddress:
            return "Enter a valid Aleo private address."
        case .persistenceFailed:
            return "Could not save this contact locally."
        }
    }
}

enum WalletContactsCodec {
    static func encode(_ contacts: [WalletContact]) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(contacts)
    }

    static func decode(_ data: Data) throws -> [WalletContact] {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode([WalletContact].self, from: data)
    }
}

@MainActor
final class WalletContactsStore: ObservableObject {
    private static let storageKey = "wallet_contacts_v1"

    @Published private(set) var contacts: [WalletContact] = []

    init() {
        reload()
    }

    func reload() {
        guard let data = KeychainHelper.load(Self.storageKey),
              let decoded = try? WalletContactsCodec.decode(data) else {
            contacts = []
            return
        }
        contacts = decoded.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    func saveContact(displayName: String, handle: String?, address: String, shieldedAddress: String? = nil) throws {
        let newContact = try WalletContact.make(
            displayName: displayName,
            handle: handle,
            address: address,
            shieldedAddress: shieldedAddress
        )
        if let existingIndex = contacts.firstIndex(where: { $0.address == newContact.address }) {
            let existing = contacts[existingIndex]
            contacts[existingIndex] = WalletContact(
                id: existing.id,
                displayName: newContact.displayName,
                handle: newContact.handle,
                address: newContact.address,
                shieldedAddress: newContact.shieldedAddress ?? existing.shieldedAddress,
                messagingDID: existing.messagingDID,
                messagingDeviceKeys: existing.messagingDeviceKeys,
                messagingRelayURLs: existing.messagingRelayURLs,
                messagingVerificationState: existing.messagingVerificationState,
                createdAt: existing.createdAt,
                updatedAt: Date()
            )
        } else {
            contacts.append(newContact)
        }
        contacts.sort { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
        try persist()
    }

    func delete(_ contact: WalletContact) {
        contacts.removeAll { $0.id == contact.id }
        try? persist()
    }

    func contact(for address: String) -> WalletContact? {
        let normalized = address.trimmingCharacters(in: .whitespacesAndNewlines)
        return contacts.first { $0.address == normalized }
    }

    func saveMessagingProfile(
        for contact: WalletContact,
        did: String?,
        deviceKeys: [NativeMessagingDeviceKey],
        relayURLs: [String],
        verificationState: NativeMessagingVerificationState
    ) throws {
        guard let index = contacts.firstIndex(where: { $0.id == contact.id }) else {
            throw WalletContactError.persistenceFailed
        }
        contacts[index] = contact.updatingMessagingProfile(
            did: did,
            deviceKeys: deviceKeys,
            relayURLs: relayURLs,
            verificationState: verificationState
        )
        contacts.sort { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
        try persist()
    }

    private func persist() throws {
        let data = try WalletContactsCodec.encode(contacts)
        guard KeychainHelper.save(data, for: Self.storageKey) else {
            throw WalletContactError.persistenceFailed
        }
    }
}

struct PendingPrivateTransfer: Codable, Identifiable, Equatable {
    let id: UUID
    let recipientAddress: String
    let recipientPreview: String
    let amountMicroUSDC: Int64
    let network: String
    let asset: String
    let createdAt: Date
    let expiresAt: Date?
}

@MainActor
final class PrivateTransferIntentStore: ObservableObject {
    private static let storageKey = "private_transfer_intents_v1"

    @Published private(set) var intents: [PendingPrivateTransfer] = []

    init() {
        reload()
    }

    func reload() {
        guard let data = KeychainHelper.load(Self.storageKey),
              let decoded = try? WalletContactsCodec.decodePendingPrivateTransfers(data) else {
            intents = []
            return
        }
        intents = decoded.sorted { $0.createdAt > $1.createdAt }
    }

    func save(intent response: PrivateTransferIntentResponse, recipientAddress: String) {
        let pending = PendingPrivateTransfer(
            id: response.id,
            recipientAddress: recipientAddress.trimmingCharacters(in: .whitespacesAndNewlines),
            recipientPreview: response.recipientPreview,
            amountMicroUSDC: response.amountMicroUSDC,
            network: response.network,
            asset: response.asset,
            createdAt: Date(),
            expiresAt: ISO8601DateFormatter().date(from: response.expiresAt)
        )
        intents.removeAll { $0.id == pending.id }
        intents.insert(pending, at: 0)
        try? persist()
    }

    func intent(for id: UUID) -> PendingPrivateTransfer? {
        intents.first { $0.id == id }
    }

    func remove(_ intent: PendingPrivateTransfer) {
        intents.removeAll { $0.id == intent.id }
        try? persist()
    }

    func remove(id: UUID) {
        intents.removeAll { $0.id == id }
        try? persist()
    }

    private func persist() throws {
        let data = try WalletContactsCodec.encodePendingPrivateTransfers(intents)
        guard KeychainHelper.save(data, for: Self.storageKey) else {
            throw WalletContactError.persistenceFailed
        }
    }
}

extension WalletContactsCodec {
    static func encodePendingPrivateTransfers(_ intents: [PendingPrivateTransfer]) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(intents)
    }

    static func decodePendingPrivateTransfers(_ data: Data) throws -> [PendingPrivateTransfer] {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode([PendingPrivateTransfer].self, from: data)
    }
}

func maskWalletContactAddress(_ raw: String) -> String {
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard value.count > 12 else { return value.isEmpty ? "Not set" : value }
    return "\(value.prefix(4))...\(value.suffix(4))"
}

import Foundation

@MainActor
final class NativeMessagingStore: ObservableObject {
    private static let storageKey = "native_messages_v1"

    @Published private(set) var messages: [NativeMessage] = []

    private let keyStore: NativeMessagingKeyStore
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    init(keyStore: NativeMessagingKeyStore = .shared) {
        self.keyStore = keyStore
        reload()
    }

    func reload() {
        guard let data = KeychainHelper.load(Self.storageKey),
              let decoded = try? decoder.decode([NativeMessage].self, from: data) else {
            messages = []
            return
        }
        messages = decoded.sorted { $0.sentAt < $1.sentAt }
    }

    func messages(for contact: WalletContact) -> [NativeMessage] {
        messages.filter { $0.contactId == contact.id }.sorted { $0.sentAt < $1.sentAt }
    }

    func plaintext(for message: NativeMessage) -> String {
        (try? keyStore.decryptFromLocalStore(message.localCiphertextBase64)) ?? "[Unable to decrypt local message]"
    }

    func saveOutbound(
        plaintext: String,
        contact: WalletContact,
        envelope: NativeMessageEnvelope,
        state: NativeMessageDeliveryState
    ) throws -> NativeMessage {
        let localCiphertext = try keyStore.encryptForLocalStore(plaintext)
        let message = NativeMessage(
            id: envelope.id,
            contactId: contact.id,
            direction: .outbound,
            envelope: envelope,
            localCiphertextBase64: localCiphertext,
            sentAt: envelope.createdAt,
            receivedAt: nil,
            deliveryState: state
        )
        messages.append(message)
        try persist()
        return message
    }

    func saveInbound(
        plaintext: String,
        contact: WalletContact,
        envelope: NativeMessageEnvelope
    ) throws {
        guard !messages.contains(where: { $0.envelope.relayMessageId == envelope.relayMessageId && envelope.relayMessageId != nil }) else {
            return
        }
        let localCiphertext = try keyStore.encryptForLocalStore(plaintext)
        messages.append(
            NativeMessage(
                id: envelope.id,
                contactId: contact.id,
                direction: .inbound,
                envelope: envelope,
                localCiphertextBase64: localCiphertext,
                sentAt: envelope.createdAt,
                receivedAt: Date(),
                deliveryState: .delivered
            )
        )
        try persist()
    }

    func mark(_ message: NativeMessage, as state: NativeMessageDeliveryState) {
        guard let index = messages.firstIndex(where: { $0.id == message.id }) else { return }
        messages[index].deliveryState = state
        try? persist()
    }

    func unreadCount() -> Int {
        messages.filter { $0.direction == .inbound && $0.deliveryState == .delivered }.count
    }

    func containsMessage(id: UUID) -> Bool {
        messages.contains { $0.id == id }
    }

    private func persist() throws {
        messages.sort { $0.sentAt < $1.sentAt }
        let data = try encoder.encode(messages)
        guard KeychainHelper.save(data, for: Self.storageKey) else {
            throw NativeMessagingError.persistenceFailed
        }
    }
}

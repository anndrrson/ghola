import Foundation

@MainActor
final class NativeMessagingController: ObservableObject {
    @Published private(set) var identity: NativeMessagingIdentity?
    @Published private(set) var isSyncing = false
    @Published var notice: String?

    let store: NativeMessagingStore

    private let keyStore: NativeMessagingKeyStore
    private let relayClient: NativeMessagingRelayClient

    init(
        store: NativeMessagingStore? = nil,
        keyStore: NativeMessagingKeyStore = .shared,
        relayClient: NativeMessagingRelayClient = .shared
    ) {
        self.store = store ?? NativeMessagingStore()
        self.keyStore = keyStore
        self.relayClient = relayClient
        self.identity = try? keyStore.identity()
    }

    func prepareIdentity() {
        do {
            identity = try keyStore.identity()
        } catch {
            notice = error.localizedDescription
        }
    }

    func publishMyDeviceKeys() async {
        do {
            let current = try keyStore.identity()
            identity = current
            try await relayClient.publishDeviceKeys(identity: current)
            notice = "Device key published."
        } catch {
            notice = error.localizedDescription
        }
    }

    func send(_ plaintext: String, to contact: WalletContact) async {
        do {
            guard contact.messagingVerificationState != .blocked else {
                throw NativeMessagingError.privacyBlocked("This sender is blocked locally.")
            }
            guard let recipientDID = contact.messagingDID, !recipientDID.isEmpty else {
                throw NativeMessagingError.missingRecipientKey
            }
            guard let recipientKey = contact.messagingDeviceKeys.first else {
                throw NativeMessagingError.missingRecipientKey
            }

            let envelope = try keyStore.encryptForRecipient(
                plaintext: plaintext,
                recipientDID: recipientDID,
                recipientKey: recipientKey
            )
            let localMessage = try store.saveOutbound(
                plaintext: plaintext,
                contact: contact,
                envelope: envelope,
                state: .sending
            )

            do {
                _ = try await relayClient.send(envelope)
                store.mark(localMessage, as: .sent)
            } catch {
                store.mark(localMessage, as: .failed)
                throw error
            }
        } catch {
            notice = error.localizedDescription
        }
    }

    func refreshInbox(contacts: [WalletContact]) async {
        isSyncing = true
        defer { isSyncing = false }

        do {
            let items = try await relayClient.inbox()
            for item in items {
                guard let contact = contacts.first(where: { $0.messagingDID == item.envelope.senderDID }),
                      contact.messagingVerificationState != .blocked,
                      let senderKey = contact.messagingDeviceKeys.first(where: { $0.id == item.envelope.senderDeviceId }) else {
                    continue
                }
                let plaintext = try keyStore.decryptEnvelope(item.envelope, senderKey: senderKey)
                try store.saveInbound(plaintext: plaintext, contact: contact, envelope: item.envelope)
                if store.containsMessage(id: item.envelope.id) {
                    try await relayClient.acknowledge(relayMessageId: item.relayMessageId)
                }
            }
        } catch {
            notice = error.localizedDescription
        }
    }
}

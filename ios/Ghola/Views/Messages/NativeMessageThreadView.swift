import SwiftUI
#if os(iOS)
import UIKit
#endif

struct NativeMessageThreadView: View {
    @ObservedObject var controller: NativeMessagingController

    @StateObject private var contactsStore = WalletContactsStore()
    @State private var contact: WalletContact
    @State private var draft = ""
    @State private var showProfileEditor = false
    @State private var showBlockConfirmation = false
    @State private var showReportConfirmation = false
    @State private var notice: String?

    init(contact: WalletContact, controller: NativeMessagingController) {
        self.controller = controller
        _contact = State(initialValue: contact)
    }

    var body: some View {
        VStack(spacing: 0) {
            if isBlocked {
                Label("Blocked locally. New encrypted messages from this DID are ignored.", systemImage: "hand.raised.fill")
                    .font(.caption)
                    .foregroundStyle(Theme.warning)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
                    .padding(.vertical, 10)
                    .background(Theme.cardBg)
            }

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(controller.store.messages(for: contact)) { message in
                            NativeMessageBubble(
                                message: message,
                                plaintext: controller.store.plaintext(for: message)
                            )
                            .id(message.id)
                        }
                    }
                    .padding()
                }
                .background(Theme.appBackgroundGradient.ignoresSafeArea())
                .onChange(of: controller.store.messages(for: contact).count) {
                    if let last = controller.store.messages(for: contact).last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }

            composer
        }
        .navigationTitle(contact.displayName)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button {
                        showProfileEditor = true
                    } label: {
                        Label("Contact Key", systemImage: contact.canReceiveNativeMessages ? "checkmark.shield.fill" : "key.badge.plus")
                    }

                    if isBlocked {
                        Button {
                            saveVerificationState(.unverified)
                        } label: {
                            Label("Unblock Sender", systemImage: "hand.raised.slash")
                        }
                    } else {
                        Button(role: .destructive) {
                            showBlockConfirmation = true
                        } label: {
                            Label("Block Sender", systemImage: "hand.raised.fill")
                        }
                    }

                    Button(role: .destructive) {
                        showReportConfirmation = true
                    } label: {
                        Label("Report Abuse", systemImage: "exclamationmark.bubble.fill")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .onAppear {
            refreshContactFromStore()
        }
        .sheet(isPresented: $showProfileEditor) {
            NativeMessagingContactKeySheet(contact: contact)
        }
        .confirmationDialog("Block this sender?", isPresented: $showBlockConfirmation, titleVisibility: .visible) {
            Button("Block Sender", role: .destructive) {
                saveVerificationState(.blocked)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Ghola will keep this contact locally, stop sending to it, and ignore new ciphertext from its DID.")
        }
        .confirmationDialog("Report abuse?", isPresented: $showReportConfirmation, titleVisibility: .visible) {
            Button("Report Metadata", role: .destructive) {
                Task { await reportAbuseMetadata() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Ghola sends ciphertext metadata only. Message text stays on this device unless you separately choose to disclose it.")
        }
        .alert("Messages", isPresented: noticeBinding) {
            Button("OK", role: .cancel) { notice = nil }
        } message: {
            Text(notice ?? "")
        }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if isBlocked {
                Label("Unblock this sender before sending.", systemImage: "hand.raised.fill")
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if !contact.canReceiveNativeMessages {
                Label("Add this contact's messaging DID and device key before sending.", systemImage: "lock.trianglebadge.exclamationmark")
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            HStack(alignment: .bottom, spacing: 10) {
                TextField("Encrypted message", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)

                Button {
                    let text = draft
                    draft = ""
                    Task { await controller.send(text, to: contact) }
                } label: {
                    Image(systemName: "paperplane.fill")
                        .frame(width: 34, height: 34)
                }
                .buttonStyle(.borderedProminent)
                .disabled(isBlocked || !contact.canReceiveNativeMessages || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding()
        .background(Theme.cardBg)
    }

    private var isBlocked: Bool {
        contact.messagingVerificationState == .blocked
    }

    private var noticeBinding: Binding<Bool> {
        Binding(
            get: { notice != nil },
            set: { if !$0 { notice = nil } }
        )
    }

    private func refreshContactFromStore() {
        contactsStore.reload()
        if let updated = contactsStore.contacts.first(where: { $0.id == contact.id }) {
            contact = updated
        }
    }

    private func saveVerificationState(_ state: NativeMessagingVerificationState) {
        do {
            try contactsStore.saveMessagingProfile(
                for: contact,
                did: contact.messagingDID,
                deviceKeys: contact.messagingDeviceKeys,
                relayURLs: contact.messagingRelayURLs,
                verificationState: state
            )
            refreshContactFromStore()
            notice = state == .blocked ? "Sender blocked locally." : "Sender unblocked."
            if state == .blocked, let did = contact.messagingDID {
                Task {
                    try? await NativeMessagingRelayClient.shared.block(senderDID: did)
                }
            }
        } catch {
            notice = error.localizedDescription
        }
    }

    private func reportAbuseMetadata() async {
        let latestMessages = controller.store.messages(for: contact).suffix(5)
        let latestRelayIds = latestMessages
            .compactMap { $0.envelope.relayMessageId?.uuidString }
            .joined(separator: ",")
        let latestMessageId = latestMessages.last?.envelope.relayMessageId
        let deviceIds = contact.messagingDeviceKeys
            .map(\.id)
            .joined(separator: ",")
        let generatedAt = ISO8601DateFormatter().string(from: Date())
        do {
            let reportID = try await NativeMessagingRelayClient.shared.reportAbuse(
                messageId: latestMessageId,
                senderDID: contact.messagingDID,
                reason: "user_reported_abuse",
                ciphertextMetadata: [
                    "relay_ids": latestRelayIds,
                    "device_key_ids": deviceIds,
                    "generated_at": generatedAt,
                ]
            )
            await MainActor.run {
                notice = "Abuse report sent without message text. Report \(reportID.uuidString.prefix(8))."
            }
        } catch {
            await MainActor.run {
                notice = error.localizedDescription
            }
        }
    }
}

private struct NativeMessageBubble: View {
    let message: NativeMessage
    let plaintext: String

    var body: some View {
        HStack {
            if message.direction == .outbound {
                Spacer(minLength: 44)
            }

            VStack(alignment: message.direction == .outbound ? .trailing : .leading, spacing: 5) {
                Text(plaintext)
                    .font(.body)
                    .foregroundStyle(Theme.textPrimary)
                Label(message.envelope.kind.badgeLabel, systemImage: message.envelope.kind.systemImage)
                    .font(.caption2)
                    .foregroundStyle(message.envelope.kind == .agentGenerated ? Theme.warning : Theme.textSecondary)
                HStack(spacing: 5) {
                    Image(systemName: "lock.fill")
                    Text(message.deliveryState.rawValue.capitalized)
                    Text(message.sentAt, style: .time)
                }
                .font(.caption2)
                .foregroundStyle(Theme.textSecondary)
            }
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(message.direction == .outbound ? Theme.accent.opacity(0.28) : Theme.cardBg)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Theme.cardBorder, lineWidth: 1)
            )

            if message.direction == .inbound {
                Spacer(minLength: 44)
            }
        }
    }
}

private struct NativeMessagingContactKeySheet: View {
    let contact: WalletContact
    @StateObject private var contactsStore = WalletContactsStore()
    @Environment(\.dismiss) private var dismiss

    @State private var did: String
    @State private var deviceKeyId: String
    @State private var signingPublicKey: String
    @State private var publicKey: String
    @State private var relayURL: String
    @State private var verificationState: NativeMessagingVerificationState
    @State private var errorMessage: String?

    init(contact: WalletContact) {
        self.contact = contact
        _did = State(initialValue: contact.messagingDID ?? "")
        _deviceKeyId = State(initialValue: contact.messagingDeviceKeys.first?.id ?? "")
        _signingPublicKey = State(initialValue: contact.messagingDeviceKeys.first?.signingPubkeyBase64 ?? "")
        _publicKey = State(initialValue: contact.messagingDeviceKeys.first?.publicKeyBase64 ?? "")
        _relayURL = State(initialValue: contact.messagingRelayURLs.first ?? NativeMessagingRelayClient.defaultRelayURL)
        _verificationState = State(initialValue: contact.messagingVerificationState)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Messaging DID") {
                    TextField("did:ghola:...", text: $did)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                Section("Device key") {
                    TextField("Device key id", text: $deviceKeyId)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Ed25519 signing key, base64", text: $signingPublicKey, axis: .vertical)
                        .lineLimit(2...5)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("X25519 prekey, base64", text: $publicKey, axis: .vertical)
                        .lineLimit(2...5)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                Section("Relay") {
                    TextField("Relay URL", text: $relayURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Picker("Trust", selection: $verificationState) {
                        ForEach(NativeMessagingVerificationState.allCases, id: \.self) { state in
                            Text(state.label).tag(state)
                        }
                    }
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Contact Key")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                }
            }
        }
    }

    private func save() {
        let normalizedDID = did.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedKeyId = deviceKeyId.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedSigningKey = signingPublicKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedKey = publicKey.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !normalizedDID.isEmpty, !normalizedKeyId.isEmpty, !normalizedKey.isEmpty else {
            errorMessage = "DID, device key id, and public key are required."
            return
        }

        let key = NativeMessagingDeviceKey(
            id: normalizedKeyId,
            signingPubkeyBase64: normalizedSigningKey.isEmpty ? nil : normalizedSigningKey,
            publicKeyBase64: normalizedKey
        )
        do {
            try contactsStore.saveMessagingProfile(
                for: contact,
                did: normalizedDID,
                deviceKeys: [key],
                relayURLs: [relayURL],
                verificationState: verificationState
            )
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

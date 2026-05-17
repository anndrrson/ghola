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
            Button("Open Email Report", role: .destructive) {
                openAbuseReportDraft()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Ghola opens an email draft with sender metadata only. Add message text or screenshots only if you choose to disclose them.")
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
        } catch {
            notice = error.localizedDescription
        }
    }

    private func openAbuseReportDraft() {
        #if os(iOS)
        var components = URLComponents()
        components.scheme = "mailto"
        components.path = "privacy@ghola.xyz"
        components.queryItems = [
            URLQueryItem(name: "subject", value: "Ghola abuse report"),
            URLQueryItem(name: "body", value: abuseReportBody()),
        ]
        guard let url = components.url else {
            notice = "Could not create an abuse report draft."
            return
        }
        UIApplication.shared.open(url) { opened in
            if !opened {
                notice = "No email app is configured. Email privacy@ghola.xyz to report abuse."
            }
        }
        #else
        notice = "Email privacy@ghola.xyz to report abuse."
        #endif
    }

    private func abuseReportBody() -> String {
        let latestRelayIds = controller.store.messages(for: contact)
            .suffix(5)
            .compactMap { $0.envelope.relayMessageId?.uuidString }
            .joined(separator: ", ")
        let deviceIds = contact.messagingDeviceKeys
            .map(\.id)
            .joined(separator: ", ")
        let generatedAt = ISO8601DateFormatter().string(from: Date())
        return """
        Ghola abuse report

        This draft is user-initiated. No message plaintext is attached automatically.

        Contact: \(contact.displayName)
        Sender DID: \(contact.messagingDID ?? "not set")
        Sender device key IDs: \(deviceIds.isEmpty ? "not set" : deviceIds)
        Recent relay message IDs: \(latestRelayIds.isEmpty ? "not available" : latestRelayIds)
        Generated at: \(generatedAt)

        Add only message text, screenshots, or context that you choose to disclose.
        """
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

import SwiftUI
#if os(iOS)
import MessageUI
import UIKit
#endif

struct MessagesView: View {
    @StateObject private var contactsStore = WalletContactsStore()
    @StateObject private var controller = NativeMessagingController()
    @State private var selectedContact: WalletContact?
    @State private var showKeySheet = false
    @State private var showInviteSheet = false

    var body: some View {
        NavigationStack {
            List {
                inviteSection
                identitySection
                contactsSection
            }
            .scrollContentBackground(.hidden)
            .background(Theme.appBackgroundGradient.ignoresSafeArea())
            .navigationTitle("Messages")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItemGroup(placement: .primaryAction) {
                    Button {
                        controller.prepareIdentity()
                        showInviteSheet = true
                    } label: {
                        Image(systemName: "person.badge.plus")
                    }
                    .accessibilityLabel("Invite to Ghola")

                    Button {
                        Task { await controller.refreshInbox(contacts: contactsStore.contacts) }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(controller.isSyncing)
                }
            }
            .task {
                controller.prepareIdentity()
                contactsStore.reload()
                await controller.refreshInbox(contacts: contactsStore.contacts)
            }
            .onAppear {
                contactsStore.reload()
            }
            .refreshable {
                contactsStore.reload()
                await controller.refreshInbox(contacts: contactsStore.contacts)
            }
            .navigationDestination(item: $selectedContact) { contact in
                NativeMessageThreadView(contact: contact, controller: controller)
            }
            .sheet(isPresented: $showKeySheet) {
                NativeMessagingIdentitySheet(identity: controller.identity) {
                    Task { await controller.publishMyDeviceKeys() }
                }
            }
            .sheet(isPresented: $showInviteSheet) {
                NativeMessagingInviteSheet(identity: controller.identity)
            }
            .alert("Messages", isPresented: noticeBinding) {
                Button("OK", role: .cancel) { controller.notice = nil }
            } message: {
                Text(controller.notice ?? "")
            }
        }
    }

    private var inviteSection: some View {
        Section {
            Button {
                controller.prepareIdentity()
                showInviteSheet = true
            } label: {
                Label("Invite by phone number", systemImage: "person.crop.circle.badge.plus")
            }
        } footer: {
            Text("Opens Apple Messages. Phone numbers stay off Ghola Cloud.")
        }
    }

    private var identitySection: some View {
        Section {
            Button {
                showKeySheet = true
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "key.horizontal.fill")
                        .foregroundStyle(Theme.accent)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("My messaging key")
                            .font(.headline)
                        Text(controller.identity?.did ?? "Local key not ready")
                            .font(.caption)
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                }
            }
        } header: {
            Text("End-to-end encryption")
        } footer: {
            Text("Only device keys and ciphertext are sent to the relay. Message text stays local.")
        }
    }

    private var contactsSection: some View {
        Section {
            if contactsStore.contacts.isEmpty {
                ContentUnavailableView(
                    "No wallet contacts",
                    systemImage: "person.crop.circle.badge.plus",
                    description: Text("Add wallet contacts from the Wallet tab, then attach messaging keys here.")
                )
                .listRowBackground(Color.clear)
            } else {
                ForEach(contactsStore.contacts) { contact in
                    Button {
                        selectedContact = contact
                    } label: {
                        NativeMessageContactRow(
                            contact: contact,
                            latestMessage: controller.store.messages(for: contact).last,
                            preview: controller.store.messages(for: contact).last.map(controller.store.plaintext(for:))
                        )
                    }
                    .swipeActions {
                        Button {
                            selectedContact = contact
                        } label: {
                            Label("Message", systemImage: "paperplane.fill")
                        }
                        .tint(Theme.accent)
                    }
                }
            }
        } header: {
            Text("Inbox")
        }
    }

    private var noticeBinding: Binding<Bool> {
        Binding(
            get: { controller.notice != nil },
            set: { if !$0 { controller.notice = nil } }
        )
    }
}

private struct NativeMessagingInviteSheet: View {
    let identity: NativeMessagingIdentity?

    @Environment(\.dismiss) private var dismiss
    @State private var phoneNumber = ""
    @State private var notice: String?
    #if os(iOS) && canImport(MessageUI)
    @State private var showSMSComposer = false
    #endif

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Phone number", text: $phoneNumber)
                        #if os(iOS)
                        .keyboardType(.phonePad)
                        .textContentType(.telephoneNumber)
                        #endif

                    Button {
                        sendInvite()
                    } label: {
                        Label("Send SMS Invite", systemImage: "paperplane.fill")
                    }
                    .disabled(!canSend)

                    #if os(iOS)
                    Button {
                        UIPasteboard.general.string = inviteBody
                        notice = "Invite copied."
                    } label: {
                        Label("Copy Invite", systemImage: "doc.on.doc")
                    }
                    #endif
                } header: {
                    Text("Invite")
                } footer: {
                    Text("Ghola opens a prefilled Apple Messages composer. You choose whether to send.")
                }

                Section("Preview") {
                    Text(inviteBody)
                        .font(.footnote)
                        .textSelection(.enabled)
                }

                if let notice {
                    Section {
                        Text(notice)
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
            }
            .navigationTitle("Invite to Ghola")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            #if os(iOS) && canImport(MessageUI)
            .sheet(isPresented: $showSMSComposer) {
                NativeSMSInviteComposer(
                    recipients: [normalizedPhone],
                    body: inviteBody
                ) { result in
                    showSMSComposer = false
                    switch result {
                    case .sent:
                        notice = "Invite sent."
                        dismiss()
                    case .cancelled:
                        notice = "Invite cancelled."
                    case .failed:
                        notice = "Apple Messages could not send this invite."
                    @unknown default:
                        notice = "Invite finished."
                    }
                }
            }
            #endif
        }
    }

    private var normalizedPhone: String {
        phoneNumber.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var digitCount: Int {
        normalizedPhone.filter(\.isNumber).count
    }

    private var canSend: Bool {
        digitCount >= 7
    }

    private var inviteBody: String {
        var lines = [
            "Join me on Ghola: private AI, encrypted messages, and user-owned agents.",
            "https://ghola.xyz",
        ]
        if let did = identity?.did, !did.isEmpty {
            lines.append("My Ghola DID: \(did)")
        }
        return lines.joined(separator: "\n")
    }

    private func sendInvite() {
        #if os(iOS) && canImport(MessageUI)
        guard MFMessageComposeViewController.canSendText() else {
            notice = "This device cannot send SMS. Copy the invite instead."
            return
        }
        showSMSComposer = true
        #else
        notice = "SMS invites are available on iPhone."
        #endif
    }
}

#if os(iOS) && canImport(MessageUI)
private struct NativeSMSInviteComposer: UIViewControllerRepresentable {
    let recipients: [String]
    let body: String
    let onFinish: (MessageComposeResult) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onFinish: onFinish)
    }

    func makeUIViewController(context: Context) -> MFMessageComposeViewController {
        let controller = MFMessageComposeViewController()
        controller.recipients = recipients
        controller.body = body
        controller.messageComposeDelegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ uiViewController: MFMessageComposeViewController, context: Context) {}

    final class Coordinator: NSObject, MFMessageComposeViewControllerDelegate {
        let onFinish: (MessageComposeResult) -> Void

        init(onFinish: @escaping (MessageComposeResult) -> Void) {
            self.onFinish = onFinish
        }

        func messageComposeViewController(
            _ controller: MFMessageComposeViewController,
            didFinishWith result: MessageComposeResult
        ) {
            controller.dismiss(animated: true) {
                self.onFinish(result)
            }
        }
    }
}
#endif

private struct NativeMessageContactRow: View {
    let contact: WalletContact
    let latestMessage: NativeMessage?
    let preview: String?

    var body: some View {
        HStack(spacing: 12) {
            ZStack(alignment: .topTrailing) {
                Circle()
                    .fill(Theme.surfaceGradient)
                    .frame(width: 42, height: 42)
                    .overlay {
                        Text(initials)
                            .font(.headline)
                            .foregroundStyle(Theme.textPrimary)
                    }
                if contact.canReceiveNativeMessages {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 10, height: 10)
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(contact.displayName)
                        .font(.headline)
                        .foregroundStyle(Theme.textPrimary)
                    if contact.canReceiveNativeMessages {
                        Image(systemName: "lock.fill")
                            .font(.caption)
                            .foregroundStyle(Theme.accent)
                    }
                }
                Text(preview ?? fallbackSubtitle)
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
            }

            Spacer()

            if let latestMessage {
                VStack(alignment: .trailing, spacing: 4) {
                    Text(latestMessage.sentAt, style: .time)
                        .font(.caption2)
                        .foregroundStyle(Theme.textSecondary)
                    Text(latestMessage.deliveryState.rawValue.capitalized)
                        .font(.caption2)
                        .foregroundStyle(Theme.textSecondary)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var initials: String {
        contact.displayName
            .split(separator: " ")
            .prefix(2)
            .compactMap(\.first)
            .map(String.init)
            .joined()
            .uppercased()
    }

    private var fallbackSubtitle: String {
        contact.messagingVerificationState == .blocked ? "Blocked locally" : contact.subtitle
    }

    private var statusColor: Color {
        switch contact.messagingVerificationState {
        case .verified:
            return .green
        case .blocked:
            return .red
        case .unverified:
            return .yellow
        }
    }
}

private struct NativeMessagingIdentitySheet: View {
    let identity: NativeMessagingIdentity?
    let onPublish: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("DID") {
                    Text(identity?.did ?? "Not ready")
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                }
                Section("Device public key") {
                    Text(identity?.deviceKey.publicKeyBase64 ?? "Not ready")
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                }
                Section {
                    Button {
                        onPublish()
                    } label: {
                        Label("Publish device key", systemImage: "key.fill")
                    }
                }
            }
            .navigationTitle("Messaging Key")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

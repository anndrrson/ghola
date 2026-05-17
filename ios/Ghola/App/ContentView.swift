import Foundation
import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

struct ContentView: View {
    @EnvironmentObject var auth: AuthManager
    @State private var selectedTab = 1 // Chat is default
    #if os(iOS)
    @StateObject private var localBrowser = LocalServerBrowser()
    @State private var showLocalConnect = false
    #endif

    var body: some View {
        if auth.isAuthenticated || CloudClient.isLocalMode {
            #if os(iOS)
            TabView(selection: $selectedTab) {
                HomeView {
                    selectedTab = 1
                }
                    .tabItem {
                        Label("Home", systemImage: "house.fill")
                    }
                    .tag(0)

                ChatView()
                    .tabItem {
                        Label("Chat", systemImage: "bubble.left.and.bubble.right.fill")
                    }
                    .tag(1)

                MessagesView()
                    .tabItem {
                        Label("Messages", systemImage: "person.2.fill")
                    }
                    .tag(2)

                WalletView()
                    .tabItem {
                        Label("Wallet", systemImage: "dollarsign.circle.fill")
                    }
                    .tag(3)
            }
            .tint(Theme.accent)
            .toolbarBackground(Theme.cardBg, for: .tabBar)
            .toolbarColorScheme(.dark, for: .tabBar)
            #elseif os(macOS)
            NavigationSplitView {
                List(selection: $selectedTab) {
                    Label("Home", systemImage: "house.fill").tag(0)
                    Label("Chat", systemImage: "bubble.left.and.bubble.right.fill").tag(1)
                    Label("Messages", systemImage: "person.2.fill").tag(2)
                    Label("Wallet", systemImage: "dollarsign.circle.fill").tag(3)
                    Label("Settings", systemImage: "gearshape.fill").tag(4)
                }
                .navigationTitle("Ghola")
            } detail: {
                switch selectedTab {
                case 0: HomeView {
                    selectedTab = 1
                }
                case 2: MessagesView()
                case 3: WalletView()
                case 4: SettingsView()
                default: ChatView()
                }
            }
            #endif
        } else {
            #if os(iOS)
            OnboardingView()
                .overlay(alignment: .top) {
                    if !localBrowser.discoveredServers.isEmpty {
                        localServerBanner
                    }
                }
                .onAppear { localBrowser.startBrowsing() }
                .onDisappear { localBrowser.stopBrowsing() }
                .sheet(isPresented: $showLocalConnect) {
                    NavigationStack {
                        LocalServerConnectView()
                            .navigationBarTitleDisplayMode(.inline)
                            .toolbar {
                                ToolbarItem(placement: .cancellationAction) {
                                    Button("Cancel") { showLocalConnect = false }
                                }
                            }
                    }
                }
            #else
            OnboardingView()
            #endif
        }
    }

    #if os(iOS)
    private var localServerBanner: some View {
        Button {
            showLocalConnect = true
        } label: {
            HStack {
                Image(systemName: "desktopcomputer")
                Text("Ghola Home server found on your network")
                    .font(.callout)
                Spacer()
                Text("Connect")
                    .fontWeight(.semibold)
            }
            .padding()
            .background(
                RoundedRectangle(cornerRadius: Theme.cornerMd)
                    .fill(Theme.surfaceGradient)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.cornerMd)
                    .stroke(Theme.cardBorder, lineWidth: 1)
            )
            .padding()
        }
        .buttonStyle(.plain)
    }
    #endif
}

struct WalletView: View {
    @StateObject private var contactsStore = WalletContactsStore()
    @State private var walletInfo: WalletInfoResponse?
    @State private var balances: WalletBalancesResponse?
    @State private var history: [WalletTransactionResponse] = []
    @State private var isLoading = false
    @State private var isProvisioning = false
    @State private var isAuthenticated = true
    @State private var showSendSheet = false
    @State private var showReceiveSheet = false
    @State private var showRailInfo = false
    @State private var showAddContact = false
    @State private var selectedSendContact: WalletContact?
    @State private var noticeMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.paddingLg) {
                    if !isAuthenticated {
                        signedOutView
                    } else if walletInfo == nil && !isLoading {
                        provisionView
                    } else {
                        balanceView
                        railStatusRow
                        contactsView
                        historyView
                    }
                }
                .padding(.vertical, Theme.paddingMd)
            }
            .background(Theme.appBackgroundGradient.ignoresSafeArea())
            .navigationTitle("Wallet")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                if walletInfo != nil {
                    Button {
                        Task { await refresh() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(isLoading)
                }
            }
            .task { await refresh() }
            .refreshable { await refresh() }
            .sheet(isPresented: $showSendSheet, onDismiss: { selectedSendContact = nil }) {
                if let walletInfo, let balances {
                    SendUSDCSheet(
                        walletInfo: walletInfo,
                        balances: balances,
                        contacts: contactsStore.contacts,
                        selectedContact: selectedSendContact,
                        onSaveContact: { name, handle, address in
                            try contactsStore.saveContact(displayName: name, handle: handle, address: address)
                        }
                    ) { recipient, amountMicroUSDC, approval in
                        let result = try await CloudClient.shared.sendUSDC(
                            to: recipient,
                            amountMicroUSDC: amountMicroUSDC,
                            approval: approval
                        )
                        await refresh()
                        noticeMessage = "USDC transfer submitted. Signature \(shortHash(result.signature))."
                        return result
                    }
                }
            }
            .sheet(isPresented: $showReceiveSheet) {
                ReceiveUSDCSheet(
                    address: walletInfo?.address ?? balances?.address ?? "",
                    network: currentNetwork
                )
            }
            .sheet(isPresented: $showRailInfo) {
                WalletRailInfoSheet(network: currentNetwork)
            }
            .sheet(isPresented: $showAddContact) {
                AddWalletContactSheet { name, handle, address in
                    try contactsStore.saveContact(displayName: name, handle: handle, address: address)
                }
            }
            .alert("Wallet", isPresented: noticeBinding) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(noticeMessage ?? "")
            }
        }
    }

    private var signedOutView: some View {
        WalletPanel {
            Label("Sign in required", systemImage: "person.crop.circle.badge.exclamationmark")
                .font(Theme.headlineFont)
            Text("Sign in to use USDC payments.")
                .font(Theme.bodyFont)
                .foregroundStyle(Theme.textSecondary)
        }
    }

    private var provisionView: some View {
        WalletPanel {
            Label("Create USDC wallet", systemImage: "wallet.pass")
                .font(Theme.headlineFont)
            Text("Create a Solana USDC wallet. Approval is required before setup.")
                .font(Theme.bodyFont)
                .foregroundStyle(Theme.textSecondary)
            Button {
                provisionWallet()
            } label: {
                Label(isProvisioning ? "Creating..." : "Create Wallet", systemImage: "plus.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(isProvisioning)
        }
    }

    private var balanceView: some View {
        WalletPanel(style: .banded) {
            HStack {
                Text("USDC")
                    .font(Theme.captionFont)
                    .foregroundStyle(Theme.textSecondary)
                Spacer()
                networkChip(currentNetwork)
            }

            Text(formatUSDC(balances?.usdc ?? 0))
                .font(.system(size: 40, weight: .bold, design: .rounded))
                .foregroundStyle(Theme.textPrimary)
                .monospacedDigit()
                .minimumScaleFactor(0.7)
                .lineLimit(1)

            HStack(spacing: Theme.paddingMd) {
                walletActionButton("Send", systemImage: "paperplane.fill") {
                    selectedSendContact = nil
                    showSendSheet = true
                }
                .buttonStyle(.borderedProminent)
                .disabled(walletInfo == nil || balances == nil)

                walletActionButton("Receive", systemImage: "arrow.down.circle.fill") {
                    showReceiveSheet = true
                }
                .buttonStyle(.bordered)
                .disabled(walletInfo == nil && balances == nil)
            }

            Label("\(formatSOL(balances?.sol ?? 0)) SOL for fees", systemImage: "bolt.circle")
                .font(Theme.captionFont)
                .foregroundStyle((balances?.sol ?? 0) > 0 ? Theme.textSecondary : Theme.warning)
        }
    }

    private var contactsView: some View {
        WalletPanel {
            HStack {
                Label("Contacts", systemImage: "person.2.fill")
                    .font(Theme.headlineFont)
                Spacer()
                Button {
                    showAddContact = true
                } label: {
                    Image(systemName: "plus.circle.fill")
                }
                .accessibilityLabel("Add wallet contact")
            }

            if contactsStore.contacts.isEmpty {
                Text("Add Ghola contacts with their Turnkey-backed public wallet address. Names stay on this device.")
                    .font(Theme.captionFont)
                    .foregroundStyle(Theme.textSecondary)
            } else {
                VStack(spacing: Theme.paddingSm) {
                    ForEach(contactsStore.contacts.prefix(4)) { contact in
                        HStack(spacing: Theme.paddingMd) {
                            Button {
                                selectedSendContact = contact
                                showSendSheet = true
                            } label: {
                                HStack(spacing: Theme.paddingMd) {
                                    Image(systemName: "person.crop.circle")
                                        .font(.title3)
                                        .foregroundStyle(Theme.accent)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(contact.displayName)
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(Theme.textPrimary)
                                        Text("\(contact.subtitle) · \(maskAddress(contact.address))")
                                            .font(Theme.captionFont)
                                            .foregroundStyle(Theme.textSecondary)
                                            .lineLimit(1)
                                    }
                                    Spacer()
                                }
                            }
                            .buttonStyle(.plain)

                            Menu {
                                Button("Send USDC") {
                                    selectedSendContact = contact
                                    showSendSheet = true
                                }
                                Button("Delete", role: .destructive) {
                                    contactsStore.delete(contact)
                                }
                            } label: {
                                Image(systemName: "ellipsis.circle")
                                    .foregroundStyle(Theme.textSecondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
        }
    }

    private var railStatusRow: some View {
        WalletPanel {
            Button {
                showRailInfo = true
            } label: {
                HStack(spacing: Theme.paddingMd) {
                    Image(systemName: "shield.lefthalf.filled")
                        .font(.title3)
                        .foregroundStyle(Theme.accent)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Public Solana USDC")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.textPrimary)
                        Text("Ghola never sends without approval.")
                            .font(Theme.captionFont)
                            .foregroundStyle(Theme.textSecondary)
                    }
                    Spacer()
                    Image(systemName: "info.circle")
                        .foregroundStyle(Theme.textSecondary)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Public Solana USDC. Ghola never sends without approval. More information.")
        }
    }

    private var currentNetwork: String {
        walletInfo?.network ?? balances?.network ?? "unknown"
    }

    private var historyView: some View {
        VStack(alignment: .leading, spacing: Theme.paddingMd) {
            Text("Recent Transfers")
                .font(Theme.headlineFont)
                .padding(.horizontal)

            if isLoading && history.isEmpty {
                ProgressView("Loading wallet...")
                    .frame(maxWidth: .infinity)
                    .padding()
            } else if history.isEmpty {
                Text("No transfers yet.")
                    .font(Theme.bodyFont)
                    .foregroundStyle(Theme.textSecondary)
                    .padding(.horizontal)
            } else {
                ForEach(history) { item in
                    WalletHistoryRow(item: item)
                        .padding(.horizontal)
                }
            }
        }
    }

    private var noticeBinding: Binding<Bool> {
        Binding(
            get: { noticeMessage != nil },
            set: { if !$0 { noticeMessage = nil } }
        )
    }

    @MainActor
    private func refresh() async {
        isAuthenticated = await CloudClient.shared.isAuthenticated
        guard isAuthenticated else {
            walletInfo = nil
            balances = nil
            history = []
            return
        }

        isLoading = true
        defer { isLoading = false }

        do {
            async let info = CloudClient.shared.getWalletAddress()
            async let currentBalances = CloudClient.shared.getWalletBalances()
            async let recentHistory = CloudClient.shared.getWalletHistory(limit: 25)
            walletInfo = try await info
            balances = try await currentBalances
            history = try await recentHistory
        } catch CloudError.notFound {
            walletInfo = nil
            balances = nil
            history = []
        } catch {
            noticeMessage = error.localizedDescription
        }
    }

    private func provisionWallet() {
        guard !isProvisioning else { return }
        isProvisioning = true
        let approval = PrivacyGate.makeApproval(
            scope: .walletProvision,
            summary: "Create or reuse a Solana wallet for public USDC payments in Ghola."
        )

        Task {
            do {
                walletInfo = try await CloudClient.shared.provisionWallet(approval: approval)
                await refresh()
            } catch {
                noticeMessage = error.localizedDescription
            }
            isProvisioning = false
        }
    }

    private func shortHash(_ raw: String) -> String {
        guard raw.count > 12 else { return raw }
        return "\(raw.prefix(6))...\(raw.suffix(6))"
    }

    private func walletActionButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .frame(maxWidth: .infinity)
        }
    }

    private func networkChip(_ network: String) -> some View {
        Text(network)
            .font(Theme.captionFont.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Theme.accent.opacity(0.14))
            .clipShape(Capsule())
    }
}

private struct SendUSDCSheet: View {
    let walletInfo: WalletInfoResponse
    let balances: WalletBalancesResponse
    let contacts: [WalletContact]
    let selectedContact: WalletContact?
    let onSaveContact: (String, String?, String) throws -> Void
    let onSend: (String, Int64, PrivacyApproval) async throws -> WalletTransferResponse

    @Environment(\.dismiss) private var dismiss
    @State private var recipient = ""
    @State private var amount = ""
    @State private var isReviewing = false
    @State private var isSending = false
    @State private var showSaveContact = false
    @State private var errorMessage: String?

    init(
        walletInfo: WalletInfoResponse,
        balances: WalletBalancesResponse,
        contacts: [WalletContact],
        selectedContact: WalletContact? = nil,
        onSaveContact: @escaping (String, String?, String) throws -> Void,
        onSend: @escaping (String, Int64, PrivacyApproval) async throws -> WalletTransferResponse
    ) {
        self.walletInfo = walletInfo
        self.balances = balances
        self.contacts = contacts
        self.selectedContact = selectedContact
        self.onSaveContact = onSaveContact
        self.onSend = onSend
        _recipient = State(initialValue: selectedContact?.address ?? "")
    }

    private var trimmedRecipient: String {
        recipient.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var matchedContact: WalletContact? {
        contacts.first { $0.address == trimmedRecipient }
    }

    private var amountMicroUSDC: Int64? {
        USDCAmountParser.microUSDC(from: amount)
    }

    private var balanceMicroUSDC: Int64 {
        max(0, Int64((balances.usdc * 1_000_000).rounded(.down)))
    }

    private var validationMessage: String? {
        guard SolanaAddressValidator.looksValid(trimmedRecipient) else {
            return "Enter a valid Solana recipient address."
        }
        guard let amountMicroUSDC, amountMicroUSDC > 0 else {
            return "Enter a USDC amount greater than zero."
        }
        guard amountMicroUSDC <= balanceMicroUSDC else {
            return "Insufficient USDC balance."
        }
        guard balances.sol > 0 else {
            return "Insufficient SOL fee balance."
        }
        return nil
    }

    private var shouldShowValidation: Bool {
        !trimmedRecipient.isEmpty || !amount.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var confirmTitle: String {
        if isSending { return "Sending..." }
        return isReviewing ? "Approve & Send" : "Review"
    }

    private var confirmDisabled: Bool {
        isSending || (!isReviewing && validationMessage != nil)
    }

    var body: some View {
        NavigationStack {
            Form {
                if isReviewing {
                    reviewSections
                } else {
                    entrySections
                }

                if shouldShowValidation, let validationMessage, !isReviewing {
                    Section {
                        Text(validationMessage)
                            .foregroundStyle(Theme.warning)
                    }
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(Theme.danger)
                    }
                }
            }
            .navigationTitle(isReviewing ? "Approve Send" : "Send USDC")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .scrollContentBackground(.hidden)
            .background(Theme.appBackgroundGradient.ignoresSafeArea())
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(isReviewing ? "Back" : "Cancel") {
                        if isReviewing {
                            isReviewing = false
                        } else {
                            dismiss()
                        }
                    }
                    .disabled(isSending)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(confirmTitle) {
                        if isReviewing {
                            submit()
                        } else {
                            review()
                        }
                    }
                    .disabled(confirmDisabled)
                }
            }
            .sheet(isPresented: $showSaveContact) {
                AddWalletContactSheet(initialAddress: trimmedRecipient, onSave: onSaveContact)
            }
        }
    }

    @ViewBuilder
    private var entrySections: some View {
        if !contacts.isEmpty {
            Section("Contacts") {
                ForEach(contacts) { contact in
                    Button {
                        recipient = contact.address
                    } label: {
                        HStack(spacing: Theme.paddingMd) {
                            Image(systemName: recipient == contact.address ? "checkmark.circle.fill" : "person.crop.circle")
                                .foregroundStyle(recipient == contact.address ? Theme.success : Theme.accent)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(contact.displayName)
                                Text("\(contact.subtitle) · \(maskAddress(contact.address))")
                                    .font(Theme.captionFont)
                                    .foregroundStyle(Theme.textSecondary)
                                    .lineLimit(1)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }

        Section("Send") {
            TextField("Recipient Solana address", text: $recipient, axis: .vertical)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("Amount USDC", text: $amount)
                #if os(iOS)
                .keyboardType(.decimalPad)
                #endif
        }

        if SolanaAddressValidator.looksValid(trimmedRecipient), matchedContact == nil {
            Section {
                Button {
                    showSaveContact = true
                } label: {
                    Label("Save recipient as local contact", systemImage: "person.badge.plus")
                }
            } footer: {
                Text("The contact label is stored only on this device.")
            }
        }

        Section {
            LabeledContent("Available", value: formatUSDC(balances.usdc))
            LabeledContent("Network", value: walletInfo.network)
            LabeledContent("Fees", value: "\(formatSOL(balances.sol)) SOL")
        }
    }

    @ViewBuilder
    private var reviewSections: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text(amountMicroUSDC.map(formatMicroUSDC) ?? "$0.00 USDC")
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .minimumScaleFactor(0.75)
                    .lineLimit(1)
                Text(recipientReviewTitle)
                    .font(Theme.bodyFont)
                    .foregroundStyle(Theme.textSecondary)
            }
            .padding(.vertical, 6)
        }

        Section("Confirm") {
            LabeledContent("Network", value: walletInfo.network)
            LabeledContent("Provider", value: "Ghola Cloud + Solana RPC")
            LabeledContent("Asset", value: "USDC")
        }

        Section {
            Label("Public settlement", systemImage: "exclamationmark.triangle")
                .foregroundStyle(Theme.warning)
            Text("Sender, recipient, amount, and timing are visible on Solana.")
                .font(Theme.captionFont)
                .foregroundStyle(Theme.textSecondary)
            DisclosureGroup("What leaves the device?") {
                Text("Recipient address, amount, wallet address, and your approval for this transfer. Contact names stay on this device.")
                    .font(Theme.captionFont)
                    .foregroundStyle(Theme.textSecondary)
            }
        }
    }

    private var recipientReviewTitle: String {
        if let matchedContact {
            return "To \(matchedContact.displayName) · \(maskAddress(trimmedRecipient))"
        }
        return "To \(maskAddress(trimmedRecipient))"
    }

    private func review() {
        guard validationMessage == nil else { return }
        errorMessage = nil
        isReviewing = true
    }

    private func submit() {
        guard validationMessage == nil,
              let amountMicroUSDC else { return }
        isSending = true
        errorMessage = nil
        let approval = PrivacyGate.makeApproval(
            scope: .walletTransfer,
            summary: "Send \(formatMicroUSDC(amountMicroUSDC)) to \(maskAddress(trimmedRecipient)) on \(walletInfo.network). Public Solana settlement reveals sender, recipient, amount, asset, and timing."
        )

        Task {
            do {
                _ = try await onSend(trimmedRecipient, amountMicroUSDC, approval)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
                isReviewing = false
            }
            isSending = false
        }
    }
}

private struct AddWalletContactSheet: View {
    let initialAddress: String
    let onSave: (String, String?, String) throws -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var displayName = ""
    @State private var handle = ""
    @State private var address = ""
    @State private var errorMessage: String?

    init(initialAddress: String = "", onSave: @escaping (String, String?, String) throws -> Void) {
        self.initialAddress = initialAddress
        self.onSave = onSave
        _address = State(initialValue: initialAddress)
    }

    private var trimmedName: String {
        displayName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedHandle: String {
        handle.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedAddress: String {
        address.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSave: Bool {
        !trimmedName.isEmpty && SolanaAddressValidator.looksValid(trimmedAddress)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Contact") {
                    TextField("Name", text: $displayName)
                        .textContentType(.name)
                    TextField("Ghola handle (optional)", text: $handle)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                Section {
                    TextField("Solana address", text: $address, axis: .vertical)
                        .font(.system(.footnote, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .lineLimit(2...4)
                } header: {
                    Text("Turnkey wallet address")
                } footer: {
                    Text("Stored locally in this device keychain. Ghola Cloud receives only the wallet address if you approve a send.")
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(Theme.captionFont)
                            .foregroundStyle(Theme.danger)
                    }
                }
            }
            .navigationTitle("Add Contact")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .scrollContentBackground(.hidden)
            .background(Theme.appBackgroundGradient.ignoresSafeArea())
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(!canSave)
                }
            }
        }
    }

    private func save() {
        do {
            try onSave(trimmedName, trimmedHandle.isEmpty ? nil : trimmedHandle, trimmedAddress)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct ReceiveUSDCSheet: View {
    let address: String
    let network: String

    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Receive USDC") {
                    Text(address.isEmpty ? "No address" : address)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                    Button {
                        copyAddress()
                    } label: {
                        Label(copied ? "Copied" : "Copy Address", systemImage: copied ? "checkmark" : "doc.on.doc")
                    }
                    .disabled(address.isEmpty)
                }

                Section {
                    LabeledContent("Network", value: network)
                    LabeledContent("Asset", value: "USDC")
                }
            }
            .navigationTitle("Receive")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .scrollContentBackground(.hidden)
            .background(Theme.appBackgroundGradient.ignoresSafeArea())
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func copyAddress() {
        #if canImport(UIKit)
        UIPasteboard.general.string = address
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(address, forType: .string)
        #endif
        copied = true
    }
}

private struct WalletRailInfoSheet: View {
    let network: String

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("Public, not shielded", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(Theme.warning)
                    Text("Solana USDC shows sender, recipient, amount, and timing on-chain.")
                        .font(Theme.captionFont)
                        .foregroundStyle(Theme.textSecondary)
                }

                Section {
                    Label("Approval required", systemImage: "hand.raised")
                        .foregroundStyle(Theme.accent)
                    Text("Ghola sends only after the approval screen for that exact transfer.")
                        .font(Theme.captionFont)
                        .foregroundStyle(Theme.textSecondary)
                }

                Section {
                    LabeledContent("Network", value: network)
                    LabeledContent("Rail", value: "Public Solana USDC")
                }
            }
            .navigationTitle("Payment Privacy")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .scrollContentBackground(.hidden)
            .background(Theme.appBackgroundGradient.ignoresSafeArea())
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

private enum WalletPanelStyle: Equatable {
    case standard
    case banded
}

private struct WalletPanel<Content: View>: View {
    let style: WalletPanelStyle
    @ViewBuilder var content: Content

    init(style: WalletPanelStyle = .standard, @ViewBuilder content: () -> Content) {
        self.style = style
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.paddingMd) {
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.paddingMd)
        .background(
            RoundedRectangle(cornerRadius: Theme.cornerMd)
                .fill(panelFill)
        )
        .overlay(alignment: .bottom) {
            if style == .banded {
                Rectangle()
                    .fill(Theme.brandBandGradient)
                    .frame(height: 6)
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: Theme.cornerMd)
                .stroke(panelStroke, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.cornerMd))
        .shadow(color: panelShadow, radius: style == .banded ? 10 : 0, x: 0, y: 6)
        .padding(.horizontal)
    }

    private var panelFill: AnyShapeStyle {
        switch style {
        case .standard:
            return AnyShapeStyle(Theme.surfaceGradient)
        case .banded:
            return AnyShapeStyle(Theme.brandSurfaceGradient)
        }
    }

    private var panelStroke: AnyShapeStyle {
        switch style {
        case .standard:
            return AnyShapeStyle(Theme.cardBorder)
        case .banded:
            return AnyShapeStyle(Theme.accentStrokeGradient)
        }
    }

    private var panelShadow: Color {
        switch style {
        case .standard:
            return .clear
        case .banded:
            return Theme.cardShadow
        }
    }
}

private struct WalletHistoryRow: View {
    let item: WalletTransactionResponse

    var body: some View {
        HStack(spacing: Theme.paddingMd) {
            Image(systemName: item.status == "confirmed" ? "checkmark.circle.fill" : "clock")
                .foregroundStyle(item.status == "confirmed" ? Theme.success : Theme.warning)
            VStack(alignment: .leading, spacing: 4) {
                Text(formatMicroUSDC(item.amount))
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                Text(item.toAddressPreview ?? "Recipient hidden")
                    .font(Theme.captionFont)
                    .foregroundStyle(Theme.textSecondary)
            }
            Spacer()
            Text(item.status.capitalized)
                .font(Theme.captionFont)
                .foregroundStyle(Theme.textSecondary)
        }
        .padding(Theme.paddingMd)
        .background(
            RoundedRectangle(cornerRadius: Theme.cornerSm)
                .fill(Theme.cardBg)
        )
    }
}

enum USDCAmountParser {
    static func microUSDC(from input: String) -> Int64? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.hasPrefix("-") else { return nil }
        let parts = trimmed.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count <= 2 else { return nil }
        if parts.count == 2 && parts[1].count > 6 { return nil }
        guard let decimal = Decimal(string: trimmed), decimal > 0 else { return nil }
        let microDecimal = decimal * Decimal(1_000_000)
        let number = NSDecimalNumber(decimal: microDecimal)
        guard number != NSDecimalNumber.notANumber else { return nil }
        let value = number.int64Value
        return value > 0 ? value : nil
    }
}

enum SolanaAddressValidator {
    private static let alphabet = Set("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")

    static func looksValid(_ raw: String) -> Bool {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (32...44).contains(value.count) else { return false }
        return value.allSatisfy { alphabet.contains($0) }
    }
}

private func formatUSDC(_ value: Double) -> String {
    if value == 0 { return "$0.00 USDC" }
    if value < 0.01 {
        return String(format: "$%.6f USDC", value)
    }
    return String(format: "$%.2f USDC", value)
}

private func formatMicroUSDC(_ microUSDC: Int64) -> String {
    formatUSDC(Double(microUSDC) / 1_000_000.0)
}

private func formatSOL(_ value: Double) -> String {
    if value == 0 { return "0" }
    if value < 0.001 {
        return String(format: "%.6f", value)
    }
    return String(format: "%.4f", value)
}

private func maskAddress(_ raw: String) -> String {
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard value.count > 12 else { return value.isEmpty ? "Not set" : value }
    return "\(value.prefix(4))...\(value.suffix(4))"
}

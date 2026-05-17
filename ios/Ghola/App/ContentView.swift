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

private enum WalletRailSelection: String, CaseIterable, Identifiable {
    case publicUSDC
    case privateUSDCx

    var id: String { rawValue }

    var title: String {
        switch self {
        case .publicUSDC: return "Public USDC"
        case .privateUSDCx: return "Private USDCx"
        }
    }
}

struct WalletView: View {
    @StateObject private var contactsStore = WalletContactsStore()
    @StateObject private var privateIntentStore = PrivateTransferIntentStore()
    @State private var walletInfo: WalletInfoResponse?
    @State private var balances: WalletBalancesResponse?
    @State private var history: [WalletTransactionResponse] = []
    @State private var privateHistory: [PrivateTransferHistoryResponse] = []
    @State private var paymentHealth: PaymentHealthResponse?
    @State private var selectedRail: WalletRailSelection = .publicUSDC
    @State private var isLoading = false
    @State private var isProvisioning = false
    @State private var isAuthenticated = true
    @State private var showSendSheet = false
    @State private var showReceiveSheet = false
    @State private var showRailInfo = false
    @State private var showAddContact = false
    @State private var selectedSendContact: WalletContact?
    @State private var proofIntent: PendingPrivateTransfer?
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
                if selectedRail == .privateUSDCx {
                    SendPrivateUSDCxSheet(
                        railStatus: paymentHealth?.privateUSDCx,
                        selectedContact: selectedSendContact
                    ) { recipient, amountMicroUSDC, approval in
                        let intent = try await CloudClient.shared.createPrivateUSDCxIntent(
                            to: recipient,
                            amountMicroUSDC: amountMicroUSDC,
                            approval: approval
                        )
                        privateIntentStore.save(intent: intent, recipientAddress: recipient)
                        await refresh()
                        noticeMessage = "Private USDCx intent created. Send on Aleo, then tap the pending transfer to verify it."
                        return intent
                    }
                } else if let walletInfo, let balances {
                    SendUSDCSheet(
                        walletInfo: walletInfo,
                        balances: balances,
                        contacts: contactsStore.contacts,
                        selectedContact: selectedSendContact,
                        onSaveContact: { name, handle, address, shieldedAddress in
                            try contactsStore.saveContact(displayName: name, handle: handle, address: address, shieldedAddress: shieldedAddress)
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
                WalletRailInfoSheet(network: currentNetwork, privateStatus: paymentHealth?.privateUSDCx)
            }
            .sheet(item: $proofIntent) { intent in
                SubmitPrivateUSDCxProofSheet(intent: intent) { txID, approval in
                    let proof = ShieldedPaymentProof(
                        network: intent.network,
                        payload: ShieldedPaymentProofPayload(
                            txSignature: txID,
                            shieldedReceiptId: txID,
                            proofB64: nil,
                            nullifierHex: nil
                        )
                    )
                    let result = try await CloudClient.shared.submitPrivateUSDCxProof(
                        intentId: intent.id,
                        to: intent.recipientAddress,
                        proof: proof,
                        approval: approval
                    )
                    privateIntentStore.remove(intent)
                    await refresh()
                    noticeMessage = "Private USDCx verified for \(result.recipientPreview)."
                    return result
                }
            }
            .sheet(isPresented: $showAddContact) {
                AddWalletContactSheet { name, handle, address, shieldedAddress in
                    try contactsStore.saveContact(displayName: name, handle: handle, address: address, shieldedAddress: shieldedAddress)
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
            Picker("Payment rail", selection: $selectedRail) {
                ForEach(WalletRailSelection.allCases) { rail in
                    Text(rail.title).tag(rail)
                }
            }
            .pickerStyle(.segmented)

            HStack {
                Text(selectedRail == .privateUSDCx ? "USDCx" : "USDC")
                    .font(Theme.captionFont)
                    .foregroundStyle(Theme.textSecondary)
                Spacer()
                networkChip(selectedRail == .privateUSDCx ? privateRailNetwork : currentNetwork)
            }

            Text(selectedRail == .privateUSDCx ? privateRailHeadline : formatUSDC(balances?.usdc ?? 0))
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
                .disabled(sendDisabled)

                walletActionButton("Receive", systemImage: "arrow.down.circle.fill") {
                    showReceiveSheet = true
                }
                .buttonStyle(.bordered)
                .disabled(walletInfo == nil && balances == nil)
            }

            if selectedRail == .privateUSDCx {
                Label(privateRailDetail, systemImage: privateRailReady ? "lock.shield.fill" : "lock.trianglebadge.exclamationmark")
                    .font(Theme.captionFont)
                    .foregroundStyle(privateRailReady ? Theme.textSecondary : Theme.warning)
            } else {
                Label("\(formatSOL(balances?.sol ?? 0)) SOL for fees", systemImage: "bolt.circle")
                    .font(Theme.captionFont)
                    .foregroundStyle((balances?.sol ?? 0) > 0 ? Theme.textSecondary : Theme.warning)
            }
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
                Text("Add Ghola contacts with public wallet and optional private USDCx addresses. Names stay on this device.")
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
                                        Text("\(contact.subtitle) · \(contact.shieldedSubtitle)")
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
                                    selectedRail = .publicUSDC
                                    selectedSendContact = contact
                                    showSendSheet = true
                                }
                                Button("Send Private USDCx") {
                                    selectedRail = .privateUSDCx
                                    selectedSendContact = contact
                                    showSendSheet = true
                                }
                                .disabled(contact.shieldedAddress == nil || !privateRailReady)
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
                    Image(systemName: privateRailReady ? "lock.shield.fill" : "shield.lefthalf.filled")
                        .font(.title3)
                        .foregroundStyle(privateRailReady ? Theme.success : Theme.accent)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(privateRailReady ? "Private USDCx available" : "Public USDC active")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.textPrimary)
                        Text(privateRailReady ? "Shielded sends stay on the Aleo USDCx rail." : "Private USDCx will not fall back to public Solana.")
                            .font(Theme.captionFont)
                            .foregroundStyle(Theme.textSecondary)
                    }
                    Spacer()
                    Image(systemName: "info.circle")
                        .foregroundStyle(Theme.textSecondary)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Payment rail status. More information.")
        }
    }

    private var currentNetwork: String {
        walletInfo?.network ?? balances?.network ?? "unknown"
    }

    private var privateRailStatus: PaymentRailStatus? {
        paymentHealth?.privateUSDCx
    }

    private var privateRailReady: Bool {
        privateRailStatus?.isReady == true
    }

    private var privateRailNetwork: String {
        privateRailStatus?.network ?? "aleo"
    }

    private var privateRailHeadline: String {
        privateRailReady ? "Private ready" : "Setup required"
    }

    private var privateRailDetail: String {
        if privateRailReady {
            return "USDCx sends use the Aleo shielded rail."
        }
        return privateRailStatus?.unavailableReason ?? "Private USDCx is fail-closed until the Aleo adapter is configured."
    }

    private var sendDisabled: Bool {
        if selectedRail == .privateUSDCx {
            return !privateRailReady
        }
        return walletInfo == nil || balances == nil
    }

    private var historyView: some View {
        VStack(alignment: .leading, spacing: Theme.paddingMd) {
            Text(selectedRail == .privateUSDCx ? "Private Transfers" : "Recent Transfers")
                .font(Theme.headlineFont)
                .padding(.horizontal)

            if selectedRail == .privateUSDCx {
                privateHistoryContent
            } else if isLoading && history.isEmpty {
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

    @ViewBuilder
    private var privateHistoryContent: some View {
        if isLoading && privateHistory.isEmpty {
            ProgressView("Loading private transfers...")
                .frame(maxWidth: .infinity)
                .padding()
        } else if privateHistory.isEmpty {
            Text(privateRailReady ? "No private USDCx transfers yet." : "Private USDCx is not configured yet.")
                .font(Theme.bodyFont)
                .foregroundStyle(Theme.textSecondary)
                .padding(.horizontal)
        } else {
            ForEach(privateHistory) { item in
                PrivateTransferHistoryRow(item: item, hasLocalIntent: privateIntentStore.intent(for: item.id) != nil)
                    .padding(.horizontal)
                    .onTapGesture {
                        if let pending = privateIntentStore.intent(for: item.id),
                           item.status == "intent_pending" || item.status == "submitted" {
                            proofIntent = pending
                        }
                    }
                    .contextMenu {
                        if let pending = privateIntentStore.intent(for: item.id),
                           item.status == "intent_pending" || item.status == "submitted" {
                            Button("Verify Aleo Transaction") {
                                proofIntent = pending
                            }
                        }
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
            privateHistory = []
            paymentHealth = nil
            privateIntentStore.reload()
            return
        }

        isLoading = true
        defer { isLoading = false }

        do {
            paymentHealth = try? await CloudClient.shared.getPaymentHealth()
            async let info = CloudClient.shared.getWalletAddress()
            async let currentBalances = CloudClient.shared.getWalletBalances()
            async let recentHistory = CloudClient.shared.getWalletHistory(limit: 25)
            async let recentPrivateHistory = CloudClient.shared.getPrivateTransferHistory(limit: 25)
            walletInfo = try await info
            balances = try await currentBalances
            history = try await recentHistory
            privateHistory = (try? await recentPrivateHistory) ?? []
            pruneCompletedPrivateIntents()
        } catch CloudError.notFound {
            walletInfo = nil
            balances = nil
            history = []
            privateHistory = []
        } catch {
            noticeMessage = error.localizedDescription
        }
    }

    @MainActor
    private func pruneCompletedPrivateIntents() {
        for item in privateHistory where item.status == "verified" || item.status == "expired" || item.status == "failed" {
            privateIntentStore.remove(id: item.id)
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
    let onSaveContact: (String, String?, String, String?) throws -> Void
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
        onSaveContact: @escaping (String, String?, String, String?) throws -> Void,
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

private struct SendPrivateUSDCxSheet: View {
    let railStatus: PaymentRailStatus?
    let selectedContact: WalletContact?
    let onCreateIntent: (String, Int64, PrivacyApproval) async throws -> PrivateTransferIntentResponse

    @Environment(\.dismiss) private var dismiss
    @State private var recipient = ""
    @State private var amount = ""
    @State private var isReviewing = false
    @State private var isCreating = false
    @State private var errorMessage: String?

    init(
        railStatus: PaymentRailStatus?,
        selectedContact: WalletContact?,
        onCreateIntent: @escaping (String, Int64, PrivacyApproval) async throws -> PrivateTransferIntentResponse
    ) {
        self.railStatus = railStatus
        self.selectedContact = selectedContact
        self.onCreateIntent = onCreateIntent
        _recipient = State(initialValue: selectedContact?.shieldedAddress ?? "")
    }

    private var trimmedRecipient: String {
        recipient.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var amountMicroUSDC: Int64? {
        USDCAmountParser.microUSDC(from: amount)
    }

    private var railReady: Bool {
        railStatus?.isReady == true
    }

    private var validationMessage: String? {
        guard railReady else {
            return railStatus?.unavailableReason ?? "Private USDCx is not configured yet."
        }
        guard trimmedRecipient.starts(with: "aleo1"), trimmedRecipient.count >= 32 else {
            return "Enter a valid Aleo private recipient address."
        }
        guard let amountMicroUSDC, amountMicroUSDC > 0 else {
            return "Enter a USDCx amount greater than zero."
        }
        return nil
    }

    var body: some View {
        NavigationStack {
            Form {
                if isReviewing {
                    reviewSections
                } else {
                    entrySections
                }

                if let validationMessage, !isReviewing {
                    Section {
                        Text(validationMessage)
                            .font(Theme.captionFont)
                            .foregroundStyle(railReady ? Theme.warning : Theme.textSecondary)
                    }
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(Theme.captionFont)
                            .foregroundStyle(Theme.danger)
                    }
                }
            }
            .navigationTitle(isReviewing ? "Approve Private Send" : "Send USDCx")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .scrollContentBackground(.hidden)
            .background(Theme.appBackgroundGradient.ignoresSafeArea())
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(isReviewing ? "Back" : "Cancel") {
                        if isReviewing { isReviewing = false } else { dismiss() }
                    }
                    .disabled(isCreating)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isReviewing ? (isCreating ? "Creating..." : "Approve") : "Review") {
                        if isReviewing { submit() } else { review() }
                    }
                    .disabled(isCreating || (!isReviewing && validationMessage != nil))
                }
            }
        }
    }

    @ViewBuilder
    private var entrySections: some View {
        Section {
            if let selectedContact {
                LabeledContent("Contact", value: selectedContact.displayName)
            }
            TextField("Aleo private address", text: $recipient, axis: .vertical)
                .font(.system(.footnote, design: .monospaced))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .lineLimit(2...4)
            TextField("Amount USDCx", text: $amount)
                #if os(iOS)
                .keyboardType(.decimalPad)
                #endif
        } header: {
            Text("Private USDCx")
        }

        Section {
            LabeledContent("Rail", value: "Aleo USDCx")
            LabeledContent("Network", value: railStatus?.network ?? "not configured")
            LabeledContent("Provider", value: railStatus?.provider ?? "aleo")
        }
    }

    @ViewBuilder
    private var reviewSections: some View {
        Section {
            Text(amountMicroUSDC.map(formatMicroUSDC) ?? "$0.00 USDC")
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .monospacedDigit()
                .minimumScaleFactor(0.75)
                .lineLimit(1)
            Text("To \(maskWalletContactAddress(trimmedRecipient))")
                .font(Theme.bodyFont)
                .foregroundStyle(Theme.textSecondary)
        }

        Section("Confirm") {
            LabeledContent("Rail", value: "Private USDCx")
            LabeledContent("Network", value: railStatus?.network ?? "aleo")
            LabeledContent("Provider", value: "Aleo verifier adapter")
        }

        Section {
            Label("No public fallback", systemImage: "lock.shield.fill")
                .foregroundStyle(Theme.success)
            Text("Ghola will submit this only over the configured Aleo USDCx shielded rail. It will not downgrade to public Solana USDC.")
                .font(Theme.captionFont)
                .foregroundStyle(Theme.textSecondary)
            DisclosureGroup("What leaves the device?") {
                Text("The shielded recipient address, amount, and approval create a transfer intent. The verifier later receives a shielded proof/nullifier, not a public Solana transfer.")
                    .font(Theme.captionFont)
                    .foregroundStyle(Theme.textSecondary)
            }
        }
    }

    private func review() {
        guard validationMessage == nil else { return }
        errorMessage = nil
        isReviewing = true
    }

    private func submit() {
        guard validationMessage == nil, let amountMicroUSDC else { return }
        isCreating = true
        errorMessage = nil
        let approval = PrivacyGate.makeApproval(
            scope: .walletTransfer,
            summary: "Create a private USDCx transfer intent for \(formatMicroUSDC(amountMicroUSDC)) to \(maskWalletContactAddress(trimmedRecipient)) on \(railStatus?.network ?? "Aleo"). No public USDC fallback."
        )

        Task {
            do {
                _ = try await onCreateIntent(trimmedRecipient, amountMicroUSDC, approval)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
                isReviewing = false
            }
            isCreating = false
        }
    }
}

private struct SubmitPrivateUSDCxProofSheet: View {
    let intent: PendingPrivateTransfer
    let onSubmit: (String, PrivacyApproval) async throws -> PrivateTransferProofResponse

    @Environment(\.dismiss) private var dismiss
    @State private var transactionID = ""
    @State private var isReviewing = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    private var trimmedTransactionID: String {
        transactionID.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var validationMessage: String? {
        guard !trimmedTransactionID.isEmpty else {
            return "Enter the Aleo transaction ID after sending USDCx."
        }
        guard trimmedTransactionID.count >= 16 else {
            return "Enter the full Aleo transaction ID."
        }
        return nil
    }

    var body: some View {
        NavigationStack {
            Form {
                if isReviewing {
                    reviewSections
                } else {
                    entrySections
                }

                if let validationMessage, !isReviewing {
                    Section {
                        Text(validationMessage)
                            .font(Theme.captionFont)
                            .foregroundStyle(Theme.textSecondary)
                    }
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(Theme.captionFont)
                            .foregroundStyle(Theme.danger)
                    }
                }
            }
            .navigationTitle(isReviewing ? "Approve Verification" : "Verify USDCx")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .scrollContentBackground(.hidden)
            .background(Theme.appBackgroundGradient.ignoresSafeArea())
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(isReviewing ? "Back" : "Cancel") {
                        if isReviewing { isReviewing = false } else { dismiss() }
                    }
                    .disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isReviewing ? (isSubmitting ? "Verifying..." : "Verify") : "Review") {
                        if isReviewing { submit() } else { review() }
                    }
                    .disabled(isSubmitting || (!isReviewing && validationMessage != nil))
                }
            }
        }
    }

    @ViewBuilder
    private var entrySections: some View {
        Section {
            LabeledContent("Amount", value: formatMicroUSDC(intent.amountMicroUSDC).replacingOccurrences(of: "USDC", with: intent.asset))
            LabeledContent("Recipient", value: maskWalletContactAddress(intent.recipientAddress))
            LabeledContent("Network", value: intent.network)
        } header: {
            Text("Approved Intent")
        }

        Section {
            TextField("Aleo transaction ID", text: $transactionID, axis: .vertical)
                .font(.system(.footnote, design: .monospaced))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .lineLimit(2...4)
        } header: {
            Text("Settlement Proof")
        } footer: {
            Text("After the Aleo USDCx transfer is sent, paste the transaction ID here so Ghola can verify it through the configured shielded adapter.")
        }
    }

    @ViewBuilder
    private var reviewSections: some View {
        Section {
            Text(formatMicroUSDC(intent.amountMicroUSDC).replacingOccurrences(of: "USDC", with: intent.asset))
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .monospacedDigit()
                .minimumScaleFactor(0.75)
                .lineLimit(1)
            Text("To \(maskWalletContactAddress(intent.recipientAddress))")
                .font(Theme.bodyFont)
                .foregroundStyle(Theme.textSecondary)
        }

        Section("Verifier") {
            LabeledContent("Rail", value: "Private USDCx")
            LabeledContent("Network", value: intent.network)
            LabeledContent("Transaction", value: shortLocalHash(trimmedTransactionID))
        }

        Section {
            Label("No public fallback", systemImage: "lock.shield.fill")
                .foregroundStyle(Theme.success)
            DisclosureGroup("What leaves the device?") {
                Text("The Aleo transaction ID, shielded recipient, amount, and approval metadata are sent to Ghola Cloud and the configured Aleo verifier adapter. Public Solana USDC is not used.")
                    .font(Theme.captionFont)
                    .foregroundStyle(Theme.textSecondary)
            }
        }
    }

    private func review() {
        guard validationMessage == nil else { return }
        errorMessage = nil
        isReviewing = true
    }

    private func submit() {
        guard validationMessage == nil else { return }
        isSubmitting = true
        errorMessage = nil
        let approval = PrivacyGate.makeApproval(
            scope: .walletTransfer,
            summary: "Verify private USDCx settlement \(shortLocalHash(trimmedTransactionID)) for \(formatMicroUSDC(intent.amountMicroUSDC)) on \(intent.network)."
        )

        Task {
            do {
                _ = try await onSubmit(trimmedTransactionID, approval)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
                isReviewing = false
            }
            isSubmitting = false
        }
    }

    private func shortLocalHash(_ raw: String) -> String {
        guard raw.count > 12 else { return raw }
        return "\(raw.prefix(6))...\(raw.suffix(6))"
    }
}

private struct AddWalletContactSheet: View {
    let initialAddress: String
    let onSave: (String, String?, String, String?) throws -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var displayName = ""
    @State private var handle = ""
    @State private var address = ""
    @State private var shieldedAddress = ""
    @State private var errorMessage: String?

    init(initialAddress: String = "", onSave: @escaping (String, String?, String, String?) throws -> Void) {
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

    private var trimmedShieldedAddress: String {
        shieldedAddress.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSave: Bool {
        !trimmedName.isEmpty
            && SolanaAddressValidator.looksValid(trimmedAddress)
            && (trimmedShieldedAddress.isEmpty || (trimmedShieldedAddress.starts(with: "aleo1") && trimmedShieldedAddress.count >= 32))
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

                Section {
                    TextField("Aleo private address", text: $shieldedAddress, axis: .vertical)
                        .font(.system(.footnote, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .lineLimit(2...4)
                } header: {
                    Text("Private USDCx address")
                } footer: {
                    Text("Optional. Used only for Private USDCx sends and stored locally on this device.")
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
            try onSave(
                trimmedName,
                trimmedHandle.isEmpty ? nil : trimmedHandle,
                trimmedAddress,
                trimmedShieldedAddress.isEmpty ? nil : trimmedShieldedAddress
            )
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
    let privateStatus: PaymentRailStatus?

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
                    Label(privateStatus?.isReady == true ? "Private USDCx ready" : "Private USDCx gated", systemImage: "lock.shield")
                        .foregroundStyle(privateStatus?.isReady == true ? Theme.success : Theme.warning)
                    Text(privateStatus?.privacyDisclosure ?? "Private USDCx uses the Aleo shielded rail when a verifier adapter is configured. Ghola will not downgrade private requests to public USDC.")
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
                    LabeledContent("Public rail", value: "Solana USDC")
                    LabeledContent("Public network", value: network)
                    LabeledContent("Private rail", value: "Aleo USDCx")
                    LabeledContent("Private network", value: privateStatus?.network ?? "not configured")
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

private struct PrivateTransferHistoryRow: View {
    let item: PrivateTransferHistoryResponse
    let hasLocalIntent: Bool

    var body: some View {
        HStack(spacing: Theme.paddingMd) {
            Image(systemName: item.status == "verified" ? "lock.shield.fill" : "clock")
                .foregroundStyle(item.status == "verified" ? Theme.success : Theme.warning)
            VStack(alignment: .leading, spacing: 4) {
                Text(formatMicroUSDC(item.amountMicroUSDC).replacingOccurrences(of: "USDC", with: item.asset))
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                Text("\(item.recipientPreview) · \(item.network)")
                    .font(Theme.captionFont)
                    .foregroundStyle(Theme.textSecondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text(item.status.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(Theme.captionFont)
                    .foregroundStyle(Theme.textSecondary)
                if hasLocalIntent && (item.status == "intent_pending" || item.status == "submitted") {
                    Text("Tap to verify")
                        .font(Theme.captionFont.weight(.semibold))
                        .foregroundStyle(Theme.accent)
                }
            }
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

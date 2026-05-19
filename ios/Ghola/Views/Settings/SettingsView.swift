import SwiftUI
#if canImport(SafariServices)
import SafariServices
#endif
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

struct SettingsView: View {
    @EnvironmentObject var auth: AuthManager
    @State private var usage: UsageResponse?
    @State private var providerHealth: ProviderHealthResponse?
    @State private var privacyHealth: PrivacyHealthResponse?
    @State private var connectedAccounts: [ConnectedAccountStatus] = []
    @State private var accountMessage: String?
    @State private var isOpeningGoogleConnect = false
    @State private var showUpgrade = false
    @AppStorage(BackendRegistry.selectedModeKey) private var selectedBackendModeRaw = BackendRegistry.defaultMode.rawValue

    private var selectedBackendMode: BackendMode {
        BackendMode(rawValue: selectedBackendModeRaw) ?? BackendRegistry.defaultMode
    }

    private var gmailConnected: Bool {
        connectedAccounts.contains { $0.provider == "gmail" && $0.connected }
    }

    private var gmailOAuthConfigured: Bool {
        providerHealth?.gmail == true
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(auth.profile?.displayName ?? "Ghola")
                            .font(Theme.headlineFont)
                        Text("Choose where inference runs and where prompts are sent")
                            .font(Theme.captionFont)
                            .foregroundStyle(Theme.textSecondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 4)
                }
                .listRowBackground(Color.clear)

                // MARK: - Model
                Section {
                    Picker("Chat inference", selection: $selectedBackendModeRaw) {
                        ForEach(BackendMode.allCases, id: \.rawValue) { mode in
                            Text(mode.title).tag(mode.rawValue)
                        }
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Label(
                            selectedBackendMode.sendsPromptsOffDevice ? "Prompts leave this device" : "Prompts stay on this device",
                            systemImage: selectedBackendMode.sendsPromptsOffDevice ? "network" : "iphone.gen3"
                        )
                        .font(Theme.bodyFont)

                        Text(selectedBackendMode.privacyDescription)
                            .font(Theme.captionFont)
                            .foregroundStyle(Theme.textSecondary)
                    }
                    .padding(.vertical, 4)
                } header: {
                    Text("Inference Privacy")
                } footer: {
                    Text("On-device-first fails closed if no local model is available. It does not silently send chat prompts to cloud.")
                }

                Section(
                    header: Text("External Actions"),
                    footer: Text("Calls, email, calendar, wallet, and commerce actions may require network services even when chat inference is local.")
                ) {
                    HStack {
                        Label("Network execution approval", systemImage: "lock.shield")
                        Spacer()
                        Text("Required")
                            .foregroundStyle(Theme.textSecondary)
                    }

                    HStack {
                        Label("Privacy mode", systemImage: "iphone.gen3")
                        Spacer()
                        Text("Strict local")
                            .foregroundStyle(Theme.textSecondary)
                    }

                    HStack {
                        Label("Task detail redaction", systemImage: "eye.slash")
                        Spacer()
                        Text(privacyHealth?.taskResultRedactionEnabled == true ? "On" : "Checking")
                            .foregroundStyle(Theme.textSecondary)
                    }

                    HStack {
                        Label("Remote compute approval", systemImage: "cloud")
                        Spacer()
                        Text(privacyHealth?.remoteComputeApprovalEnabled == true ? "Required" : "Checking")
                            .foregroundStyle(Theme.textSecondary)
                    }

                    HStack {
                        Label("Message abuse controls", systemImage: "hand.raised")
                        Spacer()
                        Text(privacyHealth?.messagingBlockReportEnabled == true ? "On" : "Checking")
                            .foregroundStyle(Theme.textSecondary)
                    }
                }

                Section(
                    header: Text("Connected Accounts"),
                    footer: Text("Google is required for Gmail sending and calendar execution. Ghola still asks for approval before each send or calendar action.")
                ) {
                    HStack {
                        Label("Google Gmail/Calendar", systemImage: "envelope.badge")
                        Spacer()
                        accountStatusText
                    }

                    if !gmailConnected {
                        Button {
                            connectGoogleAccount()
                        } label: {
                            Label(isOpeningGoogleConnect ? "Opening..." : "Connect Google", systemImage: "link")
                        }
                        .disabled(!gmailOAuthConfigured || isOpeningGoogleConnect)
                    }

                    if let accountMessage {
                        Text(accountMessage)
                            .font(Theme.captionFont)
                            .foregroundStyle(Theme.textSecondary)
                    }
                }

                Section(
                    header: Text("Cloud Model"),
                    footer: Text("These settings apply to Cloud mode. They do not make Local AI Server or On-device mode active.")
                ) {
                    NavigationLink {
                        ModelPickerView()
                    } label: {
                        Label("Cloud Model Settings", systemImage: "cpu")
                    }
                }

                // MARK: - Local Server
                #if os(iOS)
                Section(
                    header: Text("Local AI Server"),
                    footer: Text("Local AI Server sends prompts to the paired server shown here. It is separate from On-device mode.")
                ) {
                    if CloudClient.isLocalMode {
                        HStack {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(Theme.success)
                            Text("Using Local AI Server")
                            Spacer()
                            Text(CloudClient.localServerName ?? "Local")
                                .foregroundStyle(Theme.textSecondary)
                        }
                    }

                    NavigationLink {
                        LocalServerConnectView()
                    } label: {
                        Label(
                            CloudClient.isLocalMode ? "Manage Local AI Server" : "Connect Local AI Server",
                            systemImage: "desktopcomputer"
                        )
                    }
                }
                #endif

                // MARK: - Account
                Section("Account") {
                    if let profile = auth.profile {
                        HStack {
                            Text("Email")
                            Spacer()
                            Text(profile.email ?? "Not set")
                                .foregroundStyle(Theme.textSecondary)
                        }

                        HStack {
                            Text("Plan")
                            Spacer()
                            Text(profile.tier.capitalized)
                                .foregroundStyle(Theme.textSecondary)
                        }
                    }

                    if let usage {
                        HStack {
                            Text("Calls this month")
                            Spacer()
                            Text("\(usage.callCount)/\(usage.maxCalls)")
                                .foregroundStyle(Theme.textSecondary)
                        }

                        HStack {
                            Text("Emails this month")
                            Spacer()
                            Text("\(usage.emailCount)/\(usage.maxEmails)")
                                .foregroundStyle(Theme.textSecondary)
                        }
                    }
                }

                // MARK: - Billing
                Section("Billing") {
                    Button("Upgrade Plan") {
                        upgradeAction()
                    }
                    .foregroundStyle(Theme.accent)
                }

                // MARK: - About
                Section("About") {
                    HStack {
                        Text("Version")
                        Spacer()
                        Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0")
                            .foregroundStyle(Theme.textSecondary)
                    }
                }

                // MARK: - Sign Out
                Section {
                    Button("Sign Out", role: .destructive) {
                        auth.signOut()
                    }
                }
            }
            .navigationTitle("Settings")
            #if os(iOS)
            .scrollContentBackground(.hidden)
            .background(Theme.appBackgroundGradient.ignoresSafeArea())
            #endif
            .task {
                await refreshSettings()
            }
            .refreshable { await refreshSettings() }
        }
    }

    @ViewBuilder
    private var accountStatusText: some View {
        if gmailConnected {
            Text("Connected")
                .foregroundStyle(Theme.success)
        } else if providerHealth == nil {
            Text("Checking")
                .foregroundStyle(Theme.textSecondary)
        } else if !gmailOAuthConfigured {
            Text("Unavailable")
                .foregroundStyle(Theme.warning)
        } else {
            Text("Not connected")
                .foregroundStyle(Theme.textSecondary)
        }
    }

    @MainActor
    private func refreshSettings() async {
        async let currentUsage = CloudClient.shared.getUsage()
        async let health = CloudClient.shared.getProviderHealth()
        async let privacy = CloudClient.shared.getPrivacyHealth()
        async let accounts = CloudClient.shared.getConnectedAccounts()

        usage = try? await currentUsage
        providerHealth = try? await health
        privacyHealth = try? await privacy
        connectedAccounts = (try? await accounts) ?? connectedAccounts
    }

    private func connectGoogleAccount() {
        guard gmailOAuthConfigured else {
            accountMessage = "Google OAuth is not configured on this backend yet."
            return
        }

        isOpeningGoogleConnect = true
        accountMessage = nil
        Task {
            do {
                let url = try await CloudClient.shared.getGmailAuthorizeURL()
                await MainActor.run {
                    openExternalURL(url)
                    accountMessage = "Return here after Google finishes connecting."
                    isOpeningGoogleConnect = false
                }
            } catch {
                await MainActor.run {
                    accountMessage = error.localizedDescription
                    isOpeningGoogleConnect = false
                }
            }
        }
    }

    private func openExternalURL(_ url: URL) {
        #if os(iOS)
        UIApplication.shared.open(url)
        #elseif os(macOS)
        NSWorkspace.shared.open(url)
        #endif
    }

    private func upgradeAction() {
        Task {
            do {
                let urlString = try await CloudClient.shared.createCheckout(tier: "pro")
                guard let url = URL(string: urlString) else { return }
                await MainActor.run { openExternalURL(url) }
            } catch {
                // Show error
            }
        }
    }
}

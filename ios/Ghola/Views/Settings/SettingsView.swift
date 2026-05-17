import SwiftUI
#if canImport(SafariServices)
import SafariServices
#endif

struct SettingsView: View {
    @EnvironmentObject var auth: AuthManager
    @State private var usage: UsageResponse?
    @State private var showUpgrade = false
    @AppStorage(BackendRegistry.selectedModeKey) private var selectedBackendModeRaw = BackendRegistry.defaultMode.rawValue

    private var selectedBackendMode: BackendMode {
        BackendMode(rawValue: selectedBackendModeRaw) ?? BackendRegistry.defaultMode
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
                do { usage = try await CloudClient.shared.getUsage() }
                catch { /* ok */ }
            }
        }
    }

    private func upgradeAction() {
        Task {
            do {
                let urlString = try await CloudClient.shared.createCheckout(tier: "pro")
                guard let url = URL(string: urlString) else { return }
                #if os(iOS)
                await UIApplication.shared.open(url)
                #elseif os(macOS)
                NSWorkspace.shared.open(url)
                #endif
            } catch {
                // Show error
            }
        }
    }
}

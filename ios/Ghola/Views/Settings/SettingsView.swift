import SwiftUI
#if canImport(SafariServices)
import SafariServices
#endif

struct SettingsView: View {
    @EnvironmentObject var auth: AuthManager
    @State private var usage: UsageResponse?
    @State private var showUpgrade = false

    var body: some View {
        NavigationStack {
            List {
                // MARK: - Model
                Section("AI Model") {
                    NavigationLink {
                        ModelPickerView()
                    } label: {
                        Label("Model Settings", systemImage: "cpu")
                    }
                }

                // MARK: - Local Server
                #if os(iOS)
                Section("Local AI Server") {
                    if CloudClient.isLocalMode {
                        HStack {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                            Text("Connected")
                            Spacer()
                            Text(CloudClient.localServerName ?? "Local")
                                .foregroundStyle(Theme.textSecondary)
                        }
                    }

                    NavigationLink {
                        LocalServerConnectView()
                    } label: {
                        Label(
                            CloudClient.isLocalMode ? "Manage Connection" : "Connect to Local Server",
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

#if os(iOS)
import SwiftUI

struct LocalServerConnectView: View {
    @StateObject private var browser = LocalServerBrowser()
    @State private var selectedServer: LocalServer?
    @State private var pin = ""
    @State private var isConnecting = false
    @State private var errorMessage: String?
    @State private var isConnected = CloudClient.isLocalMode

    var body: some View {
        List {
            if isConnected {
                connectedSection
            } else if selectedServer != nil {
                pinEntrySection
            } else {
                discoverySection
            }
        }
        .navigationTitle("Local AI Server")
        .scrollContentBackground(.hidden)
        .background(Theme.appBackgroundGradient.ignoresSafeArea())
        .onAppear {
            if !isConnected {
                browser.startBrowsing()
            }
        }
        .onDisappear {
            browser.stopBrowsing()
        }
    }

    // MARK: - Connected

    private var connectedSection: some View {
        Section {
            HStack {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(Theme.success)
                Text("Connected")
                Spacer()
                Text(CloudClient.localServerName ?? "Local Server")
                    .foregroundStyle(Theme.textSecondary)
            }

            Button("Disconnect", role: .destructive) {
                Task {
                    await CloudClient.shared.disconnectLocal()
                    isConnected = false
                    browser.startBrowsing()
                }
            }
        } header: {
            Text("Local Server")
        }
    }

    // MARK: - Discovery

    @ViewBuilder
    private var discoverySection: some View {
        if browser.discoveredServers.isEmpty {
            Section {
                HStack {
                    ProgressView()
                        .padding(.trailing, 8)
                    Text("Searching for Ghola Home servers...")
                        .foregroundStyle(Theme.textSecondary)
                }
            } footer: {
                Text("Make sure Ghola Home is running on your Mac and both devices are on the same WiFi network.")
            }
        } else {
            Section("Available Servers") {
                ForEach(browser.discoveredServers) { server in
                    Button {
                        selectedServer = server
                    } label: {
                        HStack {
                            Image(systemName: "desktopcomputer")
                                .foregroundStyle(Theme.accent)
                            VStack(alignment: .leading) {
                                Text(server.name)
                                    .foregroundStyle(Theme.textPrimary)
                                Text(server.host)
                                    .font(.caption)
                                    .foregroundStyle(Theme.textSecondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .foregroundStyle(Theme.textSecondary)
                        }
                    }
                }
            }
        }
    }

    // MARK: - PIN Entry

    private var pinEntrySection: some View {
        Section {
            VStack(spacing: 16) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 40))
                    .foregroundStyle(Theme.accent)

                Text(selectedServer?.name ?? "")
                    .font(.headline)

                Text("Enter the PIN shown on your Mac")
                    .foregroundStyle(Theme.textSecondary)

                TextField("PIN", text: $pin)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.center)
                    .font(.system(size: 32, weight: .bold, design: .monospaced))
                    .frame(width: 200)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: pin) { _, newValue in
                        // Auto-submit when 4 digits entered
                        if newValue.count == 4 {
                            connect()
                        }
                    }

                if isConnecting {
                    ProgressView()
                }

                if let error = errorMessage {
                    Text(error)
                        .foregroundStyle(Theme.danger)
                        .font(.caption)
                }

                Button("Back") {
                    selectedServer = nil
                    pin = ""
                    errorMessage = nil
                }
                .buttonStyle(.bordered)
            }
            .padding(.vertical)
            .frame(maxWidth: .infinity)
        }
    }

    // MARK: - Actions

    private func connect() {
        guard let server = selectedServer else { return }
        isConnecting = true
        errorMessage = nil

        Task {
            do {
                let deviceName = UIDevice.current.name
                try await CloudClient.shared.localPair(
                    serverURL: server.baseURL,
                    pin: pin,
                    deviceName: deviceName
                )
                isConnected = true
                browser.stopBrowsing()
            } catch {
                errorMessage = "Wrong PIN or connection failed. Try again."
                pin = ""
            }
            isConnecting = false
        }
    }
}
#endif

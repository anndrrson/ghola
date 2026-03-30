#if os(macOS)
import SwiftUI

struct HomeStatusView: View {
    @EnvironmentObject var serverManager: ServerManager
    @EnvironmentObject var ollamaManager: OllamaManager

    @State private var showAdvanced = false

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Image(systemName: "brain.head.profile")
                    .font(.title2)
                    .foregroundStyle(.accent)
                Text("Ghola Home")
                    .font(.title2)
                    .fontWeight(.semibold)
                Spacer()
            }
            .padding()

            Divider()

            List {
                // MARK: - Server Status
                Section("Server") {
                    HStack {
                        statusDot(for: serverManager.status)
                        Text("Server")
                        Spacer()
                        Text(serverManager.status.rawValue)
                            .foregroundStyle(.secondary)
                    }

                    if serverManager.status == .running {
                        HStack {
                            Text("PIN")
                            Spacer()
                            Text(serverManager.pin)
                                .font(.system(.body, design: .monospaced))
                                .fontWeight(.bold)

                            Button {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(serverManager.pin, forType: .string)
                            } label: {
                                Image(systemName: "doc.on.doc")
                            }
                            .buttonStyle(.borderless)
                        }
                    }

                    HStack {
                        Text("Connected Devices")
                        Spacer()
                        Text("\(serverManager.status == .running ? pairedDeviceCount : 0)")
                            .foregroundStyle(.secondary)
                    }
                }

                // MARK: - Ollama Status
                Section("AI Engine") {
                    HStack {
                        statusDot(ollamaRunning: ollamaManager.status == .running)
                        Text("Ollama")
                        Spacer()
                        Text(ollamaManager.status.rawValue)
                            .foregroundStyle(.secondary)
                    }

                    if !ollamaManager.installedModels.isEmpty {
                        ForEach(ollamaManager.installedModels, id: \.self) { model in
                            HStack {
                                Image(systemName: "cpu")
                                    .foregroundStyle(.secondary)
                                Text(model)
                                Spacer()
                            }
                        }
                    }
                }

                // MARK: - Actions
                Section {
                    Button("Restart Server") {
                        serverManager.restart()
                    }
                    .disabled(serverManager.status == .starting)
                }

                // MARK: - Advanced
                Section("Advanced") {
                    HStack {
                        Text("Port")
                        Spacer()
                        Text("3000")
                            .foregroundStyle(.secondary)
                    }

                    HStack {
                        Text("Database")
                        Spacer()
                        Text("~/.ghola/ghola.db")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .frame(minWidth: 400, minHeight: 500)
        .task {
            await ollamaManager.checkStatus()
            if serverManager.status == .stopped {
                serverManager.start()
            }
        }
    }

    private var pairedDeviceCount: Int {
        // This would ideally come from the server, but for display purposes
        // we'll show a count from the health endpoint
        0
    }

    @ViewBuilder
    private func statusDot(for status: ServerStatus) -> some View {
        Circle()
            .fill(status == .running ? .green : status == .error ? .red : .yellow)
            .frame(width: 8, height: 8)
    }

    @ViewBuilder
    private func statusDot(ollamaRunning: Bool) -> some View {
        Circle()
            .fill(ollamaRunning ? .green : .yellow)
            .frame(width: 8, height: 8)
    }
}
#endif

#if os(macOS)
import SwiftUI

struct MenuBarView: View {
    @EnvironmentObject var serverManager: ServerManager
    @EnvironmentObject var ollamaManager: OllamaManager
    @EnvironmentObject var bonjourAdvertiser: BonjourAdvertiser

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Status
            HStack {
                Circle()
                    .fill(serverManager.status == .running ? .green : serverManager.status == .error ? .red : .yellow)
                    .frame(width: 8, height: 8)
                Text("Ghola Home")
                    .font(.headline)
                Spacer()
                Text(serverManager.status.rawValue)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal)

            Divider()

            if serverManager.status == .running {
                // PIN
                HStack {
                    Text("PIN:")
                        .foregroundStyle(.secondary)
                    Text(serverManager.pin)
                        .font(.system(.body, design: .monospaced))
                        .fontWeight(.bold)
                    Spacer()
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(serverManager.pin, forType: .string)
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .buttonStyle(.borderless)
                }
                .padding(.horizontal)

                // Model
                if let model = ollamaManager.installedModels.first {
                    HStack {
                        Image(systemName: "cpu")
                            .foregroundStyle(.secondary)
                        Text(model)
                        Spacer()
                    }
                    .padding(.horizontal)
                }
            }

            Divider()

            Button("Open Window") {
                NSApplication.shared.activate(ignoringOtherApps: true)
                if let window = NSApplication.shared.windows.first {
                    window.makeKeyAndOrderFront(nil)
                }
            }
            .padding(.horizontal)

            Button("Restart Server") {
                serverManager.restart()
            }
            .padding(.horizontal)
            .disabled(serverManager.status == .starting)

            Divider()

            Button("Quit") {
                serverManager.stop()
                NSApplication.shared.terminate(nil)
            }
            .padding(.horizontal)
        }
        .padding(.vertical, 8)
        .frame(width: 280)
        .task {
            await ollamaManager.checkStatus()
            if serverManager.status == .running {
                bonjourAdvertiser.start(
                    serverName: Host.current().localizedName ?? "Ghola Home",
                    models: ollamaManager.installedModels
                )
            }
        }
        .onChange(of: serverManager.status) { _, newStatus in
            if newStatus == .running {
                bonjourAdvertiser.start(
                    serverName: Host.current().localizedName ?? "Ghola Home",
                    models: ollamaManager.installedModels
                )
            } else {
                bonjourAdvertiser.stop()
            }
        }
    }
}
#endif

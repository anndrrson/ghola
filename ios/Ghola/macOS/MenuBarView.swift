#if os(macOS)
import SwiftUI

struct MenuBarView: View {
    @EnvironmentObject var auth: AuthManager
    @State private var tasks: [TaskResponse] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if auth.isAuthenticated {
                if let profile = auth.profile {
                    Text("Hey, \(profile.displayName ?? "there")")
                        .font(.headline)
                        .padding(.horizontal)
                }

                Divider()

                if tasks.isEmpty {
                    Text("No active tasks")
                        .foregroundStyle(.secondary)
                        .padding(.horizontal)
                } else {
                    ForEach(tasks.prefix(5)) { task in
                        HStack {
                            Image(systemName: task.typeIcon)
                                .foregroundStyle(.blue)
                            Text(task.taskType.capitalized)
                            Spacer()
                            Text(task.status.replacingOccurrences(of: "_", with: " "))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal)
                        .padding(.vertical, 2)
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

                Button("New Chat") {
                    NSApplication.shared.activate(ignoringOtherApps: true)
                    // TODO: focus chat tab
                }
                .padding(.horizontal)
            } else {
                Text("Sign in to get started")
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)

                Button("Open Ghola") {
                    NSApplication.shared.activate(ignoringOtherApps: true)
                }
                .padding(.horizontal)
            }

            Divider()

            Button("Quit") {
                NSApplication.shared.terminate(nil)
            }
            .padding(.horizontal)
        }
        .padding(.vertical, 8)
        .frame(width: 280)
        .task {
            guard auth.isAuthenticated else { return }
            do {
                tasks = try await CloudClient.shared.listTasks()
                    .filter { ["pending", "in_progress", "awaiting_approval"].contains($0.status) }
            } catch { /* ok */ }
        }
    }
}
#endif

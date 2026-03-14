import SwiftUI

struct HomeView: View {
    @EnvironmentObject var auth: AuthManager
    @State private var tasks: [TaskResponse] = []
    @State private var isLoading = false

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        let name = auth.profile?.displayName ?? "there"
        switch hour {
        case 5..<12: return "Good morning, \(name)"
        case 12..<17: return "Good afternoon, \(name)"
        case 17..<22: return "Good evening, \(name)"
        default: return "Hey, \(name)"
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.paddingLg) {
                    // Greeting
                    Text(greeting)
                        .font(Theme.titleFont)
                        .padding(.horizontal)

                    // Quick Actions
                    quickActions

                    // Active Tasks
                    if !tasks.isEmpty {
                        Text("Active Tasks")
                            .font(Theme.headlineFont)
                            .padding(.horizontal)

                        ForEach(tasks) { task in
                            NavigationLink {
                                TaskDetailView(task: task)
                            } label: {
                                TaskCardView(task: task)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(.vertical)
            }
            .background(Theme.bg)
            .navigationTitle("")
            .refreshable { await loadTasks() }
            .task { await loadTasks() }
        }
    }

    // MARK: - Quick Actions

    private var quickActions: some View {
        LazyVGrid(columns: [
            GridItem(.flexible()),
            GridItem(.flexible()),
        ], spacing: Theme.paddingMd) {
            QuickActionButton(
                title: "Call",
                icon: "phone.fill",
                color: Theme.callGreen,
                action: { createTask(type: "call") }
            )
            QuickActionButton(
                title: "Email",
                icon: "envelope.fill",
                color: Theme.emailBlue,
                action: { createTask(type: "email") }
            )
            QuickActionButton(
                title: "Calendar",
                icon: "calendar",
                color: Theme.calendarOrange,
                action: { createTask(type: "calendar") }
            )
            QuickActionButton(
                title: "Chat",
                icon: "bubble.left.fill",
                color: Theme.chatPurple,
                action: {} // Switch to chat tab
            )
        }
        .padding(.horizontal)
    }

    // MARK: - Data

    private func loadTasks() async {
        isLoading = true
        defer { isLoading = false }
        do {
            tasks = try await CloudClient.shared.listTasks()
                .filter { ["pending", "in_progress", "awaiting_approval"].contains($0.status) }
        } catch {
            // Silently fail on refresh
        }
    }

    private func createTask(type: String) {
        Task {
            do {
                let task = try await CloudClient.shared.createTask(
                    type: type,
                    templateId: nil,
                    params: ["intent": "User initiated from quick action"]
                )
                tasks.insert(task, at: 0)
            } catch {
                // Show error
            }
        }
    }
}

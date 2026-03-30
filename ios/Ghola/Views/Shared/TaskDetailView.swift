import SwiftUI

struct TaskDetailView: View {
    let task: TaskResponse
    @State private var steps: [TaskStepResponse] = []
    @State private var showCancel = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.paddingMd) {
                // Header
                HStack {
                    Image(systemName: task.typeIcon)
                        .font(.title)
                        .foregroundStyle(.blue)

                    VStack(alignment: .leading) {
                        Text(task.taskType.capitalized)
                            .font(Theme.headlineFont)
                        Text(task.status.replacingOccurrences(of: "_", with: " ").capitalized)
                            .font(Theme.captionFont)
                            .foregroundStyle(Theme.textSecondary)
                    }
                }

                Divider()

                // Steps
                if !steps.isEmpty {
                    Text("Steps")
                        .font(.headline)

                    ForEach(steps) { step in
                        HStack {
                            Image(systemName: stepIcon(step.status))
                                .foregroundStyle(stepColor(step.status))

                            VStack(alignment: .leading) {
                                Text(step.actionType.replacingOccurrences(of: "_", with: " ").capitalized)
                                    .font(.subheadline)
                                Text(step.status.capitalized)
                                    .font(Theme.captionFont)
                                    .foregroundStyle(Theme.textSecondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }

                // Result
                if let result = task.result {
                    Divider()
                    Text("Result")
                        .font(.headline)

                    if let summary = result["summary"]?.value as? String {
                        Text(summary)
                            .font(Theme.bodyFont)
                    }
                }

                // Error
                if let error = task.errorMessage {
                    Divider()
                    Text("Error")
                        .font(.headline)
                        .foregroundStyle(.red)
                    Text(error)
                        .font(Theme.bodyFont)
                        .foregroundStyle(.red)
                }

                // Actions
                if ["pending", "in_progress", "awaiting_approval"].contains(task.status) {
                    Divider()
                    Button("Cancel Task", role: .destructive) {
                        showCancel = true
                    }
                }
            }
            .padding()
        }
        .navigationTitle("Task Details")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task {
            do {
                steps = try await CloudClient.shared.getTaskSteps(taskId: task.id)
            } catch { /* ok */ }
        }
        .alert("Cancel Task?", isPresented: $showCancel) {
            Button("Cancel Task", role: .destructive) {
                Task {
                    try? await CloudClient.shared.cancelTask(id: task.id)
                }
            }
            Button("Keep", role: .cancel) {}
        }
    }

    private func stepIcon(_ status: String) -> String {
        switch status {
        case "completed": return "checkmark.circle.fill"
        case "in_progress": return "arrow.triangle.2.circlepath"
        case "failed": return "xmark.circle.fill"
        case "skipped": return "forward.fill"
        default: return "circle"
        }
    }

    private func stepColor(_ status: String) -> Color {
        switch status {
        case "completed": return .green
        case "in_progress": return .blue
        case "failed": return .red
        default: return Theme.textSecondary
        }
    }
}

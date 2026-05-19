import SwiftUI

struct TaskDetailView: View {
    let task: TaskResponse
    @State private var steps: [TaskStepResponse] = []
    @State private var currentTask: TaskResponse
    @State private var refreshTask: Task<Void, Never>?
    @State private var showCancel = false
    @State private var showEmailSendApproval = false
    @State private var isSendingEmail = false
    @State private var actionError: String?
    @State private var emailDraft: EmailResponse?

    init(task: TaskResponse) {
        self.task = task
        _currentTask = State(initialValue: task)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.paddingMd) {
                // Header
                HStack {
                    Image(systemName: currentTask.typeIcon)
                        .font(.title)
                        .foregroundStyle(Theme.accent)

                    VStack(alignment: .leading) {
                        Text(currentTask.taskType.capitalized)
                            .font(Theme.headlineFont)
                        Text(statusTitle)
                            .font(Theme.captionFont)
                            .foregroundStyle(Theme.textSecondary)
                        Label(privacyBoundaryTitle, systemImage: privacyBoundaryIcon)
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
                if let result = currentTask.result {
                    Divider()
                    Text("Result")
                        .font(.headline)

                    resultView(result)
                }

                if let emailDraft {
                    Divider()
                    Text("Email Draft")
                        .font(.headline)
                    VStack(alignment: .leading, spacing: Theme.paddingSm) {
                        Text("To: \(emailDraft.toAddress)")
                            .font(.subheadline.weight(.semibold))
                        Text(emailDraft.subject)
                            .font(.subheadline.weight(.semibold))
                        Text(emailDraft.body)
                            .font(Theme.bodyFont)
                    }
                }

                // Error
                if let error = currentTask.errorMessage {
                    Divider()
                    Text("Error")
                        .font(.headline)
                        .foregroundStyle(Theme.danger)
                    Text(error)
                        .font(Theme.bodyFont)
                        .foregroundStyle(Theme.danger)
                }

                if let actionError {
                    Divider()
                    Text("Action Error")
                        .font(.headline)
                        .foregroundStyle(Theme.danger)
                    Text(actionError)
                        .font(Theme.bodyFont)
                        .foregroundStyle(Theme.danger)
                }

                // Actions
                if ["pending", "in_progress", "awaiting_approval"].contains(currentTask.status) {
                    Divider()
                    VStack(alignment: .leading, spacing: Theme.paddingSm) {
                        if currentTask.status == "awaiting_approval",
                           currentTask.taskType == "email",
                           emailActionID != nil {
                            Button {
                                showEmailSendApproval = true
                            } label: {
                                Label(isSendingEmail ? "Sending..." : "Send Email", systemImage: "paperplane.fill")
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(isSendingEmail)
                        }

                        Button("Cancel Task", role: .destructive) {
                            showCancel = true
                        }
                    }
                }
            }
            .padding()
        }
        .background(Theme.appBackgroundGradient.ignoresSafeArea())
        .navigationTitle("Task Details")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task {
            await refresh()
            startPolling()
        }
        .onDisappear {
            refreshTask?.cancel()
            refreshTask = nil
        }
        .alert("Cancel Task?", isPresented: $showCancel) {
            Button("Cancel Task", role: .destructive) {
                Task {
                    try? await CloudClient.shared.cancelTask(id: currentTask.id)
                    await refresh()
                }
            }
            Button("Keep", role: .cancel) {}
        }
        .alert("Send via Gmail?", isPresented: $showEmailSendApproval) {
            Button("Send") {
                Task { await sendEmailDraft() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(emailSendApprovalMessage)
        }
    }

    private var statusTitle: String {
        switch currentTask.status {
        case "pending": return "Queued"
        case "in_progress": return "In Progress"
        case "awaiting_approval": return "Needs Approval"
        case "completed": return "Completed"
        case "failed": return "Failed"
        case "cancelled": return "Cancelled"
        default: return currentTask.status.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    private var emailActionID: UUID? {
        guard let id = currentTask.result?["email_action_id"]?.value as? String else { return nil }
        return UUID(uuidString: id)
    }

    private var emailSendApprovalMessage: String {
        if let to = emailDraft?.toAddress {
            return "Recipient \(to), the subject, body, and approval metadata will leave Ghola for Gmail."
        }
        return "The recipient, subject, body, and approval metadata will leave Ghola for Gmail."
    }

    private var privacyBoundaryTitle: String {
        if let boundary = currentTask.privacyBoundary, !boundary.isEmpty {
            return boundary
        }
        switch currentTask.networkScope {
        case "localServerChat":
            return "Local network"
        case "cloudChat", "auth", "billing", "providerConfig", "agentPlan", "remoteAgentCompute", "swarmExecution":
            return "Ghola Cloud"
        case "callExecution", "emailDraft", "emailSend", "calendarExecution", "walletProvision", "walletTransfer", "smsSend":
            return "External provider"
        default:
            return "On device"
        }
    }

    private var privacyBoundaryIcon: String {
        switch privacyBoundaryTitle {
        case "On device":
            return "iphone.gen3"
        case "Local network":
            return "network"
        case "Ghola Cloud":
            return "cloud"
        default:
            return "lock.shield"
        }
    }

    @ViewBuilder
    private func resultView(_ result: [String: AnyCodable]) -> some View {
        if let status = result["status"]?.value as? String {
            Text(status.replacingOccurrences(of: "_", with: " ").capitalized)
                .font(Theme.bodyFont)
        } else {
            Text("Task result is available.")
                .font(Theme.bodyFont)
        }
    }

    private func startPolling() {
        refreshTask?.cancel()
        guard ["pending", "in_progress", "awaiting_approval"].contains(currentTask.status) else { return }
        refreshTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                await refresh()
                if !["pending", "in_progress", "awaiting_approval"].contains(currentTask.status) {
                    return
                }
            }
        }
    }

    private func refresh() async {
        do {
            async let task = CloudClient.shared.getTask(id: currentTask.id)
            async let steps = CloudClient.shared.getTaskSteps(taskId: currentTask.id)
            let refreshed = try await task
            let refreshedSteps = (try? await steps) ?? []
            let draft = await loadEmailDraftIfNeeded(from: refreshed)
            await MainActor.run {
                currentTask = refreshed
                self.steps = refreshedSteps
                self.emailDraft = draft
            }
        } catch {
            // Keep displaying the last-known task state if refresh fails.
        }
    }

    private func loadEmailDraftIfNeeded(from task: TaskResponse) async -> EmailResponse? {
        guard task.taskType == "email",
              task.status == "awaiting_approval",
              let idString = task.result?["email_action_id"]?.value as? String,
              let id = UUID(uuidString: idString) else {
            return nil
        }
        return try? await CloudClient.shared.getEmailDetail(id: id)
    }

    private func sendEmailDraft() async {
        guard let emailActionID else { return }
        await MainActor.run {
            isSendingEmail = true
            actionError = nil
        }
        do {
            let approval = PrivacyGate.makeApproval(
                scope: .emailSend,
                summary: "Send approved email draft through Ghola Cloud and Gmail."
            )
            _ = try await CloudClient.shared.sendEmail(id: emailActionID, approval: approval)
            await refresh()
        } catch {
            await MainActor.run {
                actionError = error.localizedDescription
            }
        }
        await MainActor.run {
            isSendingEmail = false
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
        case "completed": return Theme.success
        case "in_progress": return Theme.accent
        case "failed": return Theme.danger
        default: return Theme.textSecondary
        }
    }
}

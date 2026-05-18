import SwiftUI

struct HomeView: View {
    @EnvironmentObject var auth: AuthManager
    var onSelectChat: () -> Void = {}
    @State private var tasks: [TaskResponse] = []
    @State private var providerHealth: ProviderHealthResponse?
    @State private var isLoading = false
    @State private var creatingTaskType: String?
    @State private var selectedTask: TaskResponse?
    @State private var isShowingSelectedTask = false
    @State private var actionError: String?
    @State private var tasksLoadError: String?
    @State private var activePollTask: Task<Void, Never>?
    @State private var selectedQuickAction: QuickActionKind?
    @State private var isShowingSettings = false

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
                    heroCard
                    quickActions
                    tasksSection
                }
                .padding(.vertical, Theme.paddingMd)
            }
            .background(Theme.appBackgroundGradient.ignoresSafeArea())
            .navigationTitle("")
            .navigationDestination(isPresented: $isShowingSelectedTask) {
                if let selectedTask {
                    TaskDetailView(task: selectedTask)
                }
            }
            .alert("Action failed", isPresented: errorBinding) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(actionError ?? "Something went wrong.")
            }
            .sheet(item: $selectedQuickAction) { action in
                QuickActionFormView(action: action, providerHealth: providerHealth) { params in
                    selectedQuickAction = nil
                    createTask(
                        type: action.rawValue,
                        params: params,
                        approval: PrivacyGate.makeApproval(
                            scope: action.networkScope,
                            summary: action.approvalSummary
                        )
                    )
                }
            }
            .sheet(isPresented: $isShowingSettings) {
                SettingsView()
            }
            .refreshable {
                await loadProviderHealth()
                await loadTasks()
            }
            .task {
                await loadProviderHealth()
                await loadTasks()
                startActiveTaskPolling()
            }
            .onDisappear {
                activePollTask?.cancel()
                activePollTask = nil
            }
        }
    }

    private var heroCard: some View {
        HStack(alignment: .top, spacing: Theme.paddingMd) {
            VStack(alignment: .leading, spacing: Theme.paddingSm) {
                Text(greeting)
                    .font(Theme.titleFont)
                    .foregroundStyle(Theme.textPrimary)
                Text("What can I help you move forward today?")
                    .font(Theme.bodyFont)
                    .foregroundStyle(Theme.textSecondary)
            }

            Spacer(minLength: Theme.paddingSm)

            Button {
                isShowingSettings = true
            } label: {
                Image(systemName: "gearshape.fill")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .frame(width: 40, height: 40)
                    .background(
                        Circle()
                            .fill(Theme.surfaceGradient)
                    )
                    .overlay(
                        Circle()
                            .stroke(Theme.cardBorder, lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Settings")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.paddingLg)
        .background(
            RoundedRectangle(cornerRadius: Theme.cornerLg)
                .fill(Theme.brandSurfaceGradient)
        )
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Theme.brandBandGradient)
                .frame(height: 6)
        }
        .overlay(
            RoundedRectangle(cornerRadius: Theme.cornerLg)
                .stroke(Theme.accentStrokeGradient, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.cornerLg))
        .shadow(color: Theme.cardShadow, radius: 10, x: 0, y: 6)
        .padding(.horizontal)
    }

    // MARK: - Quick Actions

    private var quickActions: some View {
        VStack(alignment: .leading, spacing: Theme.paddingMd) {
            Text("Quick Actions")
                .font(Theme.headlineFont)
                .padding(.horizontal)

            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible()),
            ], spacing: Theme.paddingMd) {
                QuickActionButton(
                    title: "Call",
                    icon: "phone.fill",
                    color: Theme.callGreen,
                    isLoading: creatingTaskType == "call",
                    action: { selectedQuickAction = .call }
                )
                QuickActionButton(
                    title: "Email",
                    icon: "envelope.fill",
                    color: Theme.emailBlue,
                    isLoading: creatingTaskType == "email",
                    action: { selectedQuickAction = .email }
                )
                QuickActionButton(
                    title: "Calendar",
                    icon: "calendar",
                    color: Theme.calendarOrange,
                    isLoading: creatingTaskType == "calendar",
                    action: { selectedQuickAction = .calendar }
                )
                QuickActionButton(
                    title: "Chat",
                    icon: "bubble.left.fill",
                    color: Theme.chatPurple,
                    action: onSelectChat
                )
            }
            .padding(.horizontal)
        }
    }

    private var tasksSection: some View {
        VStack(alignment: .leading, spacing: Theme.paddingMd) {
            Text("Active Tasks")
                .font(Theme.headlineFont)
                .padding(.horizontal)

            if let tasksLoadError {
                Label(tasksLoadError, systemImage: "wifi.exclamationmark")
                    .font(Theme.captionFont)
                    .foregroundStyle(Theme.warning)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                    .background(
                        RoundedRectangle(cornerRadius: Theme.cornerMd)
                            .fill(Theme.surfaceGradient)
                    )
                    .padding(.horizontal)
            }

            if isLoading && tasks.isEmpty {
                ProgressView("Loading tasks…")
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding()
                    .background(
                        RoundedRectangle(cornerRadius: Theme.cornerMd)
                            .fill(Theme.surfaceGradient)
                    )
                    .padding(.horizontal)
            } else if tasks.isEmpty {
                Text("No active tasks right now.")
                    .font(Theme.bodyFont)
                    .foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                    .background(
                        RoundedRectangle(cornerRadius: Theme.cornerMd)
                            .fill(Theme.surfaceGradient)
                    )
                    .padding(.horizontal)
            } else {
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
    }

    // MARK: - Data

    private var errorBinding: Binding<Bool> {
        Binding(
            get: { actionError != nil },
            set: { if !$0 { actionError = nil } }
        )
    }

    private func loadTasks() async {
        isLoading = true
        defer { isLoading = false }
        do {
            tasks = try await CloudClient.shared.listTasks()
                .filter { ["pending", "in_progress", "awaiting_approval"].contains($0.status) }
            tasksLoadError = nil
        } catch {
            tasksLoadError = error.localizedDescription
        }
    }

    private func loadProviderHealth() async {
        providerHealth = try? await CloudClient.shared.getProviderHealth()
    }

    private func startActiveTaskPolling() {
        activePollTask?.cancel()
        activePollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                await refreshActiveTasks()
            }
        }
    }

    private func refreshActiveTasks() async {
        guard !tasks.isEmpty else { return }
        do {
            let latest = try await CloudClient.shared.listTasks()
            let active = latest.filter { ["pending", "in_progress", "awaiting_approval"].contains($0.status) }
            await MainActor.run {
                tasks = active
                if let selectedTask,
                   let refreshed = latest.first(where: { $0.id == selectedTask.id }) {
                    self.selectedTask = refreshed
                }
            }
        } catch {
            // Keep the last-known task list if the network refresh fails.
        }
    }

    private func createTask(type: String, params: [String: Any], approval: PrivacyApproval) {
        guard creatingTaskType == nil else { return }
        creatingTaskType = type
        actionError = nil
        Task {
            do {
                let task = try await CloudClient.shared.createTask(
                    type: type,
                    templateId: nil,
                    params: params,
                    approval: approval
                )
                await MainActor.run {
                    creatingTaskType = nil
                    tasks.insert(task, at: 0)
                    selectedTask = task
                    isShowingSelectedTask = true
                }
                await pollCreatedTask(id: task.id)
            } catch {
                await MainActor.run {
                    creatingTaskType = nil
                    actionError = error.localizedDescription
                }
            }
        }
    }

    private func pollCreatedTask(id: UUID) async {
        for _ in 0..<15 {
            do {
                try await Task.sleep(nanoseconds: 1_000_000_000)
                let refreshed = try await CloudClient.shared.getTask(id: id)
                await MainActor.run {
                    if let index = tasks.firstIndex(where: { $0.id == id }) {
                        if ["completed", "failed", "cancelled"].contains(refreshed.status) {
                            tasks.remove(at: index)
                        } else {
                            tasks[index] = refreshed
                        }
                    } else if ["pending", "in_progress", "awaiting_approval"].contains(refreshed.status) {
                        tasks.insert(refreshed, at: 0)
                    }

                    if selectedTask?.id == id {
                        selectedTask = refreshed
                    }
                }

                if !["pending", "in_progress"].contains(refreshed.status) {
                    return
                }
            } catch {
                return
            }
        }
    }
}

private enum QuickActionKind: String, Identifiable {
    case call
    case email
    case calendar

    var id: String { rawValue }

    var title: String {
        switch self {
        case .call: return "Start a call"
        case .email: return "Draft an email"
        case .calendar: return "Create event"
        }
    }

    var privacyIcon: String {
        switch self {
        case .call: return "phone.connection"
        case .email: return "envelope.badge.shield.half.filled"
        case .calendar: return "calendar.badge.exclamationmark"
        }
    }

    var privacyLabel: String {
        switch self {
        case .call: return "External call execution"
        case .email: return "External email execution"
        case .calendar: return "External calendar execution"
        }
    }

    var privacyDescription: String {
        switch self {
        case .call:
            return "The phone number and call objective are sent to Ghola Cloud and the configured calling provider."
        case .email:
            return "The recipient and draft intent are sent to Ghola Cloud and the configured email/model provider."
        case .calendar:
            return "The event title, time, timezone, and location are sent to Ghola Cloud and the configured calendar provider."
        }
    }

    var networkScope: NetworkScope {
        switch self {
        case .call: return .callExecution
        case .email: return .emailDraft
        case .calendar: return .calendarExecution
        }
    }

    var approvalSummary: String {
        switch self {
        case .call:
            return "Call execution via Ghola Cloud and the configured calling provider."
        case .email:
            return "Email draft generation via Ghola Cloud and the configured model provider."
        case .calendar:
            return "Calendar event execution via Ghola Cloud and the configured calendar provider."
        }
    }
}

private struct QuickActionFormView: View {
    let action: QuickActionKind
    let providerHealth: ProviderHealthResponse?
    let onSubmit: ([String: Any]) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var phoneNumber = ""
    @State private var objective = ""
    @State private var recipientEmail = ""
    @State private var emailIntent = ""
    @State private var eventTitle = ""
    @State private var eventLocation = ""
    @State private var startDate = Date().addingTimeInterval(3600)
    @State private var endDate = Date().addingTimeInterval(7200)
    @State private var approvedNetworkExecution = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label(action.privacyLabel, systemImage: action.privacyIcon)
                    Text(action.privacyDescription)
                        .font(Theme.captionFont)
                        .foregroundStyle(Theme.textSecondary)

                    Toggle("Approve network execution", isOn: $approvedNetworkExecution)
                } header: {
                    Text("Privacy")
                }

                if let providerBlockMessage {
                    Section {
                        Label("Not live yet", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(Theme.warning)
                        Text(providerBlockMessage)
                            .font(Theme.captionFont)
                            .foregroundStyle(Theme.textSecondary)
                    } header: {
                        Text("Availability")
                    }
                } else if action == .calendar {
                    Section {
                        Label("Google account required", systemImage: "calendar.badge.clock")
                            .foregroundStyle(Theme.textSecondary)
                        Text("Connect Google in Settings before creating calendar events.")
                            .font(Theme.captionFont)
                            .foregroundStyle(Theme.textSecondary)
                    } header: {
                        Text("Availability")
                    }
                }

                switch action {
                case .call:
                    Section {
                        TextField("Phone number", text: $phoneNumber)
                            #if os(iOS)
                            .keyboardType(.phonePad)
                            #endif
                        TextField("What should Ghola do on the call?", text: $objective, axis: .vertical)
                            .lineLimit(3...5)
                    }
                case .email:
                    Section {
                        TextField("Recipient email", text: $recipientEmail)
                            #if os(iOS)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            #endif
                        TextField("What should Ghola draft?", text: $emailIntent, axis: .vertical)
                            .lineLimit(3...5)
                    }
                case .calendar:
                    Section {
                        TextField("Event title", text: $eventTitle)
                        DatePicker("Starts", selection: $startDate)
                        DatePicker("Ends", selection: $endDate)
                        TextField("Location", text: $eventLocation)
                    }
                }
            }
            .navigationTitle(action.title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        onSubmit(params)
                    }
                    .disabled(!canSubmit)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onChange(of: startDate) { _, newValue in
            if endDate <= newValue {
                endDate = newValue.addingTimeInterval(3600)
            }
        }
    }

    private var isValid: Bool {
        switch action {
        case .call:
            return phoneNumber.trimmingCharacters(in: .whitespacesAndNewlines).count >= 7
                && !objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .email:
            return recipientEmail.contains("@")
                && recipientEmail.contains(".")
                && !emailIntent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .calendar:
            return !eventTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && endDate > startDate
        }
    }

    private var canSubmit: Bool {
        isValid && approvedNetworkExecution && providerBlockMessage == nil
    }

    private var providerBlockMessage: String? {
        guard let providerHealth else { return nil }
        switch action {
        case .call:
            return providerHealth.blandAI == true ? nil : "Calling is blocked because the calling provider is not configured on this backend."
        case .email:
            return providerHealth.hasCloudModelProvider ? nil : "Email drafting is blocked because no cloud model provider is configured on this backend."
        case .calendar:
            return providerHealth.gmail == true ? nil : "Calendar is blocked because Google OAuth is not configured on this backend."
        }
    }

    private var params: [String: Any] {
        switch action {
        case .call:
            return [
                "phone_number": phoneNumber.trimmingCharacters(in: .whitespacesAndNewlines),
                "objective": objective.trimmingCharacters(in: .whitespacesAndNewlines),
            ]
        case .email:
            let email = recipientEmail.trimmingCharacters(in: .whitespacesAndNewlines)
            let intent = emailIntent.trimmingCharacters(in: .whitespacesAndNewlines)
            return [
                "to_address": email,
                "intent": "Draft an email to \(email). \(intent)",
                "context": intent,
            ]
        case .calendar:
            var result: [String: Any] = [
                "action": "create_event",
                "title": eventTitle.trimmingCharacters(in: .whitespacesAndNewlines),
                "start": ISO8601DateFormatter().string(from: startDate),
                "end": ISO8601DateFormatter().string(from: endDate),
                "timezone": TimeZone.current.identifier,
            ]
            let location = eventLocation.trimmingCharacters(in: .whitespacesAndNewlines)
            if !location.isEmpty {
                result["location"] = location
            }
            return result
        }
    }
}

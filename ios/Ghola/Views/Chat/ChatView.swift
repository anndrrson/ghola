import SwiftUI

struct ChatView: View {
    @State private var messages: [ChatMessage] = []
    @State private var inputText = ""
    @State private var isStreaming = false
    @FocusState private var isInputFocused: Bool

    // Single backend instance for this chat surface. Built lazily so a
    // future `.mlxLocal` mode that throws at `make(...)` time doesn't
    // crash the view; we surface the error in-line on first send.
    //
    // The backend owns its own session-id continuity (CloudLlmBackend
    // pins it across generate calls), so ChatView no longer needs to
    // thread `sessionId` through every send.
    @State private var backend: LlmBackend? = nil
    @State private var backendError: String? = nil
    @AppStorage(BackendRegistry.selectedModeKey) private var selectedBackendModeRaw = BackendRegistry.defaultMode.rawValue

    private var selectedBackendMode: BackendMode {
        BackendMode(rawValue: selectedBackendModeRaw) ?? BackendRegistry.defaultMode
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                runtimeBanner

                // Messages
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: Theme.paddingSm) {
                            if messages.isEmpty {
                                emptyState
                            }
                            ForEach(messages) { message in
                                ChatBubble(message: message)
                                    .id(message.id)
                            }
                        }
                        .padding(.horizontal, Theme.paddingMd)
                        .padding(.vertical, Theme.paddingMd)
                    }
                    .onChange(of: messages.count) {
                        if let last = messages.last {
                            withAnimation {
                                proxy.scrollTo(last.id, anchor: .bottom)
                            }
                        }
                    }
                }

                Divider()

                // Input bar
                inputBar
            }
            .background(Theme.appBackgroundGradient.ignoresSafeArea())
            .navigationTitle("Chat")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .task {
                ensureBackend()
            }
            .onChange(of: selectedBackendModeRaw) { _, _ in
                rebuildBackend()
            }
        }
    }

    private var runtimeBanner: some View {
        HStack(spacing: Theme.paddingSm) {
            Image(systemName: runtimeIconName)
                .font(.caption.weight(.semibold))
                .foregroundStyle(runtimeAccentColor)
                .frame(width: 22, height: 22)
                .background(Circle().fill(runtimeAccentColor.opacity(0.12)))

            VStack(alignment: .leading, spacing: 2) {
                Text(runtimeTitle)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                Text(runtimeSubtitle)
                    .font(.caption2)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
            }

            Spacer(minLength: Theme.paddingSm)
        }
        .padding(.horizontal, Theme.paddingMd)
        .padding(.vertical, Theme.paddingSm)
        .background(Theme.cardBg)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Theme.cardBorder)
                .frame(height: 1)
        }
    }

    private var runtimeTitle: String {
        if let backend {
            return backend.runtimeBoundary.title
        }
        if backendError != nil {
            return "Local model not ready"
        }
        return selectedBackendMode.title
    }

    private var runtimeSubtitle: String {
        if let backend {
            switch backend.runtimeBoundary {
            case .onDevice:
                return "Inference stays on this iPhone."
            case .localNetwork:
                return "Prompts go to your paired local server."
            case .gholaCloud:
                return "Prompts go to Ghola Cloud/provider."
            }
        }
        return backendError ?? selectedBackendMode.privacyDescription
    }

    private var runtimeIconName: String {
        if let backend {
            switch backend.runtimeBoundary {
            case .onDevice: return "iphone.gen3"
            case .localNetwork: return "network"
            case .gholaCloud: return "cloud"
            }
        }
        return backendError == nil ? "cpu" : "exclamationmark.triangle"
    }

    private var runtimeAccentColor: Color {
        if let backend {
            switch backend.runtimeBoundary {
            case .onDevice: return Theme.success
            case .localNetwork: return Theme.accent
            case .gholaCloud: return Theme.warning
            }
        }
        return backendError == nil ? Theme.accent : Theme.warning
    }

    // MARK: - Input Bar

    private var inputBar: some View {
        HStack(spacing: Theme.paddingSm) {
            #if os(iOS)
            VoiceInputButton { transcribed in
                inputText = transcribed
                sendMessage()
            }
            #endif

            TextField("Message...", text: $inputText, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .focused($isInputFocused)
                .onSubmit { sendMessage() }
                .padding(.horizontal, Theme.paddingSm)
                .padding(.vertical, Theme.paddingSm)
                .background(Theme.cardBg)
                .clipShape(RoundedRectangle(cornerRadius: Theme.cornerLg))

            Button {
                sendMessage()
            } label: {
                Image(systemName: isStreaming ? "stop.circle.fill" : "arrow.up.circle.fill")
                    .font(.title2)
                    .foregroundStyle(inputText.isEmpty && !isStreaming ? Theme.textSecondary : Theme.accent)
            }
            .disabled(inputText.isEmpty && !isStreaming)
        }
        .padding(Theme.paddingMd)
        .background(
            RoundedRectangle(cornerRadius: Theme.cornerLg)
                .fill(Theme.surfaceGradient)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.cornerLg)
                .stroke(Theme.cardBorder, lineWidth: 1)
        )
        .padding(.horizontal, Theme.paddingMd)
        .padding(.vertical, Theme.paddingSm)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: Theme.paddingSm) {
            Text("Start a conversation")
                .font(Theme.headlineFont)
                .foregroundStyle(Theme.textPrimary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, Theme.paddingMd)
    }

    // MARK: - Backend wiring

    /// Build (or rebuild) the backend on the user's currently-selected
    /// mode selected in Settings. On-device-first remains the default and
    /// cloud is only used when the user explicitly selects it.
    private func ensureBackend() {
        guard backend == nil else { return }
        do {
            let mode = selectedBackendMode
            BackendRegistry.selectedMode = mode
            backend = try BackendRegistry.make(for: mode)
            backendError = nil
        } catch {
            backendError = error.localizedDescription
        }
    }

    private func rebuildBackend() {
        backend?.shutdown()
        backend = nil
        backendError = nil
        ensureBackend()
    }

    // MARK: - Send

    private func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isStreaming else { return }

        inputText = ""
        isInputFocused = false

        // Add user message
        messages.append(ChatMessage(role: .user, content: text, timestamp: Date()))

        // Add placeholder for assistant response
        let assistantMsg = ChatMessage(role: .assistant, content: "", timestamp: Date())
        messages.append(assistantMsg)
        let assistantIndex = messages.count - 1

        // Build the LlmMessage history from the visible UI history.
        // We map .error rows to nothing (they're terminal UI markers,
        // not LLM turns) and pass the rest as user/assistant turns.
        let history: [LlmMessage] = messages.compactMap { m in
            switch m.role {
            case .user: return LlmMessage(role: .user, content: m.content)
            case .assistant:
                // Skip the empty assistant placeholder we just appended
                // so it doesn't end up echoed as prior context.
                return m.content.isEmpty ? nil : LlmMessage(role: .assistant, content: m.content)
            case .error: return nil
            }
        }

        ensureBackend()

        if LlmRuntimeDisclosure.shouldAnswerDeterministically(text) {
            messages[assistantIndex].content = LlmRuntimeDisclosure.answer(
                selectedMode: selectedBackendMode,
                backend: backend,
                backendError: backendError,
                localServerName: CloudClient.localServerName,
                isLocalServerMode: CloudClient.isLocalMode
            )
            return
        }

        guard let backend else {
            let msg = backendError ?? "No backend available"
            messages[assistantIndex] = ChatMessage(role: .error, content: msg, timestamp: Date())
            return
        }

        isStreaming = true

        Task {
            defer { isStreaming = false }
            do {
                let response = try await backend.generate(
                    messages: history,
                    tools: [],
                    system: "",
                    forceToolUse: false
                )

                // Flatten ContentBlocks back into a single string for
                // the UI. The Cloud backend always returns a single
                // .text(...) block today; future backends (tool-use)
                // can expand this rendering.
                let flattened = response.contentBlocks
                    .compactMap { block -> String? in
                        if case .text(let s) = block { return s }
                        return nil
                    }
                    .joined()

                messages[assistantIndex].content = flattened
            } catch {
                messages[assistantIndex] = ChatMessage(
                    role: .error,
                    content: error.localizedDescription,
                    timestamp: Date()
                )
            }
        }
    }
}

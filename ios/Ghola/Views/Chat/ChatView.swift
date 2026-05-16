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

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Messages
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: Theme.paddingSm) {
                            ForEach(messages) { message in
                                ChatBubble(message: message)
                                    .id(message.id)
                            }
                        }
                        .padding()
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
            .background(Theme.bg)
            .navigationTitle("Chat")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .task {
                ensureBackend()
            }
        }
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
        .padding()
    }

    // MARK: - Backend wiring

    /// Build (or rebuild) the backend on the user's currently-selected
    /// mode. Today this is always `.cloud`; once a UI for switching
    /// modes lands, plumb it through here.
    private func ensureBackend() {
        guard backend == nil else { return }
        do {
            backend = try BackendRegistry.make(for: BackendRegistry.defaultMode)
            backendError = nil
        } catch {
            backendError = error.localizedDescription
        }
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

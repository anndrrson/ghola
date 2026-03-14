import SwiftUI

struct ChatView: View {
    @State private var messages: [ChatMessage] = []
    @State private var inputText = ""
    @State private var isStreaming = false
    @State private var sessionId: UUID?
    @FocusState private var isInputFocused: Bool

    private let sseClient = SSEClient()

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

        isStreaming = true

        Task {
            let stream = await sseClient.stream(sessionId: sessionId, message: text)

            for await event in stream {
                switch event {
                case .sessionId(let id):
                    sessionId = id

                case .textDelta(let delta):
                    messages[assistantIndex].content += delta

                case .error(let msg):
                    messages[assistantIndex] = ChatMessage(
                        role: .error,
                        content: msg,
                        timestamp: Date()
                    )

                case .done:
                    break
                }
            }

            isStreaming = false
        }
    }
}

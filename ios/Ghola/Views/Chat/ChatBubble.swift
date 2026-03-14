import SwiftUI

struct ChatBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            if message.isUser { Spacer(minLength: 60) }

            VStack(alignment: message.isUser ? .trailing : .leading, spacing: 4) {
                Text(message.content.isEmpty ? " " : message.content)
                    .font(Theme.bodyFont)
                    .foregroundStyle(message.role == .error ? .red : Theme.textPrimary)
                    .textSelection(.enabled)
            }
            .padding(.horizontal, Theme.paddingMd)
            .padding(.vertical, Theme.paddingSm + 2)
            .background(bubbleColor)
            .clipShape(RoundedRectangle(cornerRadius: Theme.cornerLg))

            if !message.isUser { Spacer(minLength: 60) }
        }
    }

    private var bubbleColor: Color {
        switch message.role {
        case .user: return Theme.accent.opacity(0.2)
        case .assistant: return Theme.cardBg
        case .error: return Color.red.opacity(0.1)
        }
    }
}

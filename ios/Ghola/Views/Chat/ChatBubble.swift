import SwiftUI

struct ChatBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            Text(message.content.isEmpty ? " " : message.content)
                .font(Theme.bodyFont)
                .foregroundStyle(textColor)
                .textSelection(.enabled)
                .padding(.horizontal, Theme.paddingMd)
                .padding(.vertical, Theme.paddingSm + 2)
                .frame(maxWidth: 320, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: Theme.cornerLg)
                        .fill(bubbleFill)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.cornerLg)
                        .stroke(bubbleStroke, lineWidth: 1)
                )
        }
        .frame(maxWidth: .infinity, alignment: message.isUser ? .trailing : .leading)
    }

    private var bubbleFill: AnyShapeStyle {
        switch message.role {
        case .user: return AnyShapeStyle(Theme.accentGradient)
        case .assistant: return AnyShapeStyle(Theme.surfaceGradient)
        case .error: return AnyShapeStyle(Theme.danger.opacity(0.14))
        }
    }

    private var bubbleStroke: Color {
        switch message.role {
        case .user: return Theme.accentSoft.opacity(0.55)
        case .assistant: return Theme.cardBorder
        case .error: return Theme.danger.opacity(0.3)
        }
    }

    private var textColor: Color {
        switch message.role {
        case .user: return .white
        case .assistant: return Theme.textPrimary
        case .error: return Theme.danger
        }
    }
}

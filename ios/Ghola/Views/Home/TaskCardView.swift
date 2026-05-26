import SwiftUI

struct TaskCardView: View {
    let task: TaskResponse

    var body: some View {
        HStack(spacing: Theme.paddingMd) {
            Image(systemName: task.typeIcon)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(colorForType)
                .frame(width: 42, height: 42)
                .background(colorForType.opacity(0.12))
                .overlay(Rectangle().stroke(colorForType.opacity(0.38), lineWidth: 1))

            VStack(alignment: .leading, spacing: 5) {
                Text(task.taskType.uppercased())
                    .font(Theme.monoFont.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)

                Text(statusText)
                    .font(Theme.captionFont)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(2)
            }

            Spacer(minLength: Theme.paddingSm)

            Text(statusLabel.uppercased())
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(statusColor)
                .lineLimit(1)
                .minimumScaleFactor(0.68)
                .padding(.horizontal, 8)
                .frame(height: 28)
                .background(statusColor.opacity(0.10))
                .overlay(Rectangle().stroke(statusColor.opacity(0.36), lineWidth: 1))
        }
        .padding(Theme.paddingMd)
        .background(Theme.cardBg)
        .overlay(
            Rectangle()
                .stroke(Theme.border, lineWidth: 1)
        )
        .padding(.horizontal)
    }

    private var colorForType: Color {
        switch task.taskType {
        case "call": return Theme.callGreen
        case "email": return Theme.emailBlue
        case "calendar": return Theme.calendarOrange
        default: return Theme.chatPurple
        }
    }

    private var statusText: String {
        switch task.status {
        case "pending": return "Queued"
        case "in_progress": return "Working"
        case "awaiting_approval": return "Needs your approval"
        case "completed": return "Done"
        case "failed": return task.errorMessage ?? "Failed"
        case "cancelled": return "Cancelled"
        default: return task.status
        }
    }

    private var statusColor: Color {
        switch task.status {
        case "completed": return Theme.success
        case "failed": return Theme.danger
        case "awaiting_approval": return Theme.warning
        case "in_progress": return Theme.accent
        default: return Theme.textSecondary
        }
    }

    private var statusLabel: String {
        switch task.status {
        case "pending": return "Queued"
        case "in_progress": return "Active"
        case "awaiting_approval": return "Approve"
        case "completed": return "Done"
        case "failed": return "Failed"
        case "cancelled": return "Cancelled"
        default: return task.status.capitalized
        }
    }
}

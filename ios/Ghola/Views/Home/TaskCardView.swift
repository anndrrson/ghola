import SwiftUI

struct TaskCardView: View {
    let task: TaskResponse

    var body: some View {
        HStack(spacing: Theme.paddingMd) {
            Image(systemName: task.typeIcon)
                .font(.title3.weight(.semibold))
                .foregroundStyle(colorForType)
                .frame(width: 40, height: 40)
                .background(colorForType.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: Theme.cornerSm))

            VStack(alignment: .leading, spacing: 4) {
                Text(task.taskType.capitalized)
                    .font(.headline.weight(.semibold))

                Text(statusText)
                    .font(Theme.captionFont)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(2)
            }

            Spacer()

            Text(statusLabel)
                .font(.caption.weight(.semibold))
                .foregroundStyle(statusColor)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(statusColor.opacity(0.14))
                .clipShape(Capsule())
        }
        .padding(Theme.paddingMd)
        .background(
            RoundedRectangle(cornerRadius: Theme.cornerMd)
                .fill(Theme.surfaceGradient)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.cornerMd)
                .stroke(Theme.cardBorder, lineWidth: 1)
        )
        .shadow(color: Theme.cardShadow, radius: 6, x: 0, y: 3)
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
        case "in_progress": return "Working on it..."
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
        case "in_progress": return "In progress"
        case "awaiting_approval": return "Approval"
        case "completed": return "Done"
        case "failed": return "Failed"
        case "cancelled": return "Cancelled"
        default: return task.status.capitalized
        }
    }
}

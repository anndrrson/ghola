import SwiftUI

struct TaskCardView: View {
    let task: TaskResponse

    var body: some View {
        HStack(spacing: Theme.paddingMd) {
            Image(systemName: task.typeIcon)
                .font(.title2)
                .foregroundStyle(colorForType)
                .frame(width: 44, height: 44)
                .background(colorForType.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: Theme.cornerSm))

            VStack(alignment: .leading, spacing: 4) {
                Text(task.taskType.capitalized)
                    .font(.headline)

                Text(statusText)
                    .font(Theme.captionFont)
                    .foregroundStyle(Theme.textSecondary)
            }

            Spacer()

            Image(systemName: task.statusEmoji)
                .foregroundStyle(statusColor)
        }
        .padding()
        .background(Theme.cardBg)
        .clipShape(RoundedRectangle(cornerRadius: Theme.cornerMd))
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
        case "completed": return .green
        case "failed": return .red
        case "awaiting_approval": return .orange
        case "in_progress": return .blue
        default: return Theme.textSecondary
        }
    }
}

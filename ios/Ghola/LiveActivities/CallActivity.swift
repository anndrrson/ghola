#if os(iOS)
import ActivityKit
import WidgetKit
import SwiftUI

struct CallActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var status: String     // "connecting", "in_progress", "completed", "failed"
        var duration: Int      // seconds elapsed
        var summary: String?   // outcome summary when done
    }

    var objective: String
    var phoneNumber: String
}

// MARK: - Live Activity Widget

struct CallActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: CallActivityAttributes.self) { context in
            // Lock Screen banner
            HStack {
                Image(systemName: statusIcon(context.state.status))
                    .font(.title2)
                    .foregroundStyle(statusColor(context.state.status))

                VStack(alignment: .leading) {
                    Text(context.attributes.objective)
                        .font(.headline)
                        .lineLimit(1)

                    if let summary = context.state.summary {
                        Text(summary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Text(statusLabel(context.state.status))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                if context.state.status == "in_progress" {
                    Text(formatDuration(context.state.duration))
                        .font(.system(.body, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }
            .padding()
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: "phone.fill")
                        .foregroundStyle(.green)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.objective)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if context.state.status == "in_progress" {
                        Text(formatDuration(context.state.duration))
                            .font(.system(.caption, design: .monospaced))
                    }
                }
            } compactLeading: {
                Image(systemName: "phone.fill")
                    .foregroundStyle(.green)
            } compactTrailing: {
                Text(formatDuration(context.state.duration))
                    .font(.system(.caption2, design: .monospaced))
            } minimal: {
                Image(systemName: "phone.fill")
                    .foregroundStyle(.green)
            }
        }
    }
}

private func statusIcon(_ status: String) -> String {
    switch status {
    case "connecting": return "phone.arrow.up.right"
    case "in_progress": return "phone.fill"
    case "completed": return "checkmark.circle.fill"
    case "failed": return "xmark.circle.fill"
    default: return "phone"
    }
}

private func statusColor(_ status: String) -> Color {
    switch status {
    case "connecting", "in_progress": return .green
    case "completed": return .blue
    case "failed": return .red
    default: return .secondary
    }
}

private func statusLabel(_ status: String) -> String {
    switch status {
    case "connecting": return "Connecting..."
    case "in_progress": return "Call in progress"
    case "completed": return "Call complete"
    case "failed": return "Call failed"
    default: return status
    }
}

private func formatDuration(_ seconds: Int) -> String {
    let m = seconds / 60
    let s = seconds % 60
    return String(format: "%d:%02d", m, s)
}
#endif

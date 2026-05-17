import SwiftUI

struct QuickActionButton: View {
    let title: String
    let icon: String
    let color: Color
    var isLoading = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: Theme.paddingMd) {
                Group {
                    if isLoading {
                        ProgressView()
                            .tint(.white)
                    } else {
                        Image(systemName: icon)
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(.white)
                    }
                }
                .frame(width: 42, height: 42)
                .background(
                    Circle()
                        .fill(
                            LinearGradient(
                                colors: [color, color.opacity(0.72)],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                )

                Text(isLoading ? "Starting..." : title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.82)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.paddingMd + 2)
            .background(
                RoundedRectangle(cornerRadius: Theme.cornerMd)
                    .fill(Theme.surfaceGradient)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.cornerMd)
                    .stroke(Theme.cardBorder, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
        .opacity(isLoading ? 0.78 : 1)
    }
}

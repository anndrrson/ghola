import SwiftUI

struct QuickActionButton: View {
    var number: String?
    let title: String
    let icon: String
    let color: Color
    var isLoading = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .center) {
                    Text(number ?? "")
                        .font(Theme.monoFont)
                        .foregroundStyle(Theme.textTertiary)
                        .frame(height: 18, alignment: .leading)

                    Spacer()

                    Group {
                        if isLoading {
                            ProgressView()
                                .tint(color)
                        } else {
                            Image(systemName: icon)
                                .font(.system(size: 18, weight: .semibold))
                                .foregroundStyle(color)
                        }
                    }
                    .frame(width: 26, height: 26)
                }

                Spacer(minLength: 8)

                Text(isLoading ? "STARTING" : title.uppercased())
                    .font(Theme.monoFont.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 122, alignment: .leading)
            .background(Theme.cardBg)
            .overlay(
                Rectangle()
                    .stroke(Theme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
        .opacity(isLoading ? 0.78 : 1)
    }
}

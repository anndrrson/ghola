import SwiftUI

struct QuickActionButton: View {
    let title: String
    let icon: String
    let color: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: Theme.paddingSm) {
                Image(systemName: icon)
                    .font(.title)
                    .foregroundStyle(color)

                Text(title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.textPrimary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.paddingLg)
            .background(Theme.cardBg)
            .clipShape(RoundedRectangle(cornerRadius: Theme.cornerMd))
        }
        .buttonStyle(.plain)
    }
}

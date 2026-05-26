import SwiftUI
#if os(iOS)
import AuthenticationServices
import UIKit
#endif

struct OnboardingView: View {
    @EnvironmentObject var auth: AuthManager

    var body: some View {
        ZStack {
            Theme.bg
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                Spacer(minLength: 34)

                VStack(alignment: .leading, spacing: 14) {
                    Text("ghola")
                        .font(.system(size: 44, weight: .semibold, design: .default))
                        .foregroundStyle(Theme.textPrimary)

                    Rectangle()
                        .fill(Theme.accent)
                        .frame(width: 76, height: 3)

                    Text("Unlock Ghola")
                        .font(Theme.displayFont)
                        .foregroundStyle(Theme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)

                    Text("Use your device passkey to create or unlock the Ghola wallet used for approvals on this phone.")
                        .font(Theme.bodyFont)
                        .foregroundStyle(Theme.textSecondary)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Spacer(minLength: 46)

                authPanel

                Spacer(minLength: 28)
            }
            .frame(maxWidth: 540, maxHeight: .infinity, alignment: .topLeading)
            .padding(.horizontal, Theme.paddingLg)
        }
    }

    private var authPanel: some View {
        VStack(alignment: .leading, spacing: Theme.paddingMd) {
            sectionLabel("GHOLA ACCESS")

            #if os(iOS)
            Button {
                guard let anchor = presentationAnchor() else {
                    auth.error = "Unable to present the Ghola passkey prompt."
                    return
                }
                Task { await auth.signInWithTurnkey(anchor: anchor) }
            } label: {
                HStack(spacing: 12) {
                    if auth.isLoading {
                        ProgressView()
                            .tint(.black)
                            .frame(width: 21, height: 21)
                    } else {
                        Image(systemName: "key.radiowaves.forward")
                            .font(.system(size: 18, weight: .semibold))
                            .frame(width: 21, height: 21)
                    }

                    Text(auth.isLoading ? "CONNECTING" : "CONTINUE")
                        .font(Theme.monoFont.weight(.semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.78)

                    Spacer(minLength: 10)

                    Image(systemName: "arrow.right")
                        .font(.system(size: 15, weight: .semibold))
                }
                .foregroundStyle(.black)
                .padding(.horizontal, Theme.paddingMd)
                .frame(maxWidth: .infinity, minHeight: 58)
                .background(Theme.accent)
                .overlay(
                    Rectangle()
                        .stroke(Theme.accentSoft.opacity(0.65), lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            .disabled(auth.isLoading)
            #else
            Text("Ghola passkey sign-in is available on iOS.")
                .font(Theme.bodyFont)
                .foregroundStyle(Theme.textSecondary)
            #endif

            VStack(alignment: .leading, spacing: 10) {
                statusRow("01", "Ghola passkey")
                statusRow("02", "Ghola wallet")
                statusRow("03", "Secure session")
            }

            if let error = auth.error {
                Text(error)
                    .font(Theme.captionFont)
                    .foregroundStyle(Theme.danger)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.danger.opacity(0.10))
                    .overlay(
                        Rectangle()
                            .stroke(Theme.danger.opacity(0.28), lineWidth: 1)
                    )
            }
        }
        .padding(Theme.paddingMd)
        .background(Theme.cardBg)
        .overlay(
            Rectangle()
                .stroke(Theme.border, lineWidth: 1)
        )
    }

    private func sectionLabel(_ title: String) -> some View {
        Text("› \(title)")
            .font(Theme.eyebrowFont)
            .foregroundStyle(Theme.textSecondary)
    }

    private func statusRow(_ number: String, _ title: String) -> some View {
        HStack(spacing: 12) {
            Text(number)
                .font(Theme.monoFont)
                .foregroundStyle(Theme.accent)
                .frame(width: 26, alignment: .leading)
            Text(title.uppercased())
                .font(Theme.monoFont)
                .foregroundStyle(Theme.textSecondary)
            Spacer()
            Rectangle()
                .fill(Theme.border)
                .frame(width: 18, height: 1)
        }
    }

    #if os(iOS)
    private func presentationAnchor() -> ASPresentationAnchor? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }
    }
    #endif
}

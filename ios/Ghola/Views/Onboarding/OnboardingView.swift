import SwiftUI
#if os(iOS)
import AuthenticationServices
#endif

struct OnboardingView: View {
    @EnvironmentObject var auth: AuthManager

    var body: some View {
        ZStack {
            Theme.appBackgroundGradient
                .ignoresSafeArea()

            ScrollView(showsIndicators: false) {
                VStack(spacing: Theme.paddingLg) {
                    Spacer(minLength: Theme.paddingLg)

                    VStack(spacing: 6) {
                        Text("Ghola")
                            .font(.system(size: 34, weight: .bold, design: .rounded))
                            .foregroundStyle(Theme.textPrimary)
                        Text("AI assistant for work that actually gets done.")
                            .font(.callout)
                            .foregroundStyle(Theme.textSecondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.horizontal, Theme.paddingLg)

                    authCard

                    Spacer(minLength: Theme.paddingXl)
                }
                .frame(maxWidth: 520)
                .padding(.bottom, Theme.paddingLg)
                .frame(maxWidth: .infinity)
            }
            #if os(iOS)
            .scrollDismissesKeyboard(.interactively)
            #endif
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .padding(.horizontal, Theme.paddingLg)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var authCard: some View {
        VStack(alignment: .leading, spacing: Theme.paddingMd) {
            Text("Sign in to Ghola")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
            Text("Continue with your account.")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)

            #if os(iOS)
            SignInWithAppleButton(.continue) { request in
                request.requestedScopes = [.fullName, .email]
            } onCompletion: { result in
                switch result {
                case .success(let authorization):
                    guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                        auth.error = "Sign in with Apple returned an unsupported credential."
                        return
                    }
                    Task { await auth.signInWithApple(credential: credential) }
                case .failure(let error):
                    auth.error = error.localizedDescription
                }
            }
            .signInWithAppleButtonStyle(.white)
            .frame(height: 50)
            .clipShape(RoundedRectangle(cornerRadius: Theme.cornerMd))
            .disabled(auth.isLoading)

            Label("Wallet sign-in is disabled until user-held signing is ready.", systemImage: "lock.shield")
                .font(Theme.captionFont)
                .foregroundStyle(Theme.textSecondary)
            #endif

            if let error = auth.error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.danger.opacity(0.10))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
        .padding(Theme.paddingLg)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Theme.brandSurfaceGradient)
        )
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Theme.brandBandGradient)
                .frame(height: 6)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(Theme.accentStrokeGradient, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .shadow(color: Theme.cardShadow, radius: 10, x: 0, y: 6)
    }
}

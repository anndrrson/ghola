import SwiftUI
#if os(iOS)
import AuthenticationServices
#endif

struct OnboardingView: View {
    @EnvironmentObject var auth: AuthManager
    @State private var email = ""
    @FocusState private var focusedEmail: Bool

    private var normalizedEmail: String {
        email.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var emailLooksValid: Bool {
        normalizedEmail.contains("@") && normalizedEmail.contains(".")
    }

    private var canSubmit: Bool {
        emailLooksValid && !auth.isLoading
    }

    private var submitTitle: String {
        "Continue"
    }

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

            HStack(spacing: Theme.paddingSm) {
                Rectangle()
                    .fill(Theme.cardBorder)
                    .frame(height: 1)
                Text("or")
                    .font(Theme.captionFont)
                    .foregroundStyle(Theme.textSecondary)
                Rectangle()
                    .fill(Theme.cardBorder)
                    .frame(height: 1)
            }
            #endif

            TextField("Email", text: $email)
                .textContentType(.emailAddress)
                #if os(iOS)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                #endif
                .autocorrectionDisabled(true)
                .focused($focusedEmail)
                .submitLabel(.go)
                .onSubmit { submit() }
                .authFieldStyle()

            if let error = auth.error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.danger.opacity(0.10))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }

            Button(action: submit) {
                HStack {
                    Spacer()
                    if auth.isLoading {
                        ProgressView()
                            .tint(.white)
                    } else {
                        Text(submitTitle)
                            .font(.headline)
                    }
                    Spacer()
                }
                .frame(height: 50)
                .background(Theme.accentGradient)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: Theme.cornerMd))
            }
            .disabled(!canSubmit)
            .opacity(canSubmit ? 1 : 0.5)
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

    private func submit() {
        guard canSubmit else { return }
        Task {
            auth.error = nil
            await auth.signInWithTurnkey(email: normalizedEmail)
        }
    }
}

private extension View {
    func authFieldStyle() -> some View {
        self
            .padding(.horizontal, Theme.paddingMd)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: Theme.cornerMd, style: .continuous)
                    .fill(Theme.cardBg)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.cornerMd, style: .continuous)
                    .stroke(Theme.cardBorder, lineWidth: 1)
            )
    }
}

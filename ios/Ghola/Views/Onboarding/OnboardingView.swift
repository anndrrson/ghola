import SwiftUI

struct OnboardingView: View {
    @EnvironmentObject var auth: AuthManager
    @State private var email = ""
    @State private var password = ""
    @State private var name = ""
    @State private var isSignUp = true

    var body: some View {
        VStack(spacing: Theme.paddingLg) {
            Spacer()

            Image(systemName: "brain.head.profile")
                .font(.system(size: 80))
                .foregroundStyle(.blue.gradient)

            Text("Ghola")
                .font(Theme.titleFont)

            Text("Your AI personal assistant.\nCalls, emails, and more — in one tap.")
                .font(Theme.bodyFont)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Theme.paddingXl)

            Spacer()

            // Auth form
            VStack(spacing: Theme.paddingMd) {
                if isSignUp {
                    TextField("Name (optional)", text: $name)
                        .textFieldStyle(.roundedBorder)
                        .textContentType(.name)
                }

                TextField("Email", text: $email)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.emailAddress)
                    #if os(iOS)
                    .autocapitalization(.none)
                    .keyboardType(.emailAddress)
                    #endif

                SecureField("Password", text: $password)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(isSignUp ? .newPassword : .password)

                Button {
                    Task {
                        if isSignUp {
                            await auth.signUp(
                                email: email,
                                password: password,
                                name: name.isEmpty ? nil : name
                            )
                        } else {
                            await auth.signIn(email: email, password: password)
                        }
                    }
                } label: {
                    HStack {
                        Spacer()
                        if auth.isLoading {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Text(isSignUp ? "Create Account" : "Sign In")
                                .fontWeight(.semibold)
                        }
                        Spacer()
                    }
                    .frame(height: 50)
                    .background(Theme.accent)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.cornerMd))
                }
                .disabled(email.isEmpty || password.isEmpty || auth.isLoading)

                Button {
                    isSignUp.toggle()
                    auth.error = nil
                } label: {
                    Text(isSignUp ? "Already have an account? Sign In" : "Need an account? Sign Up")
                        .font(Theme.captionFont)
                        .foregroundStyle(Theme.accent)
                }

                if let error = auth.error {
                    Text(error)
                        .font(Theme.captionFont)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(.horizontal, Theme.paddingXl)

            Spacer()
                .frame(height: Theme.paddingXl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
    }
}

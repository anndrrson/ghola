import SwiftUI
#if os(iOS)
import AuthenticationServices
import UIKit
#endif

struct OnboardingView: View {
    @EnvironmentObject var auth: AuthManager

    #if os(iOS)
    @State private var email = ""
    @State private var code = ""
    @State private var emailChallenge: NativeTurnkeyEmailChallenge?
    @FocusState private var focusedField: SignInField?

    private enum SignInField {
        case email
        case code
    }
    #endif

    var body: some View {
        ZStack {
            Theme.bg
                .ignoresSafeArea()

            PixelHeroBackground()

            VStack(spacing: 0) {
                Spacer(minLength: 72)

                brandLockup

                Spacer(minLength: 64)

                continuePanel

                Spacer(minLength: 28)
            }
            .frame(maxWidth: 540, maxHeight: .infinity)
            .padding(.horizontal, 28)
        }
    }

    private var brandLockup: some View {
        VStack(spacing: 16) {
            GholaGlyph(size: 78)
                .shadow(color: Theme.accent.opacity(0.24), radius: 18, x: 0, y: 0)

            Text("ghola")
                .font(.system(size: 68, weight: .medium, design: .default))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)

            Text("PRIVATE AI / LOCAL FIRST / SIGNED RECEIPTS")
                .font(.system(size: 10, weight: .medium, design: .monospaced))
                .tracking(2.8)
                .foregroundStyle(Color(red: 0.435, green: 0.490, blue: 0.604))
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.72)
        }
        .frame(maxWidth: .infinity)
    }

    private var continuePanel: some View {
        VStack(alignment: .leading, spacing: 12) {

            #if os(iOS)
            if let emailChallenge {
                codeEntry(email: emailChallenge.email)
            } else {
                emailEntry
            }

            Button {
                Task { await advanceEmailFlow() }
            } label: {
                HStack(spacing: 12) {
                    if auth.isLoading {
                        ProgressView()
                            .tint(.black)
                            .frame(width: 21, height: 21)
                    } else {
                        Image(systemName: emailChallenge == nil ? "envelope" : "arrow.right")
                            .font(.system(size: 17, weight: .semibold))
                            .frame(width: 21, height: 21)
                    }

                    Text(primaryButtonTitle)
                        .font(.system(size: 17, weight: .medium))
                        .lineLimit(1)
                        .minimumScaleFactor(0.78)

                    Spacer()
                }
                .foregroundStyle(.black)
                .padding(.horizontal, 18)
                .frame(maxWidth: .infinity, minHeight: 56)
                .background(Theme.textPrimary)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(Color.white.opacity(0.18), lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            .disabled(auth.isLoading || !canSubmit)
            .opacity(canSubmit ? 1 : 0.58)

            if emailChallenge != nil {
                Button {
                    resetEmailFlow()
                } label: {
                    Label("Change email", systemImage: "arrow.uturn.left")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Color(red: 0.682, green: 0.729, blue: 0.827))
                }
                .buttonStyle(.plain)
                .disabled(auth.isLoading)
                .padding(.top, 2)
            }
            #else
            Text("Continue on iPhone.")
                .font(Theme.bodyFont)
                .foregroundStyle(Theme.textSecondary)
            #endif

            if let error = auth.error {
                Text(error)
                    .font(Theme.captionFont)
                    .foregroundStyle(Theme.danger)
                    .padding(.horizontal, 2)
                    .padding(.top, 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity)
    }

    #if os(iOS)
    private var emailEntry: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("Email")
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .tracking(1.8)
                .foregroundStyle(Color(red: 0.435, green: 0.490, blue: 0.604))

            TextField("", text: $email, prompt: Text("you@example.com").foregroundStyle(Color.white.opacity(0.32)))
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textContentType(.emailAddress)
                .focused($focusedField, equals: .email)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Theme.textPrimary)
                .tint(Theme.accent)
                .padding(.horizontal, 14)
                .frame(height: 52)
                .background(fieldBackground(isFocused: focusedField == .email))
        }
    }

    private func codeEntry(email: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("Code sent to \(email)")
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .tracking(1.3)
                .foregroundStyle(Color(red: 0.435, green: 0.490, blue: 0.604))
                .lineLimit(1)
                .minimumScaleFactor(0.68)

            TextField("", text: $code, prompt: Text("000000").foregroundStyle(Color.white.opacity(0.32)))
                .keyboardType(.asciiCapable)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .textContentType(.oneTimeCode)
                .focused($focusedField, equals: .code)
                .font(.system(size: 19, weight: .medium, design: .monospaced))
                .foregroundStyle(Theme.textPrimary)
                .tint(Theme.accent)
                .padding(.horizontal, 14)
                .frame(height: 52)
                .background(fieldBackground(isFocused: focusedField == .code))
                .onChange(of: code) { _, newValue in
                    let cleaned = cleanCode(newValue)
                    if cleaned != newValue {
                        code = cleaned
                    }
                }
        }
    }

    private func fieldBackground(isFocused: Bool) -> some View {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(Color.white.opacity(isFocused ? 0.105 : 0.074))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(
                        isFocused ? Theme.accent.opacity(0.58) : Color.white.opacity(0.14),
                        lineWidth: 1
                    )
            )
    }

    private var primaryButtonTitle: String {
        if auth.isLoading {
            return emailChallenge == nil ? "Sending" : "Continuing"
        }
        return emailChallenge == nil ? "Send code" : "Continue"
    }

    private var canSubmit: Bool {
        if emailChallenge != nil {
            return cleanCode(code).count == 6
        }
        return isValidEmail(email)
    }

    @MainActor
    private func advanceEmailFlow() async {
        guard !auth.isLoading else { return }

        if let emailChallenge {
            await auth.completeGholaEmailSignIn(
                challenge: emailChallenge,
                code: cleanCode(code)
            )
            return
        }

        if let challenge = await auth.requestGholaEmailCode(email: email) {
            emailChallenge = challenge
            code = ""
            focusedField = .code
        }
    }

    private func resetEmailFlow() {
        emailChallenge = nil
        code = ""
        auth.error = nil
        focusedField = .email
    }

    private func isValidEmail(_ input: String) -> Bool {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.split(separator: "@", omittingEmptySubsequences: true)
        guard parts.count == 2,
              parts[0].count >= 1,
              parts[1].contains(".") else {
            return false
        }
        return true
    }

    private func cleanCode(_ input: String) -> String {
        String(input.uppercased().filter { $0.isLetter || $0.isNumber }.prefix(6))
    }

    private func presentationAnchor() -> ASPresentationAnchor? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }
    }
    #endif
}

private struct PixelHeroBackground: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let paleLayer = PixelLayer(
        color: Color(red: 0.682, green: 0.729, blue: 0.827),
        pixelSize: 4,
        patternScale: 2.9,
        patternDensity: 1.68,
        pixelJitter: 0.02,
        edgeFade: 0.01,
        speed: 1.05,
        seed: 81,
        opacity: 0.78
    )

    private let blueLayer = PixelLayer(
        color: Color(red: 0.275, green: 0.498, blue: 0.698),
        pixelSize: 6,
        patternScale: 3.8,
        patternDensity: 1.46,
        pixelJitter: 0.03,
        edgeFade: 0.01,
        speed: 0.82,
        seed: 137,
        opacity: 0.42
    )

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion)) { timeline in
            Canvas { context, size in
                context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.black))

                let time = reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate
                drawPixelField(paleLayer, in: &context, size: size, time: time)
                drawPixelField(blueLayer, in: &context, size: size, time: time)
            }
        }
        .overlay {
            LinearGradient(
                stops: [
                    .init(color: .black.opacity(0.02), location: 0.0),
                    .init(color: .black.opacity(0.10), location: 0.52),
                    .init(color: .black.opacity(0.84), location: 1.0),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func drawPixelField(
        _ layer: PixelLayer,
        in context: inout GraphicsContext,
        size canvasSize: CGSize,
        time: TimeInterval
    ) {
        let width = max(canvasSize.width, 1)
        let height = max(canvasSize.height, 1)
        let pitch = max(CGFloat(4), layer.pixelSize * 2)
        let columns = Int(ceil(width / pitch)) + 2
        let rows = Int(ceil(height / pitch)) + 2
        let densityBias = clamp(layer.patternDensity / 1.55, 0.18, 1.55)
        let t = CGFloat(time) * layer.speed

        for row in -1..<rows {
            for column in -1..<columns {
                let x = CGFloat(column) * pitch
                let y = CGFloat(row) * pitch
                let nx = x / width
                let ny = y / height

                let edgeDistance = min(nx, ny, 1 - nx, 1 - ny)
                let edgeBand = 1 - smoothstep(0.02, 0.36, edgeDistance)

                let cornerDistance = min(
                    hypot(nx, ny),
                    hypot(1 - nx, ny),
                    hypot(nx, 1 - ny),
                    hypot(1 - nx, 1 - ny)
                )
                let cornerBloom = 1 - smoothstep(0.03, 0.42, cornerDistance)
                let leftShelf = 1 - smoothstep(0.08, 0.36, nx)
                let rightShelf = smoothstep(0.58, 0.96, nx)
                let topShelf = 1 - smoothstep(0.04, 0.28, ny)
                let lowerLeft = (1 - smoothstep(0.08, 0.52, hypot(nx - 0.12, ny - 0.78))) * 0.58

                let textureA = sin((nx * 7.0 + CGFloat(layer.seed) * 0.013) * layer.patternScale) * 0.5 + 0.5
                let textureB = sin((ny * 9.0 - nx * 2.4 + CGFloat(layer.seed) * 0.019) * layer.patternScale) * 0.5 + 0.5
                let texture = 0.72 + textureA * 0.16 + textureB * 0.14

                var density = edgeBand * 0.34 +
                    cornerBloom * 0.4 +
                    leftShelf * 0.16 +
                    rightShelf * 0.22 +
                    topShelf * 0.18 +
                    lowerLeft
                density = clamp(density * texture * densityBias, 0, 0.96)

                let ordered = bayer8(column, row)
                guard ordered <= density else { continue }

                let random = hash2(column, row, layer.seed)
                let jitter = (random - 0.5) * layer.pixelJitter * 0.35
                let cellSize = clamp(layer.pixelSize * (0.74 + jitter), 1.4, layer.pixelSize)
                let phase = (nx * 2.2 + ny * 1.4 + random * 0.18) * .pi
                let driftX = (hash2(column, row, layer.seed + 17) - 0.5) * layer.pixelSize * 0.42
                let driftY = (hash2(row, column, layer.seed + 29) - 0.5) * layer.pixelSize * 0.42
                let driftSpeed = 0.75 + hash2(row, column, layer.seed + 91) * 0.65
                let driftPhase = t * driftSpeed + phase
                let px = (x + sin(driftPhase) * driftX).rounded()
                let py = (y + cos(driftPhase * 0.86 + phase) * driftY).rounded()

                let edgeAlpha = layer.edgeFade > 0 ? smoothstep(0, layer.edgeFade, edgeDistance) : 1
                let alpha = clamp((0.2 + density * 0.82 + random * 0.04) * edgeAlpha * layer.opacity, 0, 1)
                guard alpha >= 0.025 else { continue }

                let rect = CGRect(x: px, y: py, width: cellSize, height: cellSize)
                context.fill(Path(rect), with: .color(layer.color.opacity(alpha)))

                if cellSize >= 3 {
                    let highlight = clamp(alpha * 0.42, 0, 0.34)
                    let shadow = clamp(alpha * 0.48, 0, 0.38)
                    context.fill(Path(CGRect(x: px, y: py, width: cellSize, height: 1)), with: .color(.white.opacity(highlight)))
                    context.fill(Path(CGRect(x: px, y: py, width: 1, height: cellSize)), with: .color(.white.opacity(highlight)))
                    context.fill(Path(CGRect(x: px, y: py + cellSize - 1, width: cellSize, height: 1)), with: .color(.black.opacity(shadow)))
                    context.fill(Path(CGRect(x: px + cellSize - 1, y: py, width: 1, height: cellSize)), with: .color(.black.opacity(shadow)))
                }
            }
        }
    }
}

private struct PixelLayer {
    let color: Color
    let pixelSize: CGFloat
    let patternScale: CGFloat
    let patternDensity: CGFloat
    let pixelJitter: CGFloat
    let edgeFade: CGFloat
    let speed: CGFloat
    let seed: Int
    let opacity: CGFloat
}

private struct GholaGlyph: View {
    let size: CGFloat

    var body: some View {
        ZStack {
            Circle()
                .fill(Theme.accent)
                .frame(width: size * 0.188, height: size * 0.188)
                .position(x: size * 0.5, y: size * 0.172)

            RoundedRectangle(cornerRadius: size * 0.039)
                .fill(Theme.accent)
                .frame(width: size * 0.469, height: size * 0.078)
                .position(x: size * 0.5, y: size * 0.352)

            RoundedRectangle(cornerRadius: size * 0.031)
                .fill(Theme.accent)
                .frame(width: size * 0.344, height: size * 0.063)
                .position(x: size * 0.5, y: size * 0.469)

            RoundedRectangle(cornerRadius: size * 0.028)
                .fill(Theme.accent.opacity(0.75))
                .frame(width: size * 0.125, height: size * 0.056)
                .position(x: size * 0.406, y: size * 0.575)

            RoundedRectangle(cornerRadius: size * 0.028)
                .fill(Theme.accent.opacity(0.75))
                .frame(width: size * 0.125, height: size * 0.056)
                .position(x: size * 0.594, y: size * 0.575)

            RoundedRectangle(cornerRadius: size * 0.023)
                .fill(Theme.accent.opacity(0.50))
                .frame(width: size * 0.094, height: size * 0.047)
                .position(x: size * 0.328, y: size * 0.680)

            RoundedRectangle(cornerRadius: size * 0.020)
                .fill(Theme.accent.opacity(0.45))
                .frame(width: size * 0.094, height: size * 0.041)
                .position(x: size * 0.500, y: size * 0.692)

            RoundedRectangle(cornerRadius: size * 0.020)
                .fill(Theme.accent.opacity(0.40))
                .frame(width: size * 0.078, height: size * 0.041)
                .position(x: size * 0.664, y: size * 0.660)

            particle(x: 0.313, y: 0.781, scale: 0.031, opacity: 0.30)
            particle(x: 0.500, y: 0.797, scale: 0.028, opacity: 0.25)
            particle(x: 0.656, y: 0.766, scale: 0.025, opacity: 0.20)
            particle(x: 0.406, y: 0.875, scale: 0.022, opacity: 0.20)
            particle(x: 0.578, y: 0.891, scale: 0.019, opacity: 0.20)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func particle(x: CGFloat, y: CGFloat, scale: CGFloat, opacity: CGFloat) -> some View {
        Circle()
            .fill(Theme.accent.opacity(opacity))
            .frame(width: size * scale * 2, height: size * scale * 2)
            .position(x: size * x, y: size * y)
    }
}

private let bayer8Matrix: [CGFloat] = [
    0, 48, 12, 60, 3, 51, 15, 63,
    32, 16, 44, 28, 35, 19, 47, 31,
    8, 56, 4, 52, 11, 59, 7, 55,
    40, 24, 36, 20, 43, 27, 39, 23,
    2, 50, 14, 62, 1, 49, 13, 61,
    34, 18, 46, 30, 33, 17, 45, 29,
    10, 58, 6, 54, 9, 57, 5, 53,
    42, 26, 38, 22, 41, 25, 37, 21,
]

private func bayer8(_ column: Int, _ row: Int) -> CGFloat {
    let x = positiveMod(column, 8)
    let y = positiveMod(row, 8)
    return (bayer8Matrix[y * 8 + x] + 0.5) / 64
}

private func positiveMod(_ value: Int, _ modulus: Int) -> Int {
    let remainder = value % modulus
    return remainder >= 0 ? remainder : remainder + modulus
}

private func hash2(_ x: Int, _ y: Int, _ seed: Int) -> CGFloat {
    let value = sin(Double(x) * 127.1 + Double(y) * 311.7 + Double(seed) * 74.7) * 43758.5453123
    return CGFloat(value - floor(value))
}

private func smoothstep(_ edge0: CGFloat, _ edge1: CGFloat, _ value: CGFloat) -> CGFloat {
    let range = max(edge1 - edge0, 0.0001)
    let t = clamp((value - edge0) / range, 0, 1)
    return t * t * (3 - 2 * t)
}

private func clamp(_ value: CGFloat, _ minValue: CGFloat, _ maxValue: CGFloat) -> CGFloat {
    min(maxValue, max(minValue, value))
}

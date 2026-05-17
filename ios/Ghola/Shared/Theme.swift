import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

enum Theme {
    // MARK: - Colors
    static let bg = Color(red: 0.025, green: 0.027, blue: 0.040)
    static let background = bg
    static let cardBg = Color(red: 0.074, green: 0.082, blue: 0.108)
    static let surface = cardBg
    static let surfaceElevated = Color(red: 0.105, green: 0.116, blue: 0.150)
    static let textPrimary = Color(red: 0.955, green: 0.965, blue: 0.985)
    static let textSecondary = Color(red: 0.650, green: 0.690, blue: 0.760)
    static let accent = Color(red: 0.090, green: 0.455, blue: 1.000)
    static let accentSoft = Color(red: 0.450, green: 0.690, blue: 1.000)
    static let accentCyan = Color(red: 0.260, green: 0.820, blue: 1.000)
    static let accentDeep = Color(red: 0.030, green: 0.235, blue: 0.650)
    static let callGreen = Color(red: 0.190, green: 0.760, blue: 0.490)
    static let emailBlue = Color(red: 0.300, green: 0.620, blue: 1.000)
    static let calendarOrange = Color(red: 1.000, green: 0.620, blue: 0.240)
    static let chatPurple = Color(red: 0.600, green: 0.500, blue: 1.000)
    static let success = Color(red: 0.180, green: 0.760, blue: 0.460)
    static let warning = Color(red: 1.000, green: 0.680, blue: 0.200)
    static let danger = Color(red: 1.000, green: 0.360, blue: 0.360)

    // MARK: - Spacing
    static let paddingSm: CGFloat = 8
    static let paddingMd: CGFloat = 16
    static let paddingLg: CGFloat = 24
    static let paddingXl: CGFloat = 32

    // MARK: - Corner Radius
    static let cornerSm: CGFloat = 8
    static let cornerMd: CGFloat = 12
    static let cornerLg: CGFloat = 16

    // MARK: - Font
    static let titleFont = Font.system(size: 28, weight: .bold, design: .rounded)
    static let headlineFont = Font.system(size: 20, weight: .semibold, design: .rounded)
    static let bodyFont = Font.system(size: 16, weight: .regular)
    static let captionFont = Font.system(size: 13, weight: .regular)

    // MARK: - Visual styles
    static let cardShadow = Color.black.opacity(0.20)
    static let cardBorder = Color.white.opacity(0.10)

    static let appBackgroundGradient = LinearGradient(
        colors: [
            Color(red: 0.030, green: 0.034, blue: 0.052),
            bg,
            Color(red: 0.018, green: 0.020, blue: 0.030)
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    static let accentGradient = LinearGradient(
        colors: [accentCyan, accent, accentDeep],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    static let brandTextGradient = LinearGradient(
        colors: [textPrimary, accentSoft, accentCyan],
        startPoint: .leading,
        endPoint: .trailing
    )

    static let surfaceGradient = LinearGradient(
        colors: [surfaceElevated, cardBg],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    static let brandSurfaceGradient = LinearGradient(
        colors: [surfaceElevated, cardBg],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    static let brandBandGradient = LinearGradient(
        colors: [
            Color(red: 0.110, green: 0.360, blue: 0.980),
            Color(red: 0.070, green: 0.180, blue: 0.720)
        ],
        startPoint: .leading,
        endPoint: .trailing
    )

    static let accentStrokeGradient = LinearGradient(
        colors: [
            accent.opacity(0.42),
            accentDeep.opacity(0.28),
            Color.white.opacity(0.08)
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
}

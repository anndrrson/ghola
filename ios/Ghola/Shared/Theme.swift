import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

enum Theme {
    // MARK: - Colors
    static let bg = Color(red: 0.000, green: 0.000, blue: 0.000)
    static let background = bg
    static let cardBg = Color(red: 0.055, green: 0.060, blue: 0.078)
    static let surface = cardBg
    static let surfaceElevated = Color(red: 0.086, green: 0.094, blue: 0.122)
    static let textPrimary = Color(red: 0.934, green: 0.945, blue: 0.972)
    static let textSecondary = Color(red: 0.545, green: 0.584, blue: 0.659)
    static let textTertiary = Color(red: 0.306, green: 0.337, blue: 0.408)
    static let border = Color(red: 0.118, green: 0.165, blue: 0.227)
    static let accent = Color(red: 0.240, green: 0.660, blue: 1.000)
    static let accentSoft = Color(red: 0.580, green: 0.790, blue: 1.000)
    static let accentCyan = Color(red: 0.320, green: 0.850, blue: 0.950)
    static let accentDeep = Color(red: 0.040, green: 0.215, blue: 0.520)
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
    static let displayFont = Font.system(size: 34, weight: .semibold, design: .default)
    static let titleFont = Font.system(size: 28, weight: .semibold, design: .default)
    static let headlineFont = Font.system(size: 20, weight: .semibold, design: .default)
    static let bodyFont = Font.system(size: 16, weight: .regular)
    static let captionFont = Font.system(size: 13, weight: .regular)
    static let monoFont = Font.system(size: 13, weight: .regular, design: .monospaced)
    static let eyebrowFont = Font.system(size: 12, weight: .semibold, design: .monospaced)

    // MARK: - Visual styles
    static let cardShadow = Color.black.opacity(0.20)
    static let cardBorder = border

    static let appBackgroundGradient = LinearGradient(
        colors: [
            bg,
            Color(red: 0.010, green: 0.012, blue: 0.017)
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

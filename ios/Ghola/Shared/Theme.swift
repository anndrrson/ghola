import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

enum Theme {
    // MARK: - Colors
    static let background = Color("Background", bundle: nil)
    static let surface = Color("Surface", bundle: nil)
    static let accent = Color.blue
    static let callGreen = Color.green
    static let emailBlue = Color.blue
    static let calendarOrange = Color.orange
    static let chatPurple = Color.purple

    // Fallback colors that work without asset catalog. Bridged from the
    // platform's semantic colors so both iOS (UIKit) and macOS (AppKit)
    // builds compile cleanly — UIColor is iOS-only.
    #if canImport(UIKit)
    static let bg = Color(uiColor: .systemBackground)
    static let cardBg = Color(uiColor: .secondarySystemBackground)
    static let textPrimary = Color(uiColor: .label)
    static let textSecondary = Color(uiColor: .secondaryLabel)
    #elseif canImport(AppKit)
    static let bg = Color(nsColor: .windowBackgroundColor)
    static let cardBg = Color(nsColor: .underPageBackgroundColor)
    static let textPrimary = Color(nsColor: .labelColor)
    static let textSecondary = Color(nsColor: .secondaryLabelColor)
    #else
    static let bg = Color.white
    static let cardBg = Color.gray.opacity(0.1)
    static let textPrimary = Color.black
    static let textSecondary = Color.gray
    #endif

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
}

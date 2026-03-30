import SwiftUI

enum Theme {
    // MARK: - Colors
    static let background = Color("Background", bundle: nil)
    static let surface = Color("Surface", bundle: nil)
    static let accent = Color.blue
    static let callGreen = Color.green
    static let emailBlue = Color.blue
    static let calendarOrange = Color.orange
    static let chatPurple = Color.purple

    // Fallback colors that work without asset catalog
    static let bg = Color(uiColor: .systemBackground)
    static let cardBg = Color(uiColor: .secondarySystemBackground)
    static let textPrimary = Color(uiColor: .label)
    static let textSecondary = Color(uiColor: .secondaryLabel)

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

import AppIntents

// MARK: - Make a Call

struct MakeCallIntent: AppIntent {
    static var title: LocalizedStringResource = "Make a Call"
    static var description = IntentDescription("Ask Ghola to make a phone call for you.")
    static var openAppWhenRun = true

    @Parameter(title: "What to call about")
    var objective: String

    @Parameter(title: "Phone number")
    var phoneNumber: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard await CloudClient.shared.isAuthenticated else {
            return .result(dialog: "Please open Ghola and sign in first.")
        }

        return .result(dialog: "Open Ghola to review exactly what leaves the device before this call starts.")
    }
}

// MARK: - Send an Email

struct SendEmailIntent: AppIntent {
    static var title: LocalizedStringResource = "Send an Email"
    static var description = IntentDescription("Ask Ghola to draft and send an email.")
    static var openAppWhenRun = true

    @Parameter(title: "What to email about")
    var intent: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard await CloudClient.shared.isAuthenticated else {
            return .result(dialog: "Please open Ghola and sign in first.")
        }

        return .result(dialog: "Open Ghola to review exactly what leaves the device before this email is drafted.")
    }
}

// MARK: - Shortcuts Provider

struct GholaShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: MakeCallIntent(),
            phrases: [
                "Ask \(.applicationName) to make a call",
                "In \(.applicationName), start a call",
            ],
            shortTitle: "Make a Call",
            systemImageName: "phone.fill"
        )

        AppShortcut(
            intent: SendEmailIntent(),
            phrases: [
                "Ask \(.applicationName) to send an email",
                "In \(.applicationName), start an email",
            ],
            shortTitle: "Send Email",
            systemImageName: "envelope.fill"
        )
    }
}

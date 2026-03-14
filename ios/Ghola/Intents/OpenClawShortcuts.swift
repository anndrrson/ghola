import AppIntents

// MARK: - Make a Call

struct MakeCallIntent: AppIntent {
    static var title: LocalizedStringResource = "Make a Call"
    static var description = IntentDescription("Ask Ghola to make a phone call for you.")
    static var openAppWhenRun = true

    @Parameter(title: "What to call about")
    var objective: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard await CloudClient.shared.isAuthenticated else {
            return .result(dialog: "Please open Ghola and sign in first.")
        }

        let task = try await CloudClient.shared.createTask(
            type: "call",
            templateId: nil,
            params: ["objective": objective]
        )

        return .result(dialog: "Got it! I'm setting up that call. Check Ghola for updates.")
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

        let task = try await CloudClient.shared.createTask(
            type: "email",
            templateId: nil,
            params: ["intent": intent]
        )

        return .result(dialog: "I'll draft that email for you. Check Ghola to review and send it.")
    }
}

// MARK: - Shortcuts Provider

struct GholaShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: MakeCallIntent(),
            phrases: [
                "Ghola call \(\.$objective)",
                "Have Ghola call about \(\.$objective)",
            ],
            shortTitle: "Make a Call",
            systemImageName: "phone.fill"
        )

        AppShortcut(
            intent: SendEmailIntent(),
            phrases: [
                "Ghola email about \(\.$intent)",
                "Have Ghola send an email about \(\.$intent)",
            ],
            shortTitle: "Send Email",
            systemImageName: "envelope.fill"
        )
    }
}

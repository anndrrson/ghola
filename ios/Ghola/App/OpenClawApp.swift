import SwiftUI

@main
struct GholaApp: App {
    @StateObject private var auth = AuthManager.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(auth)
        }

        #if os(macOS)
        MenuBarExtra("Ghola", systemImage: "brain.head.profile") {
            MenuBarView()
                .environmentObject(auth)
        }
        .menuBarExtraStyle(.window)
        #endif
    }
}

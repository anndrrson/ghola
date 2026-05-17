import SwiftUI

@main
struct GholaApp: App {
    @StateObject private var auth = AuthManager.shared
    #if os(macOS)
    @StateObject private var serverManager = ServerManager()
    @StateObject private var ollamaManager = OllamaManager()
    @StateObject private var bonjourAdvertiser = BonjourAdvertiser()
    #endif

    var body: some Scene {
        WindowGroup {
            #if os(macOS)
            if !UserDefaults.standard.bool(forKey: "setup_complete") {
                SetupView()
                    .environmentObject(serverManager)
                    .environmentObject(ollamaManager)
            } else {
                HomeStatusView()
                    .environmentObject(serverManager)
                    .environmentObject(ollamaManager)
            }
            #else
            ContentView()
                .environmentObject(auth)
                .tint(Theme.accent)
                .preferredColorScheme(.dark)
            #endif
        }

        #if os(macOS)
        MenuBarExtra("Ghola", systemImage: "brain.head.profile") {
            MenuBarView()
                .environmentObject(serverManager)
                .environmentObject(ollamaManager)
                .environmentObject(bonjourAdvertiser)
        }
        .menuBarExtraStyle(.window)
        #endif
    }
}

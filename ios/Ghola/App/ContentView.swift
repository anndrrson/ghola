import SwiftUI

struct ContentView: View {
    @EnvironmentObject var auth: AuthManager
    @State private var selectedTab = 1 // Chat is default

    var body: some View {
        if auth.isAuthenticated {
            #if os(iOS)
            TabView(selection: $selectedTab) {
                Tab("Home", systemImage: "house.fill", value: 0) {
                    HomeView()
                }
                Tab("Chat", systemImage: "bubble.left.and.bubble.right.fill", value: 1) {
                    ChatView()
                }
                Tab("Settings", systemImage: "gearshape.fill", value: 2) {
                    SettingsView()
                }
            }
            .tint(Theme.accent)
            #elseif os(macOS)
            NavigationSplitView {
                List(selection: $selectedTab) {
                    Label("Home", systemImage: "house.fill").tag(0)
                    Label("Chat", systemImage: "bubble.left.and.bubble.right.fill").tag(1)
                    Label("Settings", systemImage: "gearshape.fill").tag(2)
                }
                .navigationTitle("Ghola")
            } detail: {
                switch selectedTab {
                case 0: HomeView()
                case 2: SettingsView()
                default: ChatView()
                }
            }
            #endif
        } else {
            OnboardingView()
        }
    }
}

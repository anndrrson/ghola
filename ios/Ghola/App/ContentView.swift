import SwiftUI

struct ContentView: View {
    @EnvironmentObject var auth: AuthManager
    @State private var selectedTab = 1 // Chat is default
    #if os(iOS)
    @StateObject private var localBrowser = LocalServerBrowser()
    @State private var showLocalConnect = false
    #endif

    var body: some View {
        if auth.isAuthenticated || CloudClient.isLocalMode {
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
            #if os(iOS)
            OnboardingView()
                .overlay(alignment: .top) {
                    if !localBrowser.discoveredServers.isEmpty {
                        localServerBanner
                    }
                }
                .onAppear { localBrowser.startBrowsing() }
                .onDisappear { localBrowser.stopBrowsing() }
                .sheet(isPresented: $showLocalConnect) {
                    NavigationStack {
                        LocalServerConnectView()
                            .navigationBarTitleDisplayMode(.inline)
                            .toolbar {
                                ToolbarItem(placement: .cancellationAction) {
                                    Button("Cancel") { showLocalConnect = false }
                                }
                            }
                    }
                }
            #else
            OnboardingView()
            #endif
        }
    }

    #if os(iOS)
    private var localServerBanner: some View {
        Button {
            showLocalConnect = true
        } label: {
            HStack {
                Image(systemName: "desktopcomputer")
                Text("Ghola Home server found on your network")
                    .font(.callout)
                Spacer()
                Text("Connect")
                    .fontWeight(.semibold)
            }
            .padding()
            .background(.ultraThinMaterial)
            .cornerRadius(12)
            .padding()
        }
        .buttonStyle(.plain)
    }
    #endif
}

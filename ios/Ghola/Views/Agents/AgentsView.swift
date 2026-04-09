import SwiftUI

/// Phase M10 stub — iOS list view for the user's owned agents.
///
/// Degraded feature set vs. Android:
/// - No device control (iOS doesn't allow accessibility-service-level automation)
/// - No MWA / Seed Vault (Android-only; iOS uses Phantom deep-links instead)
/// - No FCM (use APNS once Apple Dev unblocks)
///
/// What it DOES share with Android:
/// - Same said-cloud backend, same agents, same wallets, same reputation.
/// - A user signed in on Android and iOS sees the same owned agents.
struct AgentsView: View {
    @State private var agents: [Agent] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showCreate = false

    private let client: SaidCloudClient

    init(client: SaidCloudClient) {
        self.client = client
    }

    var body: some View {
        NavigationStack {
            Group {
                if isLoading && agents.isEmpty {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if agents.isEmpty {
                    VStack(spacing: 16) {
                        Image(systemName: "sparkles")
                            .font(.system(size: 48))
                            .foregroundStyle(.tint)
                        Text("No agents yet")
                            .font(.title2.bold())
                        Text("Create your first AI agent. We'll generate its DID, provision a Solana wallet, and you're live.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                        Button("Create agent") { showCreate = true }
                            .buttonStyle(.borderedProminent)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(agents) { agent in
                        NavigationLink {
                            AgentDetailView(agentId: agent.id, client: client)
                        } label: {
                            AgentRow(agent: agent)
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("My Agents")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showCreate = true
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .sheet(isPresented: $showCreate) {
                CreateAgentView(client: client) { created in
                    agents.insert(created, at: 0)
                    showCreate = false
                }
            }
            .alert("Error", isPresented: .constant(errorMessage != nil)) {
                Button("OK") { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "")
            }
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            agents = try await client.listAgents()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct AgentRow: View {
    let agent: Agent

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(agent.display_name)
                    .font(.headline)
                Spacer()
                Text(agent.status)
                    .font(.caption)
                    .foregroundStyle(statusColor)
            }
            Text("@\(agent.slug)")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let bio = agent.bio, !bio.isEmpty {
                Text(bio)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .padding(.top, 2)
            }
            Text(truncatedDid(agent.did))
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.tertiary)
                .padding(.top, 4)
        }
        .padding(.vertical, 4)
    }

    private var statusColor: Color {
        switch agent.status {
        case "active": return .green
        case "paused": return .yellow
        default: return .secondary
        }
    }

    private func truncatedDid(_ did: String) -> String {
        guard did.count > 24 else { return did }
        return "\(did.prefix(16))…\(did.suffix(6))"
    }
}

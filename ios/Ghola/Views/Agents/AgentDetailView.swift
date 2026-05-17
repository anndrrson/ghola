import SwiftUI

/// Phase M10 stub — drill-down detail view for a single owned agent.
struct AgentDetailView: View {
    let agentId: String
    let client: SaidCloudClient

    @State private var detail: AgentDetail?
    @State private var earnings: AgentEarnings?
    @State private var reputation: AgentReputation?
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let d = detail {
                    Text(d.display_name)
                        .font(.largeTitle.bold())
                    Text("@\(d.slug)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if let bio = d.bio, !bio.isEmpty {
                        Text(bio)
                            .font(.body)
                            .padding(.top, 4)
                    }

                    identityCard(did: d.did, address: d.solana_address)

                    statsGrid
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding()
                }
            }
            .padding()
        }
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .alert("Error", isPresented: .constant(errorMessage != nil)) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    @ViewBuilder
    private func identityCard(did: String, address: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("CRYPTOGRAPHIC IDENTITY")
                .font(.caption.bold())
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 4) {
                Text("DID")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(did)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("SOLANA ADDRESS")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(address)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color(.separator), lineWidth: 0.5)
        )
    }

    @ViewBuilder
    private var statsGrid: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
            statTile(label: "BALANCE", value: formatUsdc(earnings?.net_micro_usdc ?? 0))
            statTile(label: "SERVICES", value: "\(detail?.service_count ?? 0)")
            statTile(
                label: "REPUTATION",
                value: (reputation?.overall_score ?? 0) > 0
                    ? String(format: "%.2f", reputation?.overall_score ?? 0)
                    : "—"
            )
            statTile(label: "EARNED", value: formatUsdc(earnings?.total_received_micro_usdc ?? 0))
        }
    }

    @ViewBuilder
    private func statTile(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption2.bold())
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title2.bold())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color(.separator), lineWidth: 0.5)
        )
    }

    private func formatUsdc(_ micro: Int64) -> String {
        let usdc = Double(micro) / 1_000_000.0
        if usdc < 0.01 && usdc > 0 {
            return String(format: "$%.4f", usdc)
        }
        return String(format: "$%.2f", usdc)
    }

    private func load() async {
        do {
            async let d = client.getAgent(id: agentId)
            async let e = client.getAgentEarnings(id: agentId)
            async let r = client.getAgentReputation(id: agentId)
            detail = try await d
            earnings = try? await e
            reputation = try? await r
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

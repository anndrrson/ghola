import SwiftUI

/// Phase M10 stub — SwiftUI creation wizard. Parallel to Android's
/// CreateAgentActivity. Auto-derives slug from display name; posts to
/// /v1/agents which generates the ed25519 keypair server-side.
struct CreateAgentView: View {
    let client: SaidCloudClient
    let onCreated: (Agent) -> Void

    @State private var displayName: String = ""
    @State private var slug: String = ""
    @State private var slugTouched = false
    @State private var bio: String = ""
    @State private var submitting = false
    @State private var errorMessage: String?

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Display name", text: $displayName)
                        .textInputAutocapitalization(.words)
                        .onChange(of: displayName) { _, new in
                            if !slugTouched {
                                slug = slugify(new)
                            }
                        }
                    TextField("Slug", text: $slug)
                        .font(.system(.body, design: .monospaced))
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .onChange(of: slug) { _, _ in slugTouched = true }
                    TextField("Bio (optional)", text: $bio, axis: .vertical)
                        .lineLimit(3)
                }

                if let err = errorMessage {
                    Section {
                        Text(err)
                            .foregroundStyle(.red)
                            .font(.callout)
                    }
                }

                Section {
                    Text("We'll generate a fresh ed25519 keypair, derive your agent's DID, and provision a dedicated Solana wallet — all in one tap.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("New agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await submit() }
                    } label: {
                        if submitting {
                            ProgressView()
                        } else {
                            Text("Create")
                        }
                    }
                    .disabled(submitting || displayName.isEmpty || slug.isEmpty)
                }
            }
        }
    }

    private func submit() async {
        errorMessage = nil
        submitting = true
        defer { submitting = false }

        guard slug.range(of: "^[a-zA-Z0-9_-]+$", options: .regularExpression) != nil else {
            errorMessage = "Slug can only contain letters, digits, '-', and '_'"
            return
        }

        do {
            let agent = try await client.createAgent(
                slug: slug,
                displayName: displayName,
                bio: bio.isEmpty ? nil : bio
            )
            onCreated(agent)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func slugify(_ input: String) -> String {
        let lower = input.lowercased()
        var out = ""
        for ch in lower {
            if ch.isLetter || ch.isNumber || ch == "-" || ch == "_" {
                out.append(ch)
            } else if ch == " " || ch == "\t" {
                if !out.hasSuffix("-") { out.append("-") }
            }
        }
        return String(out.prefix(64))
    }
}

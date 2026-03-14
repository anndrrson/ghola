import SwiftUI

struct ModelPickerView: View {
    @State private var providers: [ProviderInfo] = []
    @State private var selectedProvider = "anthropic"
    @State private var selectedModel = ""
    @State private var apiKey = ""
    @State private var isSaving = false
    @State private var savedMessage = ""
    @State private var currentConfig: LlmConfigResponse?

    var body: some View {
        Form {
            Section("Provider") {
                Picker("Provider", selection: $selectedProvider) {
                    ForEach(providers) { provider in
                        Text(provider.name).tag(provider.id)
                    }
                }
                .onChange(of: selectedProvider) {
                    // Reset model to first available for this provider
                    if let provider = providers.first(where: { $0.id == selectedProvider }),
                       let first = provider.models.first {
                        selectedModel = first
                    }
                }
            }

            Section("Model") {
                let models = providers.first(where: { $0.id == selectedProvider })?.models ?? []
                Picker("Model", selection: $selectedModel) {
                    ForEach(models, id: \.self) { model in
                        Text(model).tag(model)
                    }
                }
            }

            let requiresKey = providers.first(where: { $0.id == selectedProvider })?.requiresApiKey ?? true
            if requiresKey {
                Section(header: Text("API Key"), footer: Text("Your key is encrypted and stored securely on the server.")) {
                    SecureField("Enter API key", text: $apiKey)
                        .textContentType(.password)
                        #if os(iOS)
                        .autocapitalization(.none)
                        #endif

                    if let config = currentConfig, config.hasApiKey {
                        Text("Key is set")
                            .font(Theme.captionFont)
                            .foregroundStyle(.green)
                    }
                }
            }

            Section {
                Button {
                    save()
                } label: {
                    HStack {
                        Spacer()
                        if isSaving {
                            ProgressView()
                        } else {
                            Text("Save")
                        }
                        Spacer()
                    }
                }
                .disabled(isSaving)

                if !savedMessage.isEmpty {
                    Text(savedMessage)
                        .font(Theme.captionFont)
                        .foregroundStyle(.green)
                }
            }
        }
        .navigationTitle("AI Model")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task {
            await loadConfig()
        }
    }

    private func loadConfig() async {
        do {
            async let providersFetch = CloudClient.shared.listProviders()
            async let configFetch = CloudClient.shared.getLlmConfig()

            providers = try await providersFetch
            let config = try await configFetch
            currentConfig = config
            selectedProvider = config.provider
            selectedModel = config.model
        } catch {
            // Fallback
        }
    }

    private func save() {
        isSaving = true
        savedMessage = ""

        Task {
            do {
                var update = UpdateLlmConfigRequest()
                update.provider = selectedProvider
                update.model = selectedModel
                if !apiKey.isEmpty {
                    update.apiKey = apiKey
                }

                let config = try await CloudClient.shared.updateLlmConfig(update)
                currentConfig = config
                apiKey = ""
                savedMessage = "Saved"
            } catch {
                savedMessage = error.localizedDescription
            }
            isSaving = false
        }
    }
}

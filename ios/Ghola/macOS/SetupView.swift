#if os(macOS)
import SwiftUI

struct SetupView: View {
    @EnvironmentObject var serverManager: ServerManager
    @EnvironmentObject var ollamaManager: OllamaManager

    @State private var currentStep = 0
    @State private var errorMessage: String?
    @State private var isWorking = false

    var body: some View {
        VStack(spacing: 0) {
            // Progress indicator
            HStack(spacing: 4) {
                ForEach(0..<4, id: \.self) { step in
                    Capsule()
                        .fill(step <= currentStep ? Color.accentColor : Color.secondary.opacity(0.3))
                        .frame(height: 4)
                }
            }
            .padding(.horizontal, 40)
            .padding(.top, 24)

            Spacer()

            switch currentStep {
            case 0: welcomeStep
            case 1: installingStep
            case 2: modelStep
            case 3: readyStep
            default: readyStep
            }

            Spacer()

            if let error = errorMessage {
                Text(error)
                    .foregroundStyle(.red)
                    .font(.caption)
                    .padding(.horizontal)
            }
        }
        .frame(width: 500, height: 420)
        .task {
            await ollamaManager.checkStatus()
        }
    }

    // MARK: - Step 0: Welcome

    private var welcomeStep: some View {
        VStack(spacing: 20) {
            Image(systemName: "brain.head.profile")
                .font(.system(size: 64))
                .foregroundStyle(.accent)

            Text("Welcome to Ghola Home")
                .font(.largeTitle)
                .fontWeight(.bold)

            Text("Private AI that runs entirely on your Mac.\nNo cloud. No subscriptions. No data leaves your network.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)

            Button("Get Started") {
                if ollamaManager.isInstalled() {
                    // Skip install, go to model step
                    currentStep = 2
                    Task { await startOllamaAndPull() }
                } else {
                    currentStep = 1
                    Task { await installOllama() }
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
    }

    // MARK: - Step 1: Installing Ollama

    private var installingStep: some View {
        VStack(spacing: 20) {
            Image(systemName: "arrow.down.circle")
                .font(.system(size: 48))
                .foregroundStyle(.accent)

            Text("Installing AI Engine")
                .font(.title)
                .fontWeight(.semibold)

            ProgressView()
                .scaleEffect(1.5)

            Text("Downloading Ollama...")
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Step 2: Pulling Model

    private var modelStep: some View {
        VStack(spacing: 20) {
            Image(systemName: "cpu")
                .font(.system(size: 48))
                .foregroundStyle(.accent)

            Text("Downloading AI Model")
                .font(.title)
                .fontWeight(.semibold)

            VStack(spacing: 8) {
                ProgressView(value: ollamaManager.pullProgress)
                    .frame(width: 300)

                Text(ollamaManager.pullStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Text("\(ollamaManager.recommendedModel) (\(ollamaManager.recommendedModelSize))")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    // MARK: - Step 3: Ready

    private var readyStep: some View {
        VStack(spacing: 20) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 64))
                .foregroundStyle(.green)

            Text("Ready!")
                .font(.largeTitle)
                .fontWeight(.bold)

            Text("Your PIN")
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack(spacing: 12) {
                ForEach(Array(serverManager.pin), id: \.self) { digit in
                    Text(String(digit))
                        .font(.system(size: 36, weight: .bold, design: .monospaced))
                        .frame(width: 50, height: 60)
                        .background(Color.secondary.opacity(0.1))
                        .cornerRadius(10)
                }
            }

            Text("Open Ghola on your iPhone and enter this PIN to connect.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .font(.callout)

            Button("Copy PIN") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(serverManager.pin, forType: .string)
            }
            .buttonStyle(.bordered)

            Button("Done") {
                UserDefaults.standard.set(true, forKey: "setup_complete")
                // The app body will re-evaluate and show HomeStatusView
            }
            .buttonStyle(.borderedProminent)
        }
    }

    // MARK: - Actions

    private func installOllama() async {
        errorMessage = nil
        do {
            try await ollamaManager.install()
            currentStep = 2
            await startOllamaAndPull()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func startOllamaAndPull() async {
        errorMessage = nil
        do {
            try await ollamaManager.ensureRunning()

            // Check if recommended model is already installed
            await ollamaManager.refreshModels()
            let model = ollamaManager.recommendedModel

            if ollamaManager.installedModels.contains(where: { $0.hasPrefix(model) }) {
                // Model already present, skip download
                currentStep = 3
                serverManager.start()
                return
            }

            try await ollamaManager.pullModel(name: model)
            currentStep = 3
            serverManager.start()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
#endif

#if os(macOS)
import SwiftUI
import Combine

enum ServerStatus: String {
    case stopped = "Stopped"
    case starting = "Starting..."
    case running = "Running"
    case error = "Error"
}

@MainActor
class ServerManager: ObservableObject {
    @Published var status: ServerStatus = .stopped
    @Published var pin: String = ""

    private var process: Process?
    private var retryCount = 0
    private let maxRetries = 3
    private var healthTimer: Timer?

    var binaryPath: URL? {
        Bundle.main.resourceURL?.appendingPathComponent("ghola-home")
    }

    func start() {
        guard status != .running && status != .starting else { return }

        status = .starting

        // Generate PIN
        pin = String(format: "%04d", Int.random(in: 1000...9999))

        // Ensure ~/.ghola/ exists
        let gholaDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".ghola")
        try? FileManager.default.createDirectory(at: gholaDir, withIntermediateDirectories: true)

        let dbPath = gholaDir.appendingPathComponent("ghola.db").path

        guard let binary = binaryPath, FileManager.default.fileExists(atPath: binary.path) else {
            status = .error
            return
        }

        let proc = Process()
        proc.executableURL = binary
        proc.environment = [
            "GHOLA_HOME_DB": dbPath,
            "GHOLA_HOME_PIN": pin,
            "GHOLA_HOME_BIND": "0.0.0.0:3000",
            "GHOLA_HOME_NAME": Host.current().localizedName ?? "Ghola Home",
            "RUST_LOG": "ghola_home=info",
        ]

        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe

        // Watch for output to detect "listening on"
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let output = String(data: data, encoding: .utf8) else { return }

            if output.lowercased().contains("listening on") {
                Task { @MainActor [weak self] in
                    self?.status = .running
                    self?.startHealthPolling()
                }
            }
        }

        proc.terminationHandler = { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.healthTimer?.invalidate()
                if self.retryCount < self.maxRetries && self.status != .stopped {
                    self.retryCount += 1
                    self.start()
                } else {
                    self.status = .stopped
                }
            }
        }

        do {
            try proc.run()
            process = proc
        } catch {
            status = .error
        }
    }

    func stop() {
        status = .stopped
        retryCount = maxRetries // prevent auto-restart
        healthTimer?.invalidate()
        process?.terminate()
        process = nil
    }

    func restart() {
        retryCount = 0
        stop()
        // Small delay before restarting
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.start()
        }
    }

    private func startHealthPolling() {
        healthTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            Task { [weak self] in
                guard let self else { return }
                let healthy = await self.checkHealth()
                await MainActor.run {
                    if !healthy && self.status == .running {
                        self.status = .error
                    } else if healthy && self.status == .error {
                        self.status = .running
                    }
                }
            }
        }
    }

    private func checkHealth() async -> Bool {
        guard let url = URL(string: "http://localhost:3000/health") else { return false }
        do {
            let (_, response) = try await URLSession.shared.data(from: url)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    deinit {
        process?.terminate()
        healthTimer?.invalidate()
    }
}
#endif

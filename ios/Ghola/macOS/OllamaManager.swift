#if os(macOS)
import SwiftUI
import Combine

enum OllamaStatus: String {
    case notInstalled = "Not Installed"
    case installing = "Installing..."
    case notRunning = "Not Running"
    case running = "Running"
    case pullingModel = "Downloading Model..."
}

@MainActor
class OllamaManager: ObservableObject {
    @Published var status: OllamaStatus = .notInstalled
    @Published var installedModels: [String] = []
    @Published var pullProgress: Double = 0
    @Published var pullStatus: String = ""

    func checkStatus() async {
        if !isInstalled() {
            status = .notInstalled
            return
        }

        if await isRunning() {
            status = .running
            await refreshModels()
        } else {
            status = .notRunning
        }
    }

    func isInstalled() -> Bool {
        FileManager.default.fileExists(atPath: "/Applications/Ollama.app")
    }

    func isRunning() async -> Bool {
        guard let url = URL(string: "http://localhost:11434/api/tags") else { return false }
        do {
            let (_, response) = try await URLSession.shared.data(from: url)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    func install() async throws {
        status = .installing

        // Download Ollama
        guard let url = URL(string: "https://ollama.com/download/Ollama-darwin.zip") else {
            throw OllamaError.downloadFailed
        }

        let (fileURL, _) = try await URLSession.shared.download(from: url)

        // Unzip to /Applications
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        process.arguments = ["-xk", fileURL.path, "/Applications/"]
        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            throw OllamaError.installFailed
        }

        // Remove quarantine attribute
        let xattr = Process()
        xattr.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
        xattr.arguments = ["-dr", "com.apple.quarantine", "/Applications/Ollama.app"]
        try? xattr.run()
        xattr.waitUntilExit()

        status = .notRunning
    }

    func ensureRunning() async throws {
        guard isInstalled() else { throw OllamaError.notInstalled }

        if await isRunning() {
            status = .running
            return
        }

        // Launch Ollama.app
        let url = URL(fileURLWithPath: "/Applications/Ollama.app")
        NSWorkspace.shared.openApplication(at: url, configuration: .init())

        // Wait for it to start (up to 30 seconds)
        for _ in 0..<30 {
            try await Task.sleep(nanoseconds: 1_000_000_000)
            if await isRunning() {
                status = .running
                return
            }
        }

        throw OllamaError.startTimeout
    }

    func refreshModels() async {
        guard let url = URL(string: "http://localhost:11434/api/tags") else { return }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let models = json["models"] as? [[String: Any]] {
                installedModels = models.compactMap { $0["name"] as? String }
            }
        } catch { }
    }

    func pullModel(name: String) async throws {
        status = .pullingModel
        pullProgress = 0
        pullStatus = "Starting download..."

        guard let url = URL(string: "http://localhost:11434/api/pull") else {
            throw OllamaError.downloadFailed
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["name": name])

        let (bytes, _) = try await URLSession.shared.bytes(for: request)
        var buffer = ""

        for try await byte in bytes {
            let char = Character(UnicodeScalar(byte))
            buffer.append(char)

            if char == "\n" {
                if let data = buffer.data(using: .utf8),
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {

                    if let status = json["status"] as? String {
                        pullStatus = status
                    }

                    if let total = json["total"] as? Double, total > 0,
                       let completed = json["completed"] as? Double {
                        pullProgress = completed / total
                    }
                }
                buffer = ""
            }
        }

        pullProgress = 1.0
        pullStatus = "Complete"
        status = .running
        await refreshModels()
    }

    /// Recommend a model based on available RAM.
    var recommendedModel: String {
        let ram = ProcessInfo.processInfo.physicalMemory
        let gbRam = ram / (1024 * 1024 * 1024)
        return gbRam >= 16 ? "llama3.1" : "llama3.2"
    }

    var recommendedModelSize: String {
        let ram = ProcessInfo.processInfo.physicalMemory
        let gbRam = ram / (1024 * 1024 * 1024)
        return gbRam >= 16 ? "~4.7 GB" : "~2.0 GB"
    }
}

enum OllamaError: LocalizedError {
    case notInstalled
    case downloadFailed
    case installFailed
    case startTimeout

    var errorDescription: String? {
        switch self {
        case .notInstalled: return "Ollama is not installed"
        case .downloadFailed: return "Failed to download Ollama"
        case .installFailed: return "Failed to install Ollama"
        case .startTimeout: return "Ollama failed to start within 30 seconds"
        }
    }
}
#endif

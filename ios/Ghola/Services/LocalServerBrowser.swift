#if os(iOS)
import Network
import SwiftUI

struct LocalServer: Identifiable, Hashable {
    let id = UUID()
    let name: String
    let host: String
    let port: UInt16
    let models: [String]

    var baseURL: String {
        "http://\(host):\(port)"
    }
}

@MainActor
class LocalServerBrowser: ObservableObject {
    @Published var discoveredServers: [LocalServer] = []

    private var browser: NWBrowser?
    private var connections: [NWConnection] = []

    func startBrowsing() {
        stopBrowsing()

        let params = NWParameters()
        params.includePeerToPeer = true

        browser = NWBrowser(for: .bonjour(type: "_ghola._tcp.", domain: nil), using: params)

        browser?.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor [weak self] in
                self?.handleResults(results)
            }
        }

        browser?.start(queue: .main)
    }

    func stopBrowsing() {
        browser?.cancel()
        browser = nil
        connections.forEach { $0.cancel() }
        connections.removeAll()
    }

    private func handleResults(_ results: Set<NWBrowser.Result>) {
        var servers: [LocalServer] = []

        for result in results {
            if case .service(let name, _, _, _) = result.endpoint {
                // Resolve the endpoint to get IP/port
                let connection = NWConnection(to: result.endpoint, using: .tcp)
                connections.append(connection)

                connection.stateUpdateHandler = { [weak self] state in
                    if case .ready = state {
                        if let path = connection.currentPath,
                           let endpoint = path.remoteEndpoint,
                           case .hostPort(let host, let port) = endpoint {

                            // Parse TXT record for metadata
                            var models: [String] = []
                            if case .bonjour(let txt) = result.metadata {
                                if let modelsStr = txt.dictionary["models"] {
                                    models = modelsStr.split(separator: ",").map(String.init)
                                }
                            }

                            let server = LocalServer(
                                name: name,
                                host: "\(host)",
                                port: port.rawValue,
                                models: models
                            )

                            Task { @MainActor [weak self] in
                                if let self, !self.discoveredServers.contains(where: { $0.name == name }) {
                                    self.discoveredServers.append(server)
                                }
                            }
                        }
                        connection.cancel()
                    }
                }

                connection.start(queue: .main)
            }
        }
    }
}
#endif

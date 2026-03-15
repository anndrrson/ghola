#if os(macOS)
import Network
import SwiftUI

@MainActor
class BonjourAdvertiser: ObservableObject {
    @Published var isAdvertising = false

    private var listener: NWListener?

    func start(serverName: String, port: UInt16 = 3000, models: [String] = []) {
        stop()

        do {
            let params = NWParameters.tcp
            listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)

            let txtRecord = NWTXTRecord([
                "name": serverName,
                "version": "1.0",
                "models": models.joined(separator: ","),
                "pin_required": "true",
            ])

            listener?.service = NWListener.Service(
                name: serverName,
                type: "_ghola._tcp.",
                txtRecord: txtRecord
            )

            listener?.stateUpdateHandler = { [weak self] state in
                Task { @MainActor [weak self] in
                    switch state {
                    case .ready:
                        self?.isAdvertising = true
                    case .failed, .cancelled:
                        self?.isAdvertising = false
                    default:
                        break
                    }
                }
            }

            // We don't actually accept connections on this listener —
            // it's just for Bonjour advertisement. The real server is ghola-home.
            listener?.newConnectionHandler = { connection in
                connection.cancel()
            }

            listener?.start(queue: .main)
        } catch {
            isAdvertising = false
        }
    }

    func updateTXTRecord(models: [String]) {
        guard let listener else { return }
        let txtRecord = NWTXTRecord([
            "name": listener.service?.name ?? "Ghola Home",
            "version": "1.0",
            "models": models.joined(separator: ","),
            "pin_required": "true",
        ])
        listener.service = NWListener.Service(
            name: listener.service?.name ?? "Ghola Home",
            type: "_ghola._tcp.",
            txtRecord: txtRecord
        )
    }

    func stop() {
        listener?.cancel()
        listener = nil
        isAdvertising = false
    }
}
#endif

import Foundation

enum PrivatePaymentSigner {
    static let defaultMode: PrivatePaymentSigningMode = .aleoDevice

    static var status: PrivateSignerStatus {
        return PrivateSignerStatus(
            ready: false,
            signingMode: defaultMode,
            signerKeyID: nil,
            unavailableReason: "Device-held Aleo USDCx signing is not configured in this build."
        )
    }

    static func authorizeUSDCxTransfer(
        intent: PrivateTransferIntentResponse,
        recipientAddress: String
    ) async throws -> (proof: ShieldedPaymentProof, signerAttestation: String?) {
        _ = intent
        _ = recipientAddress
        throw CloudError.privacyBlocked(
            "Private USDCx signing is blocked until the user-held Aleo/Turnkey signer is configured."
        )
    }
}

import CryptoKit
import Foundation

struct PrivateUSDCxSignerAttestation: Codable, Equatable {
    static let version = "ghola-private-usdcx-signer-v1"

    let version: String
    let intentID: UUID
    let signingMode: String
    let signerKeyID: String
    let recipientHash: String
    let amountMicroUSDC: Int64
    let network: String
    let asset: String
    let policyHash: String
    let proofDigest: String
    let receiptRef: String
    let signedAt: String
    let signatureBase64: String

    enum CodingKeys: String, CodingKey {
        case version
        case intentID = "intent_id"
        case signingMode = "signing_mode"
        case signerKeyID = "signer_key_id"
        case recipientHash = "recipient_hash"
        case amountMicroUSDC = "amount_micro_usdc"
        case network
        case asset
        case policyHash = "policy_hash"
        case proofDigest = "proof_digest"
        case receiptRef = "receipt_ref"
        case signedAt = "signed_at"
        case signatureBase64 = "signature_b64"
    }
}

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

    static func didKey(fromEd25519PublicKey publicKey: Data) -> String {
        var data = Data([0xed, 0x01])
        data.append(publicKey)
        return "did:key:z\(PrivatePaymentBase58.encode(data))"
    }

    static func attestationTimestamp(for date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ssXXXXX"
        return formatter.string(from: date).replacingOccurrences(of: "Z", with: "+00:00")
    }

    static func signerAttestationPayload(_ attestation: PrivateUSDCxSignerAttestation) -> Data {
        let payload = [
            PrivateUSDCxSignerAttestation.version,
            "intent_id:\(attestation.intentID.uuidString.lowercased())",
            "signing_mode:\(attestation.signingMode)",
            "signer_key_id:\(attestation.signerKeyID)",
            "recipient_hash:\(attestation.recipientHash)",
            "amount_micro_usdc:\(attestation.amountMicroUSDC)",
            "network:\(attestation.network)",
            "asset:\(attestation.asset)",
            "policy_hash:\(attestation.policyHash)",
            "proof_digest:\(attestation.proofDigest)",
            "receipt_ref:\(attestation.receiptRef)",
            "signed_at:\(attestation.signedAt)"
        ].joined(separator: "\n")
        return Data(payload.utf8)
    }

    static func makeSignerAttestation(
        intent: PrivateTransferIntentResponse,
        recipientHash: String,
        proofDigest: String,
        receiptRef: String,
        signingKey: Curve25519.Signing.PrivateKey,
        signedAt: Date = Date()
    ) throws -> String {
        guard let signingMode = intent.signingMode,
              let expectedSignerKeyID = intent.signerKeyID,
              let policyHash = intent.policyHash else {
            throw CloudError.privacyBlocked("Private transfer intent is missing signer metadata.")
        }
        let signerKeyID = didKey(fromEd25519PublicKey: signingKey.publicKey.rawRepresentation)
        guard signerKeyID == expectedSignerKeyID else {
            throw CloudError.privacyBlocked("Private signer does not match the approved transfer intent.")
        }
        var attestation = PrivateUSDCxSignerAttestation(
            version: PrivateUSDCxSignerAttestation.version,
            intentID: intent.id,
            signingMode: signingMode,
            signerKeyID: signerKeyID,
            recipientHash: recipientHash,
            amountMicroUSDC: intent.amountMicroUSDC,
            network: intent.network,
            asset: intent.asset,
            policyHash: policyHash,
            proofDigest: proofDigest,
            receiptRef: receiptRef,
            signedAt: attestationTimestamp(for: signedAt),
            signatureBase64: ""
        )
        let signature = try signingKey.signature(for: signerAttestationPayload(attestation))
        attestation = PrivateUSDCxSignerAttestation(
            version: attestation.version,
            intentID: attestation.intentID,
            signingMode: attestation.signingMode,
            signerKeyID: attestation.signerKeyID,
            recipientHash: attestation.recipientHash,
            amountMicroUSDC: attestation.amountMicroUSDC,
            network: attestation.network,
            asset: attestation.asset,
            policyHash: attestation.policyHash,
            proofDigest: attestation.proofDigest,
            receiptRef: attestation.receiptRef,
            signedAt: attestation.signedAt,
            signatureBase64: signature.base64EncodedString()
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return String(data: try encoder.encode(attestation), encoding: .utf8) ?? "{}"
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

private enum PrivatePaymentBase58 {
    private static let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".utf8)

    static func encode(_ data: Data) -> String {
        guard !data.isEmpty else { return "" }
        var digits = [UInt8](repeating: 0, count: 1)

        for byte in data {
            var carry = Int(byte)
            for index in 0..<digits.count {
                let value = Int(digits[index]) * 256 + carry
                digits[index] = UInt8(value % 58)
                carry = value / 58
            }
            while carry > 0 {
                digits.append(UInt8(carry % 58))
                carry /= 58
            }
        }

        var result = String()
        for byte in data where byte == 0 {
            result.append("1")
        }
        for digit in digits.reversed() {
            result.append(Character(UnicodeScalar(alphabet[Int(digit)])))
        }
        return result
    }
}

import CryptoKit
import Foundation
import Security
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

enum NativeMessagingError: LocalizedError {
    case invalidPlaintext
    case missingIdentity
    case missingRecipientKey
    case invalidRecipientKey
    case invalidEnvelope
    case encryptionFailed
    case decryptionFailed
    case signatureFailed
    case persistenceFailed
    case unauthorized
    case invalidResponse
    case privacyBlocked(String)
    case server(Int, String)

    var errorDescription: String? {
        switch self {
        case .invalidPlaintext:
            return "Enter a message."
        case .missingIdentity:
            return "Messaging identity is not ready."
        case .missingRecipientKey:
            return "This contact has no messaging key."
        case .invalidRecipientKey:
            return "This contact's messaging key is invalid."
        case .invalidEnvelope:
            return "This encrypted message is invalid."
        case .encryptionFailed:
            return "Could not encrypt this message."
        case .decryptionFailed:
            return "Could not decrypt this message."
        case .signatureFailed:
            return "Could not verify this message signature."
        case .persistenceFailed:
            return "Could not save messages locally."
        case .unauthorized:
            return "Please sign in again."
        case .invalidResponse:
            return "Invalid messaging response."
        case .privacyBlocked(let message):
            return message
        case .server(let code, let message):
            return "Messaging error \(code): \(message)"
        }
    }
}

final class NativeMessagingKeyStore: @unchecked Sendable {
    static let shared = NativeMessagingKeyStore()

    private let signingPrivateKeyKey = "native_messaging_ed25519_private_key_v1"
    private let agreementPrivateKeyKey = "native_messaging_x25519_private_key_v1"
    private let identityKey = "native_messaging_identity_v2"
    private let localStorageKey = "native_messaging_local_storage_key_v1"
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    func identity() throws -> NativeMessagingIdentity {
        if let data = KeychainHelper.load(identityKey),
           let identity = try? decoder.decode(NativeMessagingIdentity.self, from: data) {
            return identity
        }

        let signingKey = try loadOrCreateSigningKey()
        let agreementKey = try loadOrCreateAgreementKey()
        let deviceId = stableDeviceId()
        let createdAt = Date()
        let expiresAt = Calendar.current.date(byAdding: .day, value: 30, to: createdAt) ?? createdAt.addingTimeInterval(30 * 24 * 60 * 60)
        let signingPubkey = signingKey.publicKey.rawRepresentation.base64EncodedString()
        let x25519Pubkey = agreementKey.publicKey.rawRepresentation.base64EncodedString()
        let did = Self.didKey(fromEd25519PublicKey: signingKey.publicKey.rawRepresentation)
        let deviceLabel = localDeviceName()
        let relayURLs = [NativeMessagingRelayClient.defaultRelayURL]
        let signaturePayload = deviceBundleSignaturePayload(
            did: did,
            deviceId: deviceId,
            deviceLabel: deviceLabel,
            signingPubkeyBase64: signingPubkey,
            x25519PrekeyPubBase64: x25519Pubkey,
            relayURLs: relayURLs,
            createdAt: createdAt,
            expiresAt: expiresAt
        )
        let signature = try signingKey.signature(for: signaturePayload).base64EncodedString()

        let identity = NativeMessagingIdentity(
            did: did,
            deviceId: deviceId,
            deviceLabel: deviceLabel,
            signingPubkeyBase64: signingPubkey,
            x25519PrekeyPubBase64: x25519Pubkey,
            relayURLs: relayURLs,
            createdAt: createdAt,
            expiresAt: expiresAt,
            signature: signature
        )
        guard KeychainHelper.save(try encoder.encode(identity), for: identityKey) else {
            throw NativeMessagingError.persistenceFailed
        }
        return identity
    }

    func encryptForRecipient(
        plaintext: String,
        recipientDID: String,
        recipientKey: NativeMessagingDeviceKey,
        kind: NativeMessageKind = .human,
        approvalReceiptHash: String? = nil
    ) throws -> NativeMessageEnvelope {
        let trimmed = plaintext.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw NativeMessagingError.invalidPlaintext }
        guard let recipientKeyData = Data(base64Encoded: recipientKey.publicKeyBase64) else {
            throw NativeMessagingError.invalidRecipientKey
        }

        let senderIdentity = try identity()
        let messageId = UUID()
        let threadId = UUID()
        let createdAt = Date()
        let payload = NativeMessagePayload(
            v: 1,
            type: "ghola.message",
            conversationId: threadId.uuidString,
            messageId: messageId.uuidString,
            senderDID: senderIdentity.did,
            senderDeviceId: senderIdentity.deviceId,
            createdAt: createdAt,
            body: .init(kind: "text", text: trimmed),
            replyTo: nil,
            attachments: []
        )
        let plaintextData = try encoder.encode(payload)
        let associatedData = Self.associatedData(
            threadId: threadId,
            messageId: messageId,
            senderDeviceId: senderIdentity.deviceId,
            createdAt: createdAt
        )
        let wire = try sealSEv1(
            plaintext: plaintextData,
            recipientDID: recipientDID,
            recipientX25519PublicKey: recipientKeyData,
            associatedData: associatedData,
            identity: senderIdentity
        )

        return NativeMessageEnvelope(
            id: messageId,
            threadId: threadId,
            senderDID: senderIdentity.did,
            recipientDID: recipientDID,
            senderDeviceId: senderIdentity.deviceId,
            recipientDeviceId: recipientKey.id,
            kind: kind,
            sealedEnvelopeBase64: wire.base64EncodedString(),
            approvalReceiptHash: approvalReceiptHash,
            createdAt: createdAt
        )
    }

    func encryptForLocalStore(_ plaintext: String) throws -> String {
        guard let plaintextData = plaintext.data(using: .utf8) else {
            throw NativeMessagingError.invalidPlaintext
        }
        let key = try localSymmetricKey()
        guard let sealed = try? AES.GCM.seal(plaintextData, using: key),
              let combined = sealed.combined else {
            throw NativeMessagingError.encryptionFailed
        }
        return combined.base64EncodedString()
    }

    func decryptEnvelope(
        _ envelope: NativeMessageEnvelope,
        senderKey: NativeMessagingDeviceKey
    ) throws -> String {
        guard let wire = Data(base64Encoded: envelope.sealedEnvelopeBase64) else {
            throw NativeMessagingError.invalidEnvelope
        }
        let opened = try openSEv1(wire: wire)
        guard opened.senderDID == envelope.senderDID,
              opened.recipientDID == envelope.recipientDID else {
            throw NativeMessagingError.signatureFailed
        }
        if let expectedSigningKey = senderKey.signingPubkeyBase64,
           let expected = Data(base64Encoded: expectedSigningKey),
           let actual = try? Self.ed25519PublicKey(fromDID: opened.senderDID),
           expected != actual {
            throw NativeMessagingError.signatureFailed
        }
        let payload = try decoder.decode(NativeMessagePayload.self, from: opened.plaintext)
        guard payload.senderDID == envelope.senderDID,
              payload.senderDeviceId == envelope.senderDeviceId,
              payload.messageId.caseInsensitiveCompare(envelope.id.uuidString) == .orderedSame,
              payload.conversationId.caseInsensitiveCompare(envelope.threadId.uuidString) == .orderedSame else {
            throw NativeMessagingError.signatureFailed
        }
        return payload.body.text
    }

    func decryptFromLocalStore(_ ciphertextBase64: String) throws -> String {
        guard let data = Data(base64Encoded: ciphertextBase64),
              let sealed = try? AES.GCM.SealedBox(combined: data),
              let plaintext = try? AES.GCM.open(sealed, using: localSymmetricKey()),
              let value = String(data: plaintext, encoding: .utf8) else {
            throw NativeMessagingError.decryptionFailed
        }
        return value
    }

    private func sealSEv1(
        plaintext: Data,
        recipientDID: String,
        recipientX25519PublicKey: Data,
        associatedData: Data,
        identity: NativeMessagingIdentity
    ) throws -> Data {
        let signingKey = try loadOrCreateSigningKey()
        let recipientPublicKey: Curve25519.KeyAgreement.PublicKey
        do {
            recipientPublicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: recipientX25519PublicKey)
        } catch {
            throw NativeMessagingError.invalidRecipientKey
        }

        let ephemeral = Curve25519.KeyAgreement.PrivateKey()
        let sharedSecret = try ephemeral.sharedSecretFromKeyAgreement(with: recipientPublicKey)
        let key = sharedSecret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: Data([0x53, 0x45, 0x76, 0x31, 0x01]),
            sharedInfo: Data("said-envelope-v1/\(recipientDID)".utf8),
            outputByteCount: 32
        )

        var nonceBytes = [UInt8](repeating: 0, count: 12)
        guard SecRandomCopyBytes(kSecRandomDefault, nonceBytes.count, &nonceBytes) == errSecSuccess else {
            throw NativeMessagingError.encryptionFailed
        }
        let nonce = try AES.GCM.Nonce(data: Data(nonceBytes))
        guard let sealed = try? AES.GCM.seal(plaintext, using: key, nonce: nonce, authenticating: associatedData),
              let ciphertext = sealed.combined else {
            throw NativeMessagingError.encryptionFailed
        }

        var body = Data()
        body.append(Data("SEv1".utf8))
        body.append(0x01)
        body.append(0x01)
        try body.appendUInt16BE(identity.did.utf8.count)
        body.append(Data(identity.did.utf8))
        try body.appendUInt16BE(recipientDID.utf8.count)
        body.append(Data(recipientDID.utf8))
        body.append(ephemeral.publicKey.rawRepresentation)
        body.append(Data(nonceBytes))
        try body.appendUInt16BE(associatedData.count)
        body.append(associatedData)
        try body.appendUInt32BE(ciphertext.count)
        body.append(ciphertext)

        let digest = Data(SHA256.hash(data: body))
        let signature = try signingKey.signature(for: digest)
        body.append(signature)
        return body
    }

    private func openSEv1(wire: Data) throws -> OpenedSEv1 {
        guard wire.count > 4 + 1 + 1 + 64 else {
            throw NativeMessagingError.invalidEnvelope
        }
        let bodyEnd = wire.count - 64
        let body = wire.prefix(bodyEnd)
        let signature = Data(wire.suffix(64))
        var cursor = ByteCursor(data: Data(body))
        guard try cursor.take(4) == Data("SEv1".utf8) else {
            throw NativeMessagingError.invalidEnvelope
        }
        guard try cursor.takeByte() == 0x01 else {
            throw NativeMessagingError.invalidEnvelope
        }
        guard try cursor.takeByte() == 0x01 else {
            throw NativeMessagingError.invalidEnvelope
        }
        let senderLength = try cursor.takeUInt16()
        let senderData = try cursor.take(senderLength)
        let recipientLength = try cursor.takeUInt16()
        let recipientData = try cursor.take(recipientLength)
        guard let senderDID = String(data: senderData, encoding: .utf8),
              let recipientDID = String(data: recipientData, encoding: .utf8) else {
            throw NativeMessagingError.invalidEnvelope
        }
        let ephemeralPubkey = try cursor.take(32)
        let nonceData = try cursor.take(12)
        let adLength = try cursor.takeUInt16()
        let associatedData = try cursor.take(adLength)
        let ciphertextLength = try cursor.takeUInt32()
        let ciphertext = try cursor.take(ciphertextLength)
        guard cursor.isAtEnd else {
            throw NativeMessagingError.invalidEnvelope
        }

        let senderPubkeyBytes = try Self.ed25519PublicKey(fromDID: senderDID)
        let senderPubkey = try Curve25519.Signing.PublicKey(rawRepresentation: senderPubkeyBytes)
        let digest = Data(SHA256.hash(data: body))
        guard senderPubkey.isValidSignature(signature, for: digest) else {
            throw NativeMessagingError.signatureFailed
        }

        let agreementKey = try loadOrCreateAgreementKey()
        let ephemeralPublicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: ephemeralPubkey)
        let sharedSecret = try agreementKey.sharedSecretFromKeyAgreement(with: ephemeralPublicKey)
        let key = sharedSecret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: Data([0x53, 0x45, 0x76, 0x31, 0x01]),
            sharedInfo: Data("said-envelope-v1/\(recipientDID)".utf8),
            outputByteCount: 32
        )
        let nonce = try AES.GCM.Nonce(data: nonceData)
        let sealedBox = try AES.GCM.SealedBox(combined: ciphertext)
        let plaintext = try AES.GCM.open(sealedBox, using: key, authenticating: associatedData)
        return OpenedSEv1(
            senderDID: senderDID,
            recipientDID: recipientDID,
            associatedData: associatedData,
            plaintext: plaintext
        )
    }

    private func loadOrCreateSigningKey() throws -> Curve25519.Signing.PrivateKey {
        if let data = KeychainHelper.load(signingPrivateKeyKey),
           let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: data) {
            return key
        }

        let key = Curve25519.Signing.PrivateKey()
        guard KeychainHelper.save(key.rawRepresentation, for: signingPrivateKeyKey) else {
            throw NativeMessagingError.persistenceFailed
        }
        return key
    }

    private func loadOrCreateAgreementKey() throws -> Curve25519.KeyAgreement.PrivateKey {
        if let data = KeychainHelper.load(agreementPrivateKeyKey),
           let key = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: data) {
            return key
        }

        let key = Curve25519.KeyAgreement.PrivateKey()
        guard KeychainHelper.save(key.rawRepresentation, for: agreementPrivateKeyKey) else {
            throw NativeMessagingError.persistenceFailed
        }
        return key
    }

    private func localSymmetricKey() throws -> SymmetricKey {
        if let data = KeychainHelper.load(localStorageKey) {
            return SymmetricKey(data: data)
        }

        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw NativeMessagingError.persistenceFailed }
        let data = Data(bytes)
        guard KeychainHelper.save(data, for: localStorageKey) else {
            throw NativeMessagingError.persistenceFailed
        }
        return SymmetricKey(data: data)
    }

    private func stableDeviceId() -> String {
        let key = "native_messaging_device_id_v1"
        if let value = KeychainHelper.loadString(key) {
            return value
        }
        let value = "dev_\(UUID().uuidString.lowercased())"
        KeychainHelper.save(value, for: key)
        return value
    }

    private func localDeviceName() -> String {
        #if canImport(UIKit)
        return UIDevice.current.name
        #elseif canImport(AppKit)
        return Host.current().localizedName ?? "Mac"
        #else
        return "Device"
        #endif
    }

    private func deviceBundleSignaturePayload(
        did: String,
        deviceId: String,
        deviceLabel: String,
        signingPubkeyBase64: String,
        x25519PrekeyPubBase64: String,
        relayURLs: [String],
        createdAt: Date,
        expiresAt: Date
    ) -> Data {
        let iso = ISO8601DateFormatter()
        let payload = [
            "GholaDeviceKeyBundleV1",
            did,
            deviceId,
            deviceLabel,
            signingPubkeyBase64,
            x25519PrekeyPubBase64,
            relayURLs.joined(separator: ","),
            iso.string(from: createdAt),
            iso.string(from: expiresAt),
        ].joined(separator: "\n")
        return Data(payload.utf8)
    }

    static func associatedData(
        threadId: UUID,
        messageId: UUID,
        senderDeviceId: String,
        createdAt: Date
    ) -> Data {
        let created = ISO8601DateFormatter().string(from: createdAt)
        return Data("ghola-message-v1;conversation=\(threadId.uuidString);message=\(messageId.uuidString);sender_device=\(senderDeviceId);created_at=\(created)".utf8)
    }

    static func didKey(fromEd25519PublicKey publicKey: Data) -> String {
        var data = Data([0xed, 0x01])
        data.append(publicKey)
        return "did:key:z\(Base58.encode(data))"
    }

    static func ed25519PublicKey(fromDID did: String) throws -> Data {
        guard did.hasPrefix("did:key:z") else {
            throw NativeMessagingError.invalidEnvelope
        }
        let value = String(did.dropFirst("did:key:z".count))
        let decoded = try Base58.decode(value)
        guard decoded.count == 34,
              decoded[decoded.startIndex] == 0xed,
              decoded[decoded.index(after: decoded.startIndex)] == 0x01 else {
            throw NativeMessagingError.invalidEnvelope
        }
        return Data(decoded.dropFirst(2))
    }
}

private struct OpenedSEv1 {
    let senderDID: String
    let recipientDID: String
    let associatedData: Data
    let plaintext: Data
}

private struct ByteCursor {
    private let data: Data
    private var offset = 0

    var isAtEnd: Bool { offset == data.count }

    init(data: Data) {
        self.data = data
    }

    mutating func takeByte() throws -> UInt8 {
        let value = try take(1)
        return value[value.startIndex]
    }

    mutating func takeUInt16() throws -> Int {
        let bytes = try take(2)
        return (Int(bytes[bytes.startIndex]) << 8) | Int(bytes[bytes.index(after: bytes.startIndex)])
    }

    mutating func takeUInt32() throws -> Int {
        let bytes = try take(4)
        var value: UInt32 = 0
        for byte in bytes {
            value = (value << 8) | UInt32(byte)
        }
        return Int(value)
    }

    mutating func take(_ count: Int) throws -> Data {
        guard count >= 0, offset + count <= data.count else {
            throw NativeMessagingError.invalidEnvelope
        }
        let range = offset..<(offset + count)
        offset += count
        return data.subdata(in: range)
    }
}

private extension Data {
    mutating func appendUInt16BE(_ value: Int) throws {
        guard value <= UInt16.max else { throw NativeMessagingError.invalidEnvelope }
        append(UInt8((value >> 8) & 0xff))
        append(UInt8(value & 0xff))
    }

    mutating func appendUInt32BE(_ value: Int) throws {
        guard value <= UInt32.max else { throw NativeMessagingError.invalidEnvelope }
        append(UInt8((value >> 24) & 0xff))
        append(UInt8((value >> 16) & 0xff))
        append(UInt8((value >> 8) & 0xff))
        append(UInt8(value & 0xff))
    }
}

private enum Base58 {
    private static let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".utf8)
    private static let indexes: [UInt8: Int] = {
        var map: [UInt8: Int] = [:]
        for (index, byte) in alphabet.enumerated() {
            map[byte] = index
        }
        return map
    }()

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

    static func decode(_ string: String) throws -> Data {
        guard !string.isEmpty else { return Data() }
        var bytes = [UInt8](repeating: 0, count: 1)

        for char in string.utf8 {
            guard let carryStart = indexes[char] else {
                throw NativeMessagingError.invalidEnvelope
            }
            var carry = carryStart
            for index in 0..<bytes.count {
                let value = Int(bytes[index]) * 58 + carry
                bytes[index] = UInt8(value & 0xff)
                carry = value >> 8
            }
            while carry > 0 {
                bytes.append(UInt8(carry & 0xff))
                carry >>= 8
            }
        }

        var leadingZeros = 0
        for char in string.utf8 {
            if char == alphabet[0] {
                leadingZeros += 1
            } else {
                break
            }
        }

        var output = Data(repeating: 0, count: leadingZeros)
        output.append(contentsOf: bytes.reversed())
        return output
    }
}

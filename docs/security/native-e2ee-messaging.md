# Ghola Native E2EE Messaging

Status: protocol/security notes for native E2EE messaging. This document is normative for test vectors and invariants, but it does not change backend routes or mobile UI.

## Scope

Native E2EE messaging stores and forwards opaque encrypted records through Ghola cloud. Cloud services may route, rate-limit, persist ciphertext, and verify public metadata, but must not require message plaintext for native message storage.

The current shared cryptographic primitive is `SEv1`, implemented in:

- `crates/said-envelope/src/lib.rs`
- `apps/web/src/lib/envelope.ts`

`GholaMessageV1`, `DeviceKeyBundleV1`, and `ApprovalReceiptV1` are canonical JSON payloads carried by SEv1 or signed beside it. They are defined here so Rust, TypeScript, Swift, Kotlin, and any relay implementation can produce the same bytes before signing or hashing.

## Canonical Encoding Rules

For cross-language tests:

- JSON is UTF-8.
- Object keys are lexicographically sorted.
- No insignificant whitespace.
- Integers are decimal JSON numbers when they are below `2^53`; otherwise encode as lowercase decimal strings.
- Binary fields are base64url without padding unless a field name explicitly ends in `_hex`.
- Timestamps are RFC 3339 UTC strings with `Z`.
- Signature input is the exact canonical JSON bytes or the exact SEv1 body digest described below. Do not sign a parsed/reformatted object.

## SEv1

SEv1 is a signed envelope. The signature covers every byte before the trailing 64-byte Ed25519 signature.

Wire fields:

```text
magic               4  bytes  "SEv1"
version             1  byte   0x01
recipient_kind      1  byte   0x00 self, 0x01 peer-DID, 0x02 model-bridge
sender_did_len      2  bytes  big-endian
sender_did          var       UTF-8 did:key
recipient_id_len    2  bytes  big-endian
recipient_id        var       UTF-8 did:key or opaque model id
ephem_pub          32  bytes  X25519 ephemeral public key
nonce              12  bytes  AES-GCM nonce
ad_len              2  bytes  big-endian
ad                  var       associated data
ct_len              4  bytes  big-endian
ciphertext + tag    var       AES-256-GCM output
sig                64  bytes  Ed25519(signature over SHA-256(body))
```

AAD for native messages should bind at least:

```text
ghola-message-v1;conversation=<conversation_id>;message=<message_id>;sender_device=<device_id>;created_at=<created_at>
```

Replay protection is not provided by `open()` alone. Consumers must maintain a replay cache keyed by `(conversation_id, message_id, envelope nonce or envelope hash)` and reject duplicates outside explicit idempotent retry handling.

## GholaMessageV1

Plaintext payload encrypted inside SEv1:

```json
{
  "v": 1,
  "type": "ghola.message",
  "conversation_id": "conv_01JEXAMPLE0000000000000000",
  "message_id": "msg_01JEXAMPLE0000000000000000",
  "sender_did": "did:key:z6MkgxFiZiRE1XJHX7dqZXGgcNWWrPirT2izosrtduZnAw4s",
  "sender_device_id": "dev_iphone_01",
  "created_at": "2026-05-17T13:00:00Z",
  "body": {
    "kind": "text",
    "text": "hello bob from alice"
  },
  "reply_to": null,
  "attachments": []
}
```

Required invariants:

- `sender_did` must equal the SEv1 `sender_did`.
- `conversation_id`, `message_id`, `sender_device_id`, and `created_at` must be present in AAD or in an application-level signed transcript hash.
- Cloud storage may persist the SEv1 bytes, routing metadata, and delivery status. It must not persist `body.text` or decrypted attachment metadata.

## DeviceKeyBundleV1

Public bundle used to advertise a device's E2EE keys:

```json
{
  "v": 1,
  "type": "ghola.device_key_bundle",
  "user_did": "did:key:z6MkgxFiZiRE1XJHX7dqZXGgcNWWrPirT2izosrtduZnAw4s",
  "device_id": "dev_iphone_01",
  "device_label": "Alice iPhone",
  "identity_signing_did": "did:key:z6MkgxFiZiRE1XJHX7dqZXGgcNWWrPirT2izosrtduZnAw4s",
  "x25519_public_b64u": "3FaTfdd3nq0nYeP6BKY2Xj8ImKFvsqH_QblXwITVP5o",
  "prekeys": [
    {
      "prekey_id": "pk_0001",
      "x25519_public_b64u": "1kVkgJmaT6bBucdNwW2vJEDGnvbcbawgkJt_bTxtrUc",
      "expires_at": "2026-06-16T13:00:00Z"
    }
  ],
  "created_at": "2026-05-17T13:00:00Z",
  "expires_at": "2026-06-16T13:00:00Z"
}
```

Signature input:

```text
GholaDeviceKeyBundleV1\n || canonical_json(bundle_without_signature)
```

Bundle signature field:

```json
{
  "signature_alg": "Ed25519",
  "signature_b64u": "<signature by identity_signing_did>"
}
```

Stale bundle handling:

- Reject bundles past `expires_at`.
- Reject a prekey after its own `expires_at`.
- Reject a bundle whose `user_did` or `device_id` does not match the account/device being updated.
- Treat missing or failed signature verification as tamper, not as "needs refresh".

## ApprovalReceiptV1

Signed record that a user approved adding a device, rotating keys, or sending to a newly observed device set:

```json
{
  "v": 1,
  "type": "ghola.approval_receipt",
  "approval_id": "appr_01JEXAMPLE0000000000000000",
  "user_did": "did:key:z6MkgxFiZiRE1XJHX7dqZXGgcNWWrPirT2izosrtduZnAw4s",
  "approver_device_id": "dev_iphone_01",
  "subject": {
    "kind": "device_key_bundle",
    "device_id": "dev_mac_01",
    "bundle_hash_b64u": "sha256-base64url-of-canonical-device-bundle"
  },
  "policy_epoch": 7,
  "created_at": "2026-05-17T13:00:00Z",
  "expires_at": "2026-05-18T13:00:00Z"
}
```

Signature input:

```text
GholaApprovalReceiptV1\n || canonical_json(receipt_without_signature)
```

Receipt signature field:

```json
{
  "signature_alg": "Ed25519",
  "signature_b64u": "<signature by approver device or user identity key>"
}
```

Stale approval assumptions:

- A receipt is valid only for the exact `subject` hash and `policy_epoch`.
- Clients must reject receipts past `expires_at`.
- Clients must reject receipts whose `policy_epoch` is older than the locally pinned device-set epoch.
- Replaying an old receipt for a new bundle is tamper because `bundle_hash_b64u` changes.

## Test Vectors

These vectors are generated by:

```sh
cargo run -p said-envelope --example gen_vectors -- --out /tmp/ghola-envelope-vectors.json
```

Consumers must verify:

- `open(wire_hex, recipient_x25519_secret_hex)` succeeds.
- Opened `recipient_kind`, `recipient_id`, `expected_sender_did`, `associated_data_hex`, and `plaintext_hex` match.
- Mutating any byte in `wire_hex` fails, except for test harness mutations that also recompute all dependent cryptographic fields.

### Vector 1: SEv1 Peer DID Small

```json
{
  "name": "peer-did/small",
  "recipient_kind": 1,
  "sender_signing_seed_hex": "8e882533990aaeb54b57ba374c5e8ce98166be879d59852c39243df2c54d6d58",
  "recipient_x25519_secret_hex": "bb142d7112d679c780b457b3abc7eae7c4c0784a409b7f6d3c6da03226afbde5",
  "recipient_id": "did:key:z6MkuvajM3HoGhuQYPkyFDLeLADv6mfnLnbgFYnRH79jkKPJ",
  "expected_sender_did": "did:key:z6MkgxFiZiRE1XJHX7dqZXGgcNWWrPirT2izosrtduZnAw4s",
  "associated_data_hex": "73657373696f6e3d6162633b74733d31373030303030303030",
  "plaintext_hex": "68656c6c6f20626f622066726f6d20616c696365",
  "wire_hex": "53457631010100386469643a6b65793a7a364d6b677846695a69524531584a48583764715a584767634e5757725069725432697a6f73727464755a6e4177347300386469643a6b65793a7a364d6b7576616a4d33486f4768755159506b7946444c654c414476366d666e4c6e626746596e524837396a6b4b504a74dc56937dd7779ead2761e3fa04a6365e3f0898a16fb2a1ff41b957c084d53f9a019a9fad7c56bd2db2bf1f001973657373696f6e3d6162633b74733d3137303030303030303000000024349520e0660a3fed71a652f30d1fff9c2b8eee5214a95006051a9e7a81622800572cf02c40edeceaecf5bf589dc54e0167f05a0ec09b613140d10a30920a62c452f905c8e665d2d21fd6d8daae1de6b42b29e2059e8186def386dcdb2a90cd3512569602"
}
```

### Vector 2: SEv1 Self Recipient Large

For documentation readability, this vector pins metadata and lengths. Full `wire_hex` and `plaintext_hex` are emitted by the generator above.

```json
{
  "name": "self-recipient/large",
  "recipient_kind": 0,
  "sender_signing_seed_hex": "cd66d59e508cf093e5c7f29fd067c1a43df0da35da01fa2b345c9ae94a75ffd0",
  "recipient_x25519_secret_hex": "d0dd4b1d2637a44c92594618d9de4b7d1d60171fea7b76f6ae260537fe740c60",
  "recipient_id": "did:key:z6MkqY8cELob7GNMQip3xPxEHx5JRUw5UsQN5ou3qUFwLgZ6",
  "expected_sender_did": "did:key:z6MkqY8cELob7GNMQip3xPxEHx5JRUw5UsQN5ou3qUFwLgZ6",
  "associated_data_hex": "",
  "plaintext_len": 1024
}
```

### Vector 3: SEv1 Model Bridge

`recipient_kind = 2` is cloud-readable by design. Do not label it as native E2EE.

```json
{
  "name": "model-bridge/opaque-recipient",
  "recipient_kind": 2,
  "sender_signing_seed_hex": "acf55849ce68396b6e34edc3a86f10adbaf7f73663c823e80ceffc6d4efac8db",
  "recipient_x25519_secret_hex": "971f96b148bb532713d09ae429828240748a4bf65205734dde2e7b08db0dd18f",
  "recipient_id": "anthropic/claude-sonnet-4-6",
  "expected_sender_did": "did:key:z6Mku3Tx4bytbcCvUWNzeG1Ae7RAcQU4b3Zdf9NSScRpnsMa",
  "associated_data_hex": "726f6c653d757365723b6d6f64656c2d627269646765",
  "plaintext_hex": "57686174277320746865206d65616e696e67206f66206c6966653f",
  "wire_hex": "53457631010200386469643a6b65793a7a364d6b75335478346279746263437655574e7a65473141653752416351553462335a6466394e53536352706e734d61001b616e7468726f7069632f636c617564652d736f6e6e65742d342d36e07be2e3248463029f76fbbdfeb6392d8a2c78a6843356bc7f22a271ad1c094af8ba5071145e161a73aa98810016726f6c653d757365723b6d6f64656c2d6272696467650000002b15b0444283f0b45963c36d4652dc77f7b87c4f1233a7572bfec5a7e1ed89d41b1a23f984be72b993dd34f5e315106a98373faeb9533c38e121a47ca22cc7c93ad8bf7e0ffbafde98c520b4163ab30848f49b0a5ef1877765ac14552bb56812749b5569a24c99e97418ae08"
}
```

## Storage Invariants

No plaintext cloud storage means:

- Native message tables store `envelope_blob`, envelope hash, sender/recipient routing ids, timestamps, and delivery state.
- They do not store `GholaMessageV1.body.text`, decrypted attachment names, decrypted attachment MIME types, or decrypted contact-card fields.
- Search indexing over native E2EE messages is client-side unless a future design explicitly uses searchable encryption and gets a new threat model.

Testable client-side invariant:

- `ChatVault.sealUserMessage()` returns only a base64 SEv1 blob.
- Decoded wire bytes may contain header metadata and AAD, but must not contain the message body plaintext or plaintext JSON field names such as `"content"`.

## Tamper, Replay, and Stale Approval Notes

Tamper:

- Any mutation of SEv1 body bytes must fail signature verification.
- Any mutation of ciphertext with a recomputed signature must fail AEAD unless the attacker also has the recipient secret.
- Any mutation of `DeviceKeyBundleV1` or `ApprovalReceiptV1` canonical JSON must fail signature verification.

Replay:

- SEv1 permits opening the same valid wire bytes more than once. This is intentional so offline sync can be idempotent.
- The message processor, not the cryptographic opener, owns replay rejection.
- Minimum replay key: `sha256(SEv1 wire)`.
- Better replay key for messages: `(conversation_id, message_id, sender_device_id)`, with the SEv1 hash recorded as the accepted value for that tuple.

Stale approval:

- Device bundles and approval receipts are stale after `expires_at`.
- A receipt is stale when its `policy_epoch` is lower than the locally pinned device-set epoch.
- Clients should fail closed when the current device-set epoch cannot be fetched. They may queue outbound messages locally but must not silently encrypt to an unverified or stale recipient set.

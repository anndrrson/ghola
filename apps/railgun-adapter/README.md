# Ghola Railgun Adapter

Gateway-facing Railgun/EVM verifier adapter for `railgun_evm_shielded`.

This service does not hold user Railgun spending keys. Users generate and submit
private Railgun transactions with their own wallet/SDK. The adapter verifies the
public EVM transaction receipt, enforces Ghola's proof policy gates, and signs a
receipt for `thumper-cloud`.

## Endpoints

- `GET /health`
- `POST /verify`

## Required env

- `RAILGUN_ADAPTER_AUTH_TOKEN`
- `RAILGUN_ADAPTER_SIGNING_PRIVATE_KEY_PEM` or `RAILGUN_ADAPTER_SIGNING_PRIVATE_KEY_B64`
- `RAILGUN_EVM_RPC_URL`
- `RAILGUN_EVM_NETWORK`, default `arbitrum`
- `RAILGUN_EVM_ASSET`, default `USDC`
- `RAILGUN_EVM_RECIPIENT`
- `RAILGUN_EVM_BROADCASTER_READY=true`
- `RAILGUN_EVM_PROOF_OF_INNOCENCE_CONFIGURED=true`
- `RAILGUN_EVM_PROOF_OF_INNOCENCE_REQUIRED=true`, default `true`
- `RAILGUN_EVM_MIN_CONFIRMATIONS`, default `1`
- `RAILGUN_EVM_CONTRACT_ADDRESS`, optional but recommended
- `RAILGUN_AMOUNT_ATTESTOR_PUBLIC_KEY_PEM` or `RAILGUN_AMOUNT_ATTESTOR_PUBLIC_KEY_B64`

Set the matching public key in `thumper-cloud` as `RAILGUN_EVM_ADAPTER_PUBKEY`.

## ⚠️ Amount trust boundary (read before deploying)

Railgun **shields the transferred amount on-chain**. The adapter's on-chain check
(`verifiedReceipt`) proves only that the tx exists, succeeded, has enough
confirmations, and touched the Railgun contract — it **cannot** recover the paid
amount from logs. Trusting a bare client-supplied `railgun.amount` would let any
caller present a real (even unrelated) Railgun tx and claim an arbitrary paid
amount, settling paid services for free.

The adapter therefore requires the amount to arrive inside a **signed
`proof.amount_attestation`** bound to the exact `(provider, network, asset,
destination, receipt_ref)`. Configure the attestor's public key via
`RAILGUN_AMOUNT_ATTESTOR_PUBLIC_KEY_PEM` (or `_B64`). The attested message is
defined by `crypto.js::amountAttestationPayload`.

If neither the attestor key nor the explicit unsafe opt-in is set, the adapter
reports `amount_attestor_key` in `/health.missing` and **refuses to settle**
(fail closed).

- `RAILGUN_TRUST_CLIENT_AMOUNT_UNSAFE=true` — **DANGEROUS** escape hatch that
  trusts the unverified client amount. Only enable in dev/test, or where a
  trusted upstream component is known to verify the amount out-of-band.

## Verify payload

`proof.extensions.railgun` must include:

- `tx_hash`
- `amount`
- `destination`
- `network`
- `asset`
- `broadcaster`
- `proof_of_innocence_id`
- `proof_of_innocence_passed`

The adapter signs the canonical receipt payload expected by `thumper-cloud`.

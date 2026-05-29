# Hyperliquid Private Execution Pilot

Ghola v1 treats Hyperliquid as the first live venue for a private execution
layer. The normal Ghola app stores commitments and encrypted vault ciphertext.
Raw Hyperliquid account IDs, API wallet secrets, strategy text, prompts, and raw
order payloads are sealed to the attested private-agent worker.

## Privacy Boundary

- Hidden from public observers: the user's main wallet funding path after
  shielded import/batch evidence.
- Hidden from normal Ghola app/operator paths: raw execution credentials,
  strategy text, prompts, routing logic, and raw order payloads.
- Visible to Hyperliquid in v1: the execution account and order activity.
- Visible in Ghola receipts: commitments, redacted connector status, runtime
  attestation commitments, shielded funding evidence, and encrypted selective
  disclosure exports.

This is a private execution layer, not anonymity from Hyperliquid. A pooled or
omnibus partner model would be a later phase.

## Required Gates

- `GHOLA_V6_HYPERLIQUID_PILOT_ENABLED=true`
- Current sealed runtime health with attestation and measurement commitments
- Encrypted Hyperliquid execution vault readiness
- Shielded funding import and batch evidence
- Connector readiness for `hyperliquid_style_market`

Supported v1 operations are read, limit order, cancel, and reconcile.
Withdrawals, raw vault transfers, and leverage escalation are blocked by
default.

## Connect Flow

V1 imports an already-approved Hyperliquid API/agent wallet. The user enters
the Hyperliquid account address and agent private key in the browser. The
browser fetches the current attested private-agent recipient, seals the
credential locally to that TEE recipient, and POSTs only the encrypted bundle to
`/v1/private-account/hyperliquid/vault`.

The normal Ghola app must not receive or persist the raw Hyperliquid account
address, API wallet private key, strategy text, prompts, or raw order payloads.

## Worker Endpoints

- `GET /health`
- `GET /.well-known/private-agent-recipient`
- `POST /hyperliquid/sessions`
- `POST /hyperliquid/orders`
- `POST /hyperliquid/reconcile`

All private execution requests must include only commitments, capped policy
metadata, and encrypted bundles, and must set
`x-ghola-sealed-execution-required: true`.

## Live Execution

The private-agent worker now opens the sealed Hyperliquid vault inside the TEE,
uses the Hyperliquid Python SDK to sign/submit allowed actions, and returns only
redacted commitment receipts. `POST /hyperliquid/orders` requires an
`encrypted_execution_instruction_bundle` unless an armed sealed strategy session
contains a deterministic instruction template.

Instruction AAD format:

```text
ghola/private-execution-instruction-v1|work_order:<commitment>|venue:hyperliquid|recipient:<recipient_id>
```

The cockpit can bind to `preview:<preview_commitment>` before the server creates
the connector work order; lower-level connector flows should bind to
`work_order:<work_order_commitment>` when it is already known.

Mainnet/testnet selection comes from the sealed vault. `PRIVATE_AGENT_VENUE_DRY_RUN=true`
keeps local tests off venue networks; production should run with the dry-run flag
disabled and `PRIVATE_AGENT_GLOBAL_KILL_SWITCH=false`.

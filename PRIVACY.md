# Ghola Privacy Boundary

This document describes the current privacy claim for Ghola browser agents and
shielded payments. It is intentionally conservative: if a property is not
enforced in code or by a named shielded system, it is not claimed.

## What Ghola Should Not See

- Wallet seed phrases, private keys, Railgun viewing keys, Aleo proving keys, or
  raw shielded wallet state.
- A durable user wallet address in the `x402-payment` header for shielded rails.
- Plaintext anonymous chat history in `localStorage`.
- A public payment proof when the caller requested a private shielded rail.

## What Ghola Still Sees

- The selected agent/model, max token ceiling, timing, IP-level network
  metadata at the HTTP layer, and the amount required for settlement.
- An opaque shielded settlement reference or nullifier used for replay
  prevention.
- Adapter attestations for shielded rails, including provider, network, asset,
  destination, amount, proof digest, confirmation count, and expiry.

## Shielded Payment Rails

`private_shielded_auto` is a fail-closed selector over configured shielded
rails. It may choose Aleo USDCx, Railgun/EVM, or the Solana shielded pool when
that rail is ready. It must not silently downgrade to public USDC.

`railgun_evm_shielded` is the preferred EVM-compatible rail when avoiding Aleo
counterparty concentration matters. The server verifies a signed adapter receipt
and rejects missing broadcaster readiness, missing proof-of-innocence readiness,
expired receipts, bad proof digests, and replayed settlement references.
Railgun evidence must also be marked `relay_only: true` and
`public_wallet_broadcast: false`; non-relayed evidence is rejected.

## Request Binding

For private x402 inference, the 402 response includes a `request_hash` in each
payment option. The client must copy that hash into the shielded proof payload.
The server recomputes the hash from the model, plaintext messages when present,
sealed-request digest, enclave id, temperature, and max-token ceiling before
accepting the payment.

This prevents a valid shielded receipt for one inference request from being
reused against a different agent/model/body. Prompt-confidential remote agent
calls must use sealed inference and must not include plaintext messages in the
OpenAI-compatible request body; local mode is the other supported prompt-private
boundary.

## Blind x402 Transport

Railgun x402 requests use the OHTTP relay path automatically in the web app
when `NEXT_PUBLIC_OHTTP_RELAY_URL` is configured. Custom clients can pass an
`ohttpRelay` URL explicitly. The relay only accepts
`POST /v1/chat/completions` inside that tunnel and forwards a narrow allowlist
of content, authorization, and payment headers to `thumper-cloud`. Cookies,
referrers, forwarded IPs, request IDs, wallet identifiers, user identifiers,
and viewing-key-like headers are stripped.

This improves network-layer privacy by separating the browser source IP from
the payment/inference endpoint. It does not hide request bodies from
`thumper-cloud`; it is a network blind relay, not encrypted remote compute.

## Browser Local Mode

Browser local mode is private only when the model actually runs locally and
remote fallback is disabled. Ghola should treat failed local setup as a hard
privacy boundary, not as permission to call a hosted model. Anonymous chat
history is off-record unless the encrypted vault is available.

## Remaining Trust Assumptions

- The browser, wallet extension, and device are trusted.
- Plaintext remote inference is still possible only on explicit open routes;
  `ghola-private` and `agent:*` require local or sealed inference for prompt
  confidentiality.
- Shielded rail privacy is subject to timing, liquidity, bridge, relayer,
  broadcaster, RPC, and withdrawal-correlation analysis.
- The Railgun adapter is trusted to enforce EVM receipt checks and sign only
  policy-compliant receipts. Thumper verifies the adapter signature before
  accepting a Railgun settlement.
- Public HTTP infrastructure can still observe traffic timing and source IP
  unless an additional relay/OHTTP/Tor-like network path is used.

## Operational Checks

- `/health/privacy` reports privacy guardrails and private payment policy.
- `/health/payments` reports which shielded rails are configured and ready.
- `scripts/canary/railgun-adapter-mock-e2e.mjs` exercises the Railgun adapter
  without funds.
- `scripts/canary/railgun-x402-funded-canary.sh` is the live funded canary for
  real Railgun settlement.

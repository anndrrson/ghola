# Coinbase Advanced + Partner Omnibus Private Pilot

This pilot adds Coinbase Advanced as Ghola's first API-key venue and introduces a partner-held pooled omnibus model.

## Modes

- `partner_omnibus`: preferred. A partner-held Coinbase account executes pooled activity. Ghola stores only pool, partner, subledger, allocation, funding, policy, and result commitments. The user does not upload partner credentials.
- `byo_api_key`: fallback. The user pastes a Coinbase Advanced API key name and EC private key locally in the browser. The browser seals it to the attested private-agent recipient and posts only the encrypted bundle to Ghola.

In both modes, Ghola's normal app and operator should not see raw API keys, private keys, portfolio ids, strategy text, prompts, or order payloads. Coinbase will still see the executing Coinbase account and venue activity. In `partner_omnibus`, that should be the partner pool rather than the user's own Coinbase account.

## Public API Surface

- `GET /v1/private-account/venues/coinbase_style_provider/vault`
- `POST /v1/private-account/venues/coinbase_style_provider/vault`
- `POST /v1/private-account/venues/coinbase_style_provider/agent/session`
- `GET /v1/private-account/omnibus/status`
- `POST /v1/private-account/omnibus/allocate`
- `POST /v1/private-account/omnibus/reconcile`

Existing Hyperliquid endpoints remain compatible. The generic venue routes also forward Hyperliquid requests to the existing Hyperliquid handlers.

## Worker Ingress

- `POST /venues/coinbase/sessions`
- `POST /venues/coinbase/orders`
- `POST /venues/coinbase/reconcile`
- `POST /omnibus/allocations`
- `POST /omnibus/reconcile`

Requests must use `x-ghola-sealed-execution-required: true` and contain only commitments, encrypted bundles, and capped policy metadata.

## Live Execution

The private-agent worker opens BYO Coinbase vaults inside the TEE, generates
short-lived ES256 JWTs from the sealed API key name and EC private key, checks
`/key_permissions`, and rejects transfer-enabled keys for v1. It then previews,
creates, cancels, and reconciles Advanced Trade orders through the worker only.

For `partner_omnibus`, partner pool credentials are loaded from
`PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_PATH` or
`PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON` inside the TEE. The worker
reserves the user's allocation in its sealed-volume ledger, places the pooled
venue order, binds the venue client order id to the work-order commitment, and
reconciles fills/fees back to commitment receipts.

Order execution requires an `encrypted_execution_instruction_bundle` unless an
armed sealed strategy session contains a deterministic instruction template.
Instruction AAD format:

```text
ghola/private-execution-instruction-v1|work_order:<commitment>|venue:coinbase_advanced|recipient:<recipient_id>
```

The cockpit can bind to `preview:<preview_commitment>` before the server creates
the connector work order; lower-level connector flows should bind to
`work_order:<work_order_commitment>` when it is already known.

## Coinbase Scope

Supported v1 operations are read, order preview, spot market/limit order, cancel, fills, and reconcile. Withdrawals, transfers, margin, leverage escalation, futures, staking, portfolio mutation, and raw custody movement are blocked by default.

## Required Flags

- `GHOLA_V6_COINBASE_PILOT_ENABLED=true`
- `GHOLA_CONNECTOR_COINBASE_STYLE_PROVIDER_URL=<private-agent-worker-url>`
- `GHOLA_CONNECTOR_COINBASE_STYLE_PROVIDER_TOKEN=<worker-token>`
- `GHOLA_CONNECTOR_COINBASE_STYLE_PROVIDER_READINESS=ready`
- `GHOLA_COINBASE_PARTNER_OMNIBUS_ENABLED=true`
- `GHOLA_COINBASE_PARTNER_OMNIBUS_POOL_READY=true`
- `PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_PATH=<tee-secret-path>` for partner omnibus live execution
- `PRIVATE_AGENT_VENUE_DRY_RUN=false`
- `PRIVATE_AGENT_GLOBAL_KILL_SWITCH=false`

Private-mode execution still requires sealed runtime health, attestation/measurement evidence, shielded funding evidence, and connector readiness.

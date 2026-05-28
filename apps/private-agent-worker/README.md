# Ghola Private Agent Worker

Provider-side session intake for sealed private-agent execution.

The worker is intentionally fail-closed. It accepts only encrypted strategy
bundles, requires a provider bearer token when configured, publishes the
recipient key that the browser seals to, and refuses sessions until attestation
metadata is present unless `PRIVATE_AGENT_ALLOW_UNATTESTED_DEV=true` is set for
local testing.

## Endpoints

- `GET /health`
- `GET /ready`
- `GET /.well-known/private-agent-recipient`
- `POST /private-agent/sessions`
- `POST /hyperliquid/sessions`
- `POST /hyperliquid/orders`
- `POST /hyperliquid/reconcile`
- `POST /venues/coinbase/sessions`
- `POST /venues/coinbase/orders`
- `POST /venues/coinbase/reconcile`
- `POST /omnibus/allocations`
- `POST /omnibus/reconcile`

The Hyperliquid endpoints are for the v1 private execution pilot. They accept
only commitments plus encrypted execution vault/strategy bundles. Plaintext
Hyperliquid account IDs, API secrets, prompts, strategy text, policies, and raw
order payloads are rejected recursively. V1 hides this material from the normal
Ghola app/operator, but Hyperliquid still sees the execution account and order
activity.

Live execution is performed only inside this worker. The worker opens
`sealed-provider-v1` vaults/instructions with its attestation-bound X25519 key,
enforces capped session policy, signs venue requests, and returns redacted
commitment receipts. Order endpoints require either an
`encrypted_execution_instruction_bundle` or an armed sealed strategy session
with a deterministic instruction template; freeform prompts are not converted
into orders. Instruction bundles may bind to `work_order:<commitment>` or, for
the cockpit flow before work-order creation, `preview:<preview_commitment>`.

## Required production env

- `PRIVATE_AGENT_EXECUTION_TOKEN`
- `PRIVATE_AGENT_PROVIDER_ID=phala`
- `PRIVATE_AGENT_TEE_KIND=phala`
- `PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE=true`
- `PHALA_CVM_IMAGE_DIGEST`
- `PRIVATE_AGENT_GLOBAL_KILL_SWITCH=false`
- `PRIVATE_AGENT_VENUE_DRY_RUN=false`
- `PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE=60`
- `PRIVATE_AGENT_MIN_ORDER_NOTIONAL_USD=0`
- `PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET=false`
- `PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE=disabled`
- `PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD=5`
- `PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD=25`
- `PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS=50`
- `PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON` or
  `PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_PATH` for managed testnet
  allocations
- `PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_PATH` or
  `PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON` for partner omnibus
- `PRIVATE_AGENT_HYPERLIQUID_TIMEOUT_MS=12000`

When `PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE=true`, the worker requests a dstack
quote over `/var/run/dstack.sock` with report data derived from the published
recipient id and X25519 public key. `GET /.well-known/private-agent-recipient`
then exposes the quote hash and report-data binding so Ghola can refuse payload
forwarding unless the recipient key is tied to attested runtime evidence.

Static `PRIVATE_AGENT_ATTESTED_READY=true`, `PHALA_CVM_MEASUREMENT_HEX`, and
`PHALA_ATTESTATION_HASH` are still supported for manually verified deployments,
but JIT Phala deployments should prefer the dstack quote path.

If `PRIVATE_AGENT_X25519_PUB_HEX` and `PRIVATE_AGENT_RECIPIENT_ID` are not set,
the worker generates and persists an X25519 recipient key in
`PRIVATE_AGENT_DATA_DIR`, default `/data`. In production this directory must be
sealed CVM storage or replaced by an attestation-bound key service.

If `PRIVATE_AGENT_X25519_PUB_HEX` is configured manually, also configure
`PRIVATE_AGENT_X25519_SECRET_HEX` or `PRIVATE_AGENT_X25519_PRIVATE_KEY_PKCS8_PEM`;
otherwise the worker can publish a recipient but cannot open sealed vaults.

## Local test

```bash
npm test
PRIVATE_AGENT_ALLOW_UNATTESTED_DEV=true PRIVATE_AGENT_EXECUTION_TOKEN=dev npm start
```

## Hyperliquid testnet pilot

The worker is testnet-only unless `PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET=true`
is explicitly set. Managed allocations use worker-local testnet API wallets:

Mainnet submit remains blocked unless
`PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE=tiny_fill`. In that mode the only live
submit path is a quote-sized Hyperliquid IOC tiny fill with worker-side
notional, daily cap, and slippage checks. Raw base-size/limit-price mainnet
submits are not accepted by the live pilot.

```json
[
  {
    "network": "testnet",
    "account_address": "0x...",
    "api_wallet_private_key": "0x...",
    "agent_name": "ghola-testnet-1"
  }
]
```

`POST /hyperliquid/managed/allocations` returns only allocation commitments.
Orders can use either an encrypted BYO vault or a managed allocation
commitment, never both.

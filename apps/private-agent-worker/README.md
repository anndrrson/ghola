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
- `POST /hyperliquid/account-stream`
- `POST /hyperliquid/orders`
- `POST /hyperliquid/verify`
- `POST /hyperliquid/reconcile`
- `POST /venues/coinbase/sessions`
- `POST /venues/coinbase/orders`
- `POST /venues/coinbase/reconcile`
- `POST /venues/solana-perps/orders`
- `POST /venues/solana-perps/verify`
- `POST /venues/solana-perps/reconcile`
- `POST /venues/solana-swap/orders`
- `POST /venues/solana-swap/verify`
- `POST /venues/solana-swap/reconcile`
- `POST /omnibus/allocations`
- `POST /omnibus/reconcile`
- `POST /autopilot/sessions`
- `GET /autopilot/sessions/:id`
- `GET /autopilot/sessions/:id/events`
- `GET /autopilot/sessions/:id/decisions`
- `GET /autopilot/sessions/:id/positions`
- `POST /autopilot/sessions/:id/pause`
- `POST /autopilot/sessions/:id/resume`
- `POST /autopilot/sessions/:id/kill`
- `POST /execution/cross-venue/submit`
- `POST /execution/cross-venue/cancel`
- `POST /execution/cross-venue/ready`

The cross-venue endpoints accept exactly two opposite IOC legs with one durable
execution id and explicit unhedged-notional, hedge-time, slippage, unwind-loss,
and daily-loss budgets. The coordinator preflights both legs, submits them
concurrently, measures residual exposure, then invokes the configured hedge or
unwind adapter and posts monotonic reports to Ghola. It deliberately returns
`cross_venue_byo_adapter_unavailable` unless all preflight, submit, hedge,
unwind, and cancel controls are installed; the presence of the HTTP endpoint
alone never makes cross-venue live trading ready.

The Hyperliquid endpoints are for the v1 private execution pilot. They accept
only commitments plus encrypted execution vault/strategy bundles. Plaintext
Hyperliquid account IDs, API secrets, prompts, strategy text, policies, and raw
order payloads are rejected recursively. V1 hides this material from the normal
Ghola app/operator, but Hyperliquid still sees the execution account and order
activity.

The Solana perps endpoints are the Phoenix/Drift/Backpack-style venue pilot
surface. They accept commitment-only work orders plus sealed instruction
bundles, reject raw Solana secrets and raw order payloads, and return
commitment receipts that distinguish main-wallet exposure from venue-visible
account/order activity. Live submit is disabled unless
`PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE=sdk_runner` and
`PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET=true` are configured. The current live
path uses the official Phoenix Rise SDK to submit capped `tiny_fill` IOC orders
from a sealed Phoenix trader-authority vault.

`POST /venues/solana-perps/verify` is the production no-funds verification
lane. It requires `x-ghola-no-submit-verify: true`, opens the same sealed
Phoenix vault and instruction bundles as live submit, checks the live gates,
RPC reachability, Phoenix SDK readiness, and order-packet construction, and
returns `verified_no_funds` without broadcasting a transaction.

The Solana swap endpoints are the Jupiter private swap pilot. They use the
same sealed connector SDK shape, support Jupiter Swap V2 Meta-Aggregator and
Router routing modes, enforce configured input/output mint allowlists, and
return pre-broadcast or final proof objects without exposing raw mints, keys, or
transactions in normal Ghola receipts.

Live execution is performed only inside this worker. The worker opens
`sealed-provider-v1` vaults/instructions with its attestation-bound X25519 key,
enforces capped session policy, signs venue requests, and returns redacted
commitment receipts. Order endpoints require either an
`encrypted_execution_instruction_bundle` or an armed sealed strategy session
with a deterministic instruction template; freeform prompts are not converted
into orders. Instruction bundles may bind to `work_order:<commitment>` or, for
the cockpit flow before work-order creation, `preview:<preview_commitment>`.

Autopilot sessions can run in AI-direct mode when the session policy sets
`ai_direct_enabled=true` and the worker has `PRIVATE_AGENT_AI_DIRECT_ENABLED=true`.
The AI model returns only a structured decision object. The worker records the
decision, validates schema, confidence, venue readiness, market allowlists,
operation class, notional caps, daily caps, position caps, and slippage, then
builds the private venue instruction itself. Raw model text, prompts, raw venue
payloads, credentials, and wallet material are never accepted as executable
orders.

## Required production env

- `PRIVATE_AGENT_EXECUTION_TOKEN`
- `PRIVATE_AGENT_WORKER_CAPABILITY_SECRET`
- `PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY=true`
- `PRIVATE_AGENT_PROVIDER_ID=phala`
- `PRIVATE_AGENT_TEE_KIND=phala`
- `PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE=true`
- `PHALA_CVM_IMAGE_DIGEST`
- `PRIVATE_AGENT_FUNDING_SIGNING_KEY` as base64 PKCS8 Ed25519 private key
- `PRIVATE_AGENT_GLOBAL_KILL_SWITCH=false`
- `PRIVATE_AGENT_VENUE_DRY_RUN=false`
- `PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT=false` until production venue vaults are funded
- `PRIVATE_AGENT_AUTOPILOT_TICK_MS=30000`
- `PRIVATE_AGENT_AI_DIRECT_ENABLED=false` until model and venue live gates are ready
- `PRIVATE_AGENT_AI_MODEL` or `GHOLA_PRIVATE_AGENT_AI_MODEL`
- `PRIVATE_AGENT_AI_MAX_DECISIONS_PER_HOUR=12`
- `PRIVATE_AGENT_STATE_STORE=postgres`
- `PRIVATE_AGENT_STATE_POSTGRES_URL` or `DATABASE_URL`
- `PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE=60`
- `PRIVATE_AGENT_MIN_ORDER_NOTIONAL_USD=0`
- `PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET=false`
- `PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE=disabled`
- `PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD=50`
- `PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD=250`
- `PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS=50`
- `PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD=1000` and
  `PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD=5000` for
  full-ticket launch mode
- `PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON` or
  `PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_PATH` for managed testnet
  allocations
- `PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_PATH` or
  `PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON` for partner omnibus
- `PRIVATE_AGENT_COINBASE_LIVE_MODE=disabled`, or `full` for explicit live
  Coinbase submit after funding and key-permission checks
- `PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS` and
  `PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD=1000` for full-ticket launch
- `PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE=full_ticket` for Phoenix full-ticket
  live launch, `sdk_runner` for legacy tiny-fill canaries, otherwise `disabled`
- `PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET=true` for Phoenix live,
  otherwise `false`
- `PRIVATE_AGENT_SOLANA_PERPS_LIVE_MAX_NOTIONAL_USD=50`
- `PRIVATE_AGENT_SOLANA_PERPS_FULL_TICKET_MAX_NOTIONAL_USD=1000`
- `PRIVATE_AGENT_SOLANA_PERPS_MAX_SLIPPAGE_BPS=100`
- `PRIVATE_AGENT_SOLANA_RPC_URL`
- `PRIVATE_AGENT_JUPITER_LIVE_MODE=disabled`, or `full` for the live pilot
- `PRIVATE_AGENT_JUPITER_API_KEY` for live Jupiter Swap API calls
- `PRIVATE_AGENT_JUPITER_ALLOWED_INPUT_MINTS` and
  `PRIVATE_AGENT_JUPITER_ALLOWED_OUTPUT_MINTS`, comma-separated mainnet mints
- `PRIVATE_AGENT_JUPITER_MAX_SLIPPAGE_BPS=100`
- `PRIVATE_AGENT_JUPITER_LIVE_MAX_NOTIONAL_USD=1000`
- `PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON` or
  `PRIVATE_AGENT_JUPITER_POOLED_VAULT_PATH` for Ghola Vault Mode
- `PRIVATE_AGENT_HYPERLIQUID_TIMEOUT_MS=12000`
- `GHOLA_CROSS_VENUE_RECONCILIATION_URL`, pointing to Ghola's authenticated
  `/api/internal/cross-venue-reconciliation` endpoint
- `GHOLA_RECONCILIATION_INGEST_TOKEN`, shared only with that callback endpoint

When `PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE=true`, the worker requests a dstack
quote over `/var/run/dstack.sock` with report data derived from the published
recipient id, X25519 public key, and funding-attestation signer. `GET
/.well-known/private-agent-recipient` then exposes the quote hash,
funding signer public key, and report-data binding so Ghola can refuse payload
forwarding unless the recipient and funding signer are tied to attested runtime
evidence.

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

Worker execution state defaults to the existing JSON file under
`PRIVATE_AGENT_DATA_DIR`. Set `PRIVATE_AGENT_STATE_STORE=postgres` with
`PRIVATE_AGENT_STATE_POSTGRES_URL` or `DATABASE_URL` to use the shared
Postgres/Neon state store for multi-worker deployments. Postgres uses dedicated
row-level tables for sessions, idempotency, policy counters, capability JTIs,
autopilot records, and omnibus state so concurrent agents do not overwrite a
single shared document. Existing legacy Postgres document state is migrated on
startup when present. `PRIVATE_AGENT_STATE_STORE=sqlite` remains available for a
single persistent worker; override its path with `PRIVATE_AGENT_STATE_SQLITE_PATH`.

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

`POST /hyperliquid/verify` is the no-submit readiness path. It requires
`x-ghola-no-submit-verify: true`, opens the sealed execution vault and sealed
instruction, enforces the same live/policy gates as submit, checks the
Hyperliquid SDK plus market/account reads, builds the capped IOC order request,
and returns a commitment-only certificate with `transaction_broadcast: false`.
It does not prove final venue acceptance or a fill; that still requires an
explicit canary submit.

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

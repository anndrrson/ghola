# Attested Worker Deploy Runbook

Public live trading requires a Phala-attested worker. Unattested development workers are never launch
eligible.

## Build identity

Build one immutable image from the same commit as the web release. Record:

- `PRIVATE_AGENT_BUILD_GIT_SHA`
- `PRIVATE_AGENT_IMAGE_DIGEST` and `PHALA_CVM_IMAGE_DIGEST`
- `GHOLA_WEB_GIT_SHA` and `GHOLA_PRIVATE_AGENT_WORKER_GIT_SHA` on the web
- `GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST` on the web

The two SHAs must match. The digest must match the deployed image and recipient metadata.

## Worker contract

Generate the env file with `scripts/build-phala-worker-env.mjs`. Live mode fails generation unless
these values are exact:

```text
PRIVATE_AGENT_STATE_STORE=postgres
PRIVATE_AGENT_STATE_POSTGRES_URL=<durable database>
PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE=true
PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY=true
PRIVATE_AGENT_VENUE_DRY_RUN=false
PRIVATE_AGENT_GLOBAL_KILL_SWITCH=false
PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET=true
PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE=full_ticket
PRIVATE_AGENT_HYPERLIQUID_MAINNET_PROOF_ENABLED=true
PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD=100
PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD=500
PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS=100
PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD=100
PRIVATE_AGENT_LIVE_DAILY_NOTIONAL_CAP_USD=500
PRIVATE_AGENT_HYPERLIQUID_RISK_REDUCTION_ENABLED=true
PRIVATE_AGENT_LIVE_TRADING_CAPABILITIES=limit_order,cancel,reduce_only
PRIVATE_AGENT_BUILD_GIT_SHA=<release SHA>
PRIVATE_AGENT_IMAGE_DIGEST=sha256:<image digest>
GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64=<funding signer SPKI public key>
```

The env builder verifies that the pinned public key matches `PRIVATE_AGENT_FUNDING_SIGNING_KEY`.
Also configure strong execution/capability secrets and rate limits. Never set legacy
`GHOLA_HYPERLIQUID_LIVE_MODE`.

## Web contract

```text
GHOLA_LIVE_TRADING_PUBLIC_ENABLED=true
PRIVATE_AGENT_HYPERLIQUID_RISK_REDUCTION_ENABLED=true
GHOLA_LIVE_TRADING_PUBLIC_CAPABILITIES=limit_order,cancel,reduce_only
GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD=100
GHOLA_LIVE_TRADING_DAILY_CAP_USD=500
GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS=100
GHOLA_V6_HYPERLIQUID_PILOT_ENABLED=true
GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET=<strong secret>
GHOLA_LIVE_TRADING_CONTROL_TOKEN=<strong operator secret>
GHOLA_PRIVATE_AGENT_EXECUTION_URL=https://<worker>
GHOLA_PRIVATE_AGENT_SPEND_ARMED=true
GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED=false
GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN=false
GHOLA_HYPERLIQUID_ACCOUNT_PROOF_ENABLED=true
NEXT_PUBLIC_GHOLA_HYPERLIQUID_ACCOUNT_PROOF_ENABLED=true
PRIVATE_AGENT_STATE_STORE=postgres
PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE=true
PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY=true
PRIVATE_AGENT_GLOBAL_KILL_SWITCH=false
PRIVATE_AGENT_HYPERLIQUID_MAINNET_PROOF_ENABLED=true
PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD=100
PRIVATE_AGENT_LIVE_DAILY_NOTIONAL_CAP_USD=500
GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64=<same pinned public key>
```

Mirror every worker contract value and release identity field on the web. Keep public launch state
disabled until the operator starts the canary; the proof UI remains required for each new account's
$10.50 graduation.

## Checks

1. `GET <worker>/ready`: overall and `live_trading.ready` are true; SHA, digest, fingerprint, caps,
   and `limit_order` match the web.
2. `GET <worker>/.well-known/private-agent-recipient`: `attested_ready=true`; image digest and
   report-data binding match.
3. `GET /api/health/ready`: `checks.byo_hyperliquid=ready` only after public activation and proofs.
4. `GET /api/internal/live-trading/launch`: inspect exact durable state and proof counts.
5. Restart the worker and web; confirm state, idempotency receipts, and kill state persist.

## Canary and rollback

Set durable state to `canary`. Each proof spends real user funds and needs separate authorization.
Three distinct eligible accounts must pass before public activation; repeated proofs from one account
do not count toward the launch threshold. The durable gate deduplicates the validated Hyperliquid
account commitment from independent venue evidence, not Ghola account, vault, or API-wallet identifiers.

For any mismatch or incident, set durable state to `killed`, set the worker global kill switch, and
roll back the exact image. Risk-reducing orders remain available through their separate server gate.

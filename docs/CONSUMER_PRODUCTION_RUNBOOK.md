# Consumer Production Runbook

This runbook covers consumer-only real-money trading. Enterprise availability is not part of this release.

## Severity and ownership

- P0: duplicate order or settlement, negative balance, unexplained custody drift, unauthorized withdrawal, leaked signing material, or inability to halt trading. Page the primary and secondary on-call immediately.
- P1: worker attestation loss, venue outage, reconciliation older than 60 seconds, failed withdrawal, or error rate at least 5% for five minutes. Page the primary on-call.
- P2: isolated rejected order, delayed wake, or customer-facing display defect. Route to `support@ghola.xyz`.

Never request or place API secrets, seed phrases, wallet private keys, sealed payloads, or exact balances in tickets, chat, logs, or Sentry.

## Required production configuration

Keep `GHOLA_CONSUMER_ROLLOUT_PERCENT=0` until all items below are present and verified. A missing item makes deep readiness fail closed.

- Vercel Pro, `SENTRY_DSN`, Analytics, Speed Insights, a log drain, synthetic checks, and P0 paging.
- `GHOLA_CONSUMER_SOLANA_RPC_URL`, `GHOLA_CONSUMER_SOLANA_USDC_TREASURY_RECIPIENT`, and the expected mainnet USDC mint.
- `GHOLA_CONSUMER_STEP_UP_VERIFY_URL`, `GHOLA_TRADING_CONTROL_TOKEN`, and `GHOLA_RECONCILIATION_INGEST_TOKEN`.
- `GHOLA_CONSUMER_WITHDRAWAL_DISPATCH_URL` and `GHOLA_CONSUMER_WITHDRAWAL_DISPATCH_TOKEN` connected to the dedicated treasury signer.
- Shielded verifier, prover, indexer, relayer, and `GHOLA_CONSUMER_SHIELDED_DEPOSIT_DESTINATION_COMMITMENT`.
- `GHOLA_CONSUMER_CANARY_COMMITMENTS` containing only dedicated auth, Hyperliquid, Phoenix, public-USDC, and shielded-rail canary accounts.
- A fresh `GHOLA_CONSUMER_FUNDED_CANARY_EVIDENCE` JSON record covering deposit and withdrawal on both rails plus exact Hyperliquid and Phoenix reconciliation.

## Bounded Vercel Pro cost

Use a dedicated Vercel team containing only the `web` project and `ghola.xyz`. Do not upgrade the current shared team: Spend Management pauses every production deployment in the team, so unrelated projects must not share Ghola's billing boundary.

- Keep one paid owner seat. Set `GHOLA_VERCEL_PRO_TEAM_SLUG` to this dedicated team in GitHub Actions.
- Set Spend Management extra metered spend to no more than `$5` per billing cycle, enable email/web/SMS notifications, enable **pause all production deployments**, and point the external webhook to the Phala worker's `/consumer/vercel-spend-webhook` endpoint.
- Store the displayed webhook secret only as `PRIVATE_AGENT_VERCEL_SPEND_WEBHOOK_SECRET` in the worker. The endpoint verifies Vercel's HMAC-SHA1 signature and halts pooled trading at the 100% threshold before Vercel can disappear.
- Set GitHub variable `GHOLA_VERCEL_EXTRA_SPEND_CAP_USD=5`. The release workflow refuses a higher value. This is an operational invariant; the Vercel dashboard remains the billing source of truth.
- Avoid Marketplace integrations, extra seats, and add-ons in this team because Spend Management does not include them. The cap also is not exact: Vercel evaluates usage every few minutes.

Vercel may pause without affecting custody. The Phala worker owns durable reconciliation, withdrawal dispatch/finality verification, and the circuit breaker. Never put those loops back into Vercel Functions.

Do not store any canary private key, API credential, signer key, or proof secret in repository variables, workflow output, build arguments, or preview logs.

## Immediate halt

Use the rotated `GHOLA_TRADING_CONTROL_TOKEN` from the production secret manager:

```bash
curl -fsS -X POST https://ghola.xyz/api/internal/trading-circuit \
  -H "authorization: Bearer $GHOLA_TRADING_CONTROL_TOKEN" \
  -H "content-type: application/json" \
  -d '{"action":"halt","acknowledged_by":"oncall-incident-id"}'
```

Confirm that `/v1/private-account/trading/status` reports `halted`. Halting prevents new pooled reservations; do not stop the worker while reservations, orders, positions requiring management, reconciliation, or withdrawals remain active.

## Investigation order

1. Preserve the incident timestamp and commitment IDs; do not copy secrets.
2. Check Sentry, Vercel runtime logs, the production log drain, and `/api/health/ready`.
3. Compare immutable consumer ledger transactions, active reservations, venue orders/fills, and treasury balances.
4. Classify any delta as expected finality delay, venue fee/P&L, missing fill, duplicate settlement, or unexplained drift.
5. Keep the circuit halted for any unexplained delta, stale market data, missing attestation, or unavailable venue.
6. For suspected credential compromise, revoke the venue API wallet/authority and rotate execution, provision, funding, trading-control, Vercel, and monitoring credentials.

## Resume

Resume requires zero unexplained reconciliation drift, two consecutive green funded canaries, healthy attestation and venue checks, and an accountable on-call acknowledgement:

```bash
curl -fsS -X POST https://ghola.xyz/api/internal/trading-circuit \
  -H "authorization: Bearer $GHOLA_TRADING_CONTROL_TOKEN" \
  -H "content-type: application/json" \
  -d '{"action":"resume","acknowledged_by":"oncall-incident-id","reconciliation_drift_micro_usdc":0,"consecutive_green_canaries":2}'
```

Record the evidence commitments and deployment ID in the incident timeline.

## Balance correction

Never edit or delete ledger history. Corrections are new, balanced `operator_adjustment` transactions with an incident reference, two-person review, and before/after reconciliation evidence. Customer communication must state the affected commitment IDs, not internal wallet or treasury identifiers.

Submit an approved correction to `/api/internal/consumer-balance-adjustments` with the trading-control bearer token. The request must name two distinct reviewers, the committed consumer/account IDs, a signed micro-USDC delta, and a unique incident reference. A correction that would make available balance negative is rejected atomically.

## Deployment and rollback

- Build one immutable Vercel preview artifact, run tests and protected checks against that artifact, then promote it without rebuilding.
- After promotion, scan production errors and execute the no-submit synthetic suite.
- Roll back the production alias if application behavior regresses. Database changes in this release are additive; do not drop tables during rollback.
- A rollback does not automatically resume a halted circuit.

## Rollout gates

- Internal: funded public-USDC deposit/order/reconciliation/withdrawal, shielded deposit/order/reconciliation/withdrawal, $5 Hyperliquid IOC fill-or-clean-cancel, and minimum Phoenix spot order.
- 5% for 24 hours: zero P0/P1, zero unexplained drift, no duplicates, wake success at least 99% with p95 below 90 seconds.
- 25% for 48 hours: same gates plus API availability at least 99.9% and reconciliation within 60 seconds at least 99%.
- 100%: a protected production approval and a fresh signed canary evidence bundle are mandatory.

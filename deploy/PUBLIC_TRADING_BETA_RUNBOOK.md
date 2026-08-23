# Ghola public trading beta runbook

Scope: a capped, non-custodial Hyperliquid mainnet beta using user-owned, trade-only API wallets. Withdrawals, transfers, automatic retries, and unrestricted public notional are out of scope.

## Launch contract

- Public order cap: at most $50.
- Public daily cap: at most $250.
- Slippage cap: at most 100 bps.
- First-order policy: $5 until a reconciled receipt exists.
- Every entry is separately reviewed and protected by native reduce-only triggers when requested.
- Ambiguous submissions are locked and reconciled by client-order ID; they are never resubmitted.
- Closes use the exact reconciled fill size and are reduce-only.
- A completed round trip must finish with zero positions and zero open orders.
- Ghola accepts only scoped trading authority. Withdrawal and transfer authority are forbidden.

## Required production controls

The `/v1/private-account/launch/status` response must report every check as `ready`, including:

- public beta and public-live flags;
- strong request-proof secret in enforced mode;
- explicit inactive global kill switch;
- $50/$250/100-bps caps;
- persistent private-account storage;
- attested worker, sealed recipient, connector URL, and token;
- production monitoring plus an alert webhook, Sentry, a configured Vercel log drain, or verified Vercel Web/Email/Push alerts;
- rollback and this runbook acknowledged in environment configuration.

The environment acknowledgment values are:

```text
GHOLA_PUBLIC_BETA_MONITORING_ENABLED=true
GHOLA_VERCEL_ALERTS_CONFIGURED=true
GHOLA_PUBLIC_BETA_ROLLBACK_READY=true
GHOLA_PUBLIC_BETA_RUNBOOK_VERSION=2026-08-23
```

## Pre-promotion gate

Run from `apps/web`:

```bash
npm run test
npm run lint
npx tsc --noEmit
npm run build
GHOLA_VERIFY_BASE_URL=<candidate> GHOLA_VERIFY_REQUIRE_PUBLIC_LIVE=true npm run verify:live:all
npm run verify:release-evidence
```

Also require:

1. Candidate deployment is `READY` and bound to the intended commit.
2. Runtime logs show no unexplained 5xx, timeouts, or ambiguous-submit spikes.
3. Signed-out and signed-in nonfinancial browser flows pass twice without refreshing.
4. The committed proof at `deploy/evidence/hyperliquid-mainnet-proof-2026-08-23.json` verifies.
5. The current production deployment URL is recorded as the rollback target.

Do not perform another live financial proof without fresh explicit authorization.

## Promotion

Promote the exact verified artifact; do not rebuild it:

```bash
vercel promote <verified-candidate-url>
```

Immediately run signed-out and signed-in no-submit smoke checks. Confirm the public domain, support, terms, trade page, launch status, authentication, scoped-wallet setup, market data, and no-submit verification.

## Monitoring

- Treat `connector_submit_ambiguous`, final non-flat state, an unprotected entry, request-proof failure, or worker 5xx as actionable incidents.
- Correlate web and worker logs using `x-ghola-correlation-id` / `x-ghola-request-id`.
- Keep secrets, wallet material, raw order payloads, and strategies out of logs and alerts.
- Scan production runtime errors immediately after promotion and again after 15 minutes.

## Stop and rollback

Set `PRIVATE_AGENT_GLOBAL_KILL_SWITCH=true` first when new risk-increasing orders must stop. Recovery reads, reconciliation, cancellation, and reduce-only exits remain allowed.

Rollback when any safety-critical gate is red, the production artifact differs from the verified candidate, authentication or scoped-wallet setup regresses, submissions become ambiguous without reconciliation, or final flat/clear verification fails.

```bash
vercel rollback <recorded-production-deployment-url>
```

After rollback, verify the domain points to the recorded artifact, the launch gate is red or intentionally disabled, and no user account has an unexpected position or order. Preserve correlation IDs and public venue evidence for the incident review.

## User support and incident handling

- Trading incidents and security reports: `privacy@ghola.xyz` (the currently published support mailbox).
- Never request private keys, API-wallet secrets, seed phrases, or one-time codes.
- Ask for approximate time, market, public client-order ID, and Ghola correlation ID only.

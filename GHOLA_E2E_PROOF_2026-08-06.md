# Ghola Hyperliquid end-to-end proof

Date: 2026-08-06  
Status: **NOT PROVEN END TO END**

## Production observations

- `ghola.xyz/trade` loaded in an existing authenticated Chrome session.
- `/signup` returned HTTP 200, but no account was created and the isolated signed-out browser was unavailable.
- Hyperliquid/mainnet was selected; the account showed `credentials required` and `Connect Hyperliquid mainnet`.
- No credential, checkout, signup, or order control was submitted.
- Public Hyperliquid market data was live and non-stale.
- The chart rendered live Coinbase BTC-USD data, not venue-matched Hyperliquid data.
- `/founding` returned 404; Settings exposed Free, Pro, Private Agents, Unlimited, and Enterprise plans, but no Founding Trader checkout.
- `/api/billing/founding-cohort` reported capacity 10, claimed 0, remaining 10, and checkout open.
- Ten concurrent GETs all returned HTTP 200 and satisfied `claimed + remaining = 10`; no checkout or reservation was created.
- `/api/private-agent/status` reported `remote_execution_ready=false`; no attested provider was selected. The configured Phala CVM was stopped and lacked recipient/report-data binding.

## Deployment provenance

- Current production deployment: `dpl_3vDWBTMwS12x2boMmB4w3f3d87Y4`.
- It was created by CLI without Git metadata; an exact Git commit cannot be attributed.
- The downloaded 609-file web source is preserved locally as commit `f204e865`.
- It is a dirty snapshot closest to the reviewed chart branch, not a clean repository commit.
- It omitted reviewed founding checkout, billing/admission helpers, funding preflight, runtime status, worker-shard, connector, and chart tests/wiring.

## Automated proof

- Exact production-source targeted tests: 90 passed.
- Exact production-source auth tests: 9 passed.
- Six focused signup/session tests passed, covering same-origin protection, cookie-backed routing, upstream failure handling, and backend-verified identity.
- Restored production-based candidate: 133 files and 707 tests passed.
- Confidential worker: 140 tests passed; the 35 focused Hyperliquid/policy tests passed.
- Worker tests prove sealed-only ingress, entitlement gates, venue-result classification, collateral handling, position refresh, and reduce-only policy with mocked venue responses—not a live fill.
- A disposable local PostgreSQL 16 database proved 11 concurrent founding reservations admit exactly 10 and reject the eleventh.
- The database-backed signed-webhook test proved idempotent, ordered paid-entitlement activation and restoration.
- Credential reload/isolation tests passed against a private-Blob adapter; they do not prove production persistence.
- Lint: 0 errors, 20 pre-existing warnings.
- Production build passed, including auth client-bundle and SRI checks.
- Candidate commit: `ef8d2ccb` on `codex/production-e2e-proof-20260806`.
- Candidate was not deployed.

## Safety incident

- A local production environment file was unintentionally printed during inspection.
- Its credentials must be treated as compromised and rotated before deployment or trading verification.
- No exposed value was reused or repeated, and no credential was rotated without authorization.

## Not proven

- New-user signup and authenticated session creation.
- Paid entitlement, real checkout, and atomic admission into the ten-seat cohort.
- Scoped Hyperliquid trading-only API-wallet connection without secret disclosure.
- Durable credential detection after reload and deployment.
- Account-, network-, worker-, market-, and collateral-specific live readiness.
- Venue-authoritative order acceptance, fill, position, reduce-only close, and final flat state.

## Required completion sequence

1. Rotate all exposed production credentials and redeploy safely.
2. Deploy the reviewed candidate with a traceable Git SHA.
3. Start and attest the confidential worker; verify exact recipient, image, signer, and report-data bindings.
4. Use an authorized new test user to prove signup, paid entitlement, and one of ten admissions.
5. Connect an authorized scoped Hyperliquid API wallet; verify secret-free persistence across reload and deployment.
6. Confirm venue/account/network/worker/market/collateral readiness from authenticated production APIs.
7. Obtain fresh authorization stating account, BTC side, exact size/notional cap, order type, limit/slippage, and maximum loss.
8. Submit one bounded opening order; retain venue order/fill IDs and reconcile the exact position.
9. Submit an exact reduce-only close; confirm the venue reports no residual position or open order.

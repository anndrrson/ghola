# Ghola Hyperliquid end-to-end proof

Date: 2026-08-06  
Status: **NOT PROVEN END TO END**

## Production observations

- `ghola.xyz/trade` loaded in a temporary tab in the user's existing Chrome profile. After asynchronous session verification, it showed `credentials required`, proving the current browser identity is admitted to the trade page but has no connected Hyperliquid credential.
- `/signup` returned HTTP 200, but no account was created and the isolated signed-out browser was unavailable.
- Hyperliquid/mainnet was selected; the account showed `credentials required` and `Connect Hyperliquid mainnet`.
- No credential, checkout, signup, or order control was submitted.
- Public Hyperliquid market data was live and non-stale.
- The chart rendered live Coinbase BTC-USD data, not venue-matched Hyperliquid data.
- `/founding` returned 404; Settings exposed Free, Pro, Private Agents, Unlimited, and Enterprise plans, but no Founding Trader checkout.
- The production `Connect Hyperliquid` dialog incorrectly linked to `/account` with both `setup=coinbase_advanced` and `venue=coinbase_advanced`; this prevents the visible Hyperliquid onboarding action from reaching its verifier.
- `/api/billing/founding-cohort` reported capacity 10, claimed 0, remaining 10, and checkout open.
- Ten concurrent GETs all returned HTTP 200 and satisfied `claimed + remaining = 10`; no checkout or reservation was created.
- A fresh `/api/private-agent/status` read reported `remote_execution_ready=false`, no selected provider, and `no_attested_confidential_compute_provider`. The configured Phala CVM was previously observed stopped and lacking recipient/report-data binding.

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
- Restored production-based candidate: 134 test files and 714 tests passed; one opt-in PostgreSQL file/test is skipped in the ordinary suite and run separately against a disposable database.
- Ghola Cloud backend: 136 tests passed.
- Founding page tests prove the exact ten-seat display, logged-out signup redirect, and sold-out suppression.
- Confidential worker: 147 tests passed; focused Hyperliquid/policy tests passed.
- Browser and worker validation now independently reject a private key whose signer equals the master Hyperliquid account; withdrawals, vault transfers, and leverage escalation remain blocked.
- Worker tests prove sealed-only ingress, entitlement gates, venue-result classification, collateral handling, position refresh, and reduce-only policy with mocked venue responses—not a live fill.
- Candidate close controls seal an explicit exact-close marker without a user-supplied size. The worker derives the full base size, validates the requested reducing side against live venue position state, uses reduce-only IOC, and reports flat-position proof only after a post-order venue account read.
- A venue-proven close fill and a venue-proven flat account are kept as separate evidence states; residual or unavailable state cannot be labeled flat.
- A disposable local PostgreSQL 16 database proved 11 concurrent founding reservations admit exactly 10 and reject the eleventh.
- The database-backed signed-webhook test proved idempotent, ordered paid-entitlement activation and restoration.
- A disposable PostgreSQL 16 database proved the actual backend lifecycle for a new email user: signup issued a verified free-tier JWT; the same subject returned 10 available seats; a correctly signed paid-checkout webhook activated `founding_trader` and changed capacity to 1 claimed/9 remaining; re-signin preserved the user ID and returned the paid tier. Cleanup left zero users and zero seats.
- The web admission boundary forwards that same bearer identity to billing, admits `founding_trader`, and denies `free` with `subscription_required`.
- The candidate canonicalizes perpetual setup to `setup=hyperliquid` and `venue=hyperliquid`; its regression test starts with the production-bug state (`venue=coinbase_advanced`) and proves neither Coinbase value survives in the generated Hyperliquid setup URL.
- Credential reload/isolation tests passed against a private-Blob adapter.
- A disposable PostgreSQL 16.11 database proved sealed mainnet-vault persistence across two separate web test processes: the first wrote one account and one encrypted vault, and the second detected the verified connection from durable state. Both JSONB records were database objects; the public status exposed commitments/readiness but no ciphertext or wallet-key material.
- The persistence audit found and fixed two candidate gaps: ordinary PostgreSQL URLs now use a TCP driver instead of Neon HTTP, and JSONB writes are forced through text to prevent driver-dependent double encoding.
- Lint: 0 errors, 20 pre-existing warnings.
- Production build passed, including auth client-bundle and SRI checks.
- Candidate implementation head: `99586d6f` on `codex/production-e2e-proof-20260806`.
- Candidate was not deployed.

## Safety incident

- A local production environment file was unintentionally printed during inspection.
- Its credentials must be treated as compromised and rotated before deployment or trading verification.
- No exposed value was reused or repeated, and no credential was rotated without authorization.

## Not proven

- Production new-user signup and authenticated session creation.
- Production Stripe checkout, paid entitlement, and atomic admission into the ten-seat cohort. The backend lifecycle and ten-seat invariant are proven only against disposable infrastructure.
- Scoped Hyperliquid trading-only API-wallet connection without secret disclosure.
- Durable credential detection in production after reload and deployment. Cross-process persistence is proven only against disposable infrastructure.
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
